import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import { importPointer } from "./native-config-import-parser.ts";
import { resolveProjectOauthAliasHost } from "./project.ts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UPSTREAM = /^\{\{upstreams (?:http )?([1-9][0-9]{0,4})\}\}$/;
const ROUTE_KEYS = [
  "caddy",
  "caddy.reverse_proxy",
  "caddy.tls",
  "caddy_ingress_network",
];

export type LegacyComposeRoutingIntent = {
  readonly version: 14;
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly openPreference: "auto" | "alias" | "dev";
  readonly openOrigin: string;
  readonly routes: readonly {
    readonly service: string;
    readonly hostname: string;
    readonly port: number;
    readonly origins: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
  }[];
};
type Pointer = {
  readonly document: "config" | "compose";
  readonly source: string;
  readonly target: string;
};

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function host(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.includes(".") &&
    value.split(".").every((part) => LABEL.test(part))
  );
}
function labels(value: unknown): Readonly<Record<string, string>> | undefined {
  const result: Record<string, string> = Object.create(null);
  let entries: unknown[][] = [];
  if (isRecord(value)) {
    entries = Object.entries(value);
  } else if (Array.isArray(value)) {
    entries = value.map((item) =>
      typeof item === "string" && item.includes("=")
        ? [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]
        : []
    );
  }
  if (!entries.length) {
    return undefined;
  }
  for (const entry of entries) {
    const [key, raw] = entry;
    if (
      typeof key !== "string" ||
      typeof raw !== "string" ||
      !ROUTE_KEYS.includes(key) ||
      Object.hasOwn(result, key)
    ) {
      return undefined;
    }
    result[key] = raw;
  }
  return result;
}
function attached(value: unknown, routed: boolean): boolean {
  if (value === undefined) {
    return !routed;
  }
  const expected = routed
    ? [DEFAULT_INGRESS_NETWORK, "default"].sort()
    : ["default"];
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    JSON.stringify([...value].sort()) === JSON.stringify(expected)
  );
}
function network(source: unknown): boolean {
  if (
    !(isRecord(source) && exact(source, [DEFAULT_INGRESS_NETWORK, "default"]))
  ) {
    return false;
  }
  const ingress = source[DEFAULT_INGRESS_NETWORK];
  const local = source.default;
  return (
    isRecord(ingress) &&
    exact(ingress, ["external"]) &&
    ingress.external === true &&
    (!Object.hasOwn(source, "default") ||
      local === null ||
      (isRecord(local) && Object.keys(local).length === 0))
  );
}

/** Closed static route conversion. Literal origins preserve the original host even
 * when it differs from the Compose name. This grants no ingress/resource authority. */
export function mapLegacyComposeRouting(opts: {
  readonly config: Record<string, unknown> | undefined;
  readonly compose: Record<string, unknown> | undefined;
}):
  | {
      readonly intent: LegacyComposeRoutingIntent;
      readonly candidate: Readonly<Record<string, unknown>>;
      readonly pointers: readonly Pointer[];
    }
  | undefined {
  const { config, compose } = opts;
  if (
    !(
      config &&
      compose &&
      host(config.dev_host) &&
      isRecord(compose.services) &&
      network(compose.networks)
    )
  ) {
    return undefined;
  }
  const devHost = config.dev_host;
  let aliasHost: string | null = null;
  if (Object.hasOwn(config, "oauth")) {
    if (
      !(
        isRecord(config.oauth) &&
        exact(config.oauth, ["enabled", "tld"]) &&
        (!Object.hasOwn(config.oauth, "enabled") ||
          typeof config.oauth.enabled === "boolean") &&
        (!Object.hasOwn(config.oauth, "tld") ||
          (typeof config.oauth.tld === "string" &&
            LABEL.test(config.oauth.tld)))
      )
    ) {
      return undefined;
    }
    aliasHost = resolveProjectOauthAliasHost({
      devHost,
      oauth: {
        ...(config.oauth.enabled === true ? { enabled: true } : {}),
        ...(typeof config.oauth.tld === "string"
          ? { tld: config.oauth.tld }
          : {}),
      },
    });
    if (aliasHost !== null && !host(aliasHost)) {
      return undefined;
    }
  }
  let openPreference: "auto" | "alias" | "dev" = "auto";
  if (Object.hasOwn(config, "open")) {
    if (!(isRecord(config.open) && exact(config.open, ["prefer"]))) {
      return undefined;
    }
    if (Object.hasOwn(config.open, "prefer")) {
      const value = config.open.prefer;
      if (value !== "auto" && value !== "alias" && value !== "dev") {
        return undefined;
      }
      openPreference = value;
    }
  }
  if (openPreference === "alias" && aliasHost === null) {
    return undefined;
  }
  const routes: LegacyComposeRoutingIntent["routes"][number][] = [];
  const pointers: Pointer[] = [
    { document: "config", source: "/dev_host", target: "/routes/origin" },
    { document: "compose", source: "/networks", target: "/existing_ingress" },
  ];
  if (Object.hasOwn(config, "oauth")) {
    pointers.push({
      document: "config",
      source: "/oauth",
      target: "/routes/aliases",
    });
  }
  if (Object.hasOwn(config, "open")) {
    pointers.push({ document: "config", source: "/open", target: "/open" });
  }
  const occupied = new Set<string>();
  for (const [service, raw] of Object.entries(compose.services).sort(
    ([a], [b]) => a.localeCompare(b)
  )) {
    if (
      !(isRecord(raw) && LABEL.test(service)) ||
      [
        "build",
        "profiles",
        "depends_on",
        "healthcheck",
        "ports",
        "deploy",
        "configs",
        "secrets",
      ].some((key) => Object.hasOwn(raw, key))
    ) {
      return undefined;
    }
    const selected = Object.hasOwn(raw, "labels")
      ? labels(raw.labels)
      : undefined;
    if (Object.hasOwn(raw, "labels") && !selected) {
      return undefined;
    }
    if (!attached(raw.networks, selected !== undefined)) {
      return undefined;
    }
    const servicePointer = importPointer("/services", service);
    if (Object.hasOwn(raw, "networks")) {
      pointers.push({
        document: "compose",
        source: `${servicePointer}/networks`,
        target: "/existing_ingress/attachments",
      });
    }
    if (!selected) {
      continue;
    }
    const sites = selected.caddy?.split(",").map((site) => site.trim());
    const upstream =
      typeof selected["caddy.reverse_proxy"] === "string"
        ? UPSTREAM.exec(selected["caddy.reverse_proxy"])
        : null;
    const port = Number(upstream?.[1]);
    if (
      !(
        sites?.length &&
        sites.every(host) &&
        new Set(sites).size === sites.length &&
        upstream &&
        port <= 65_535 &&
        selected["caddy.tls"] === "internal" &&
        (!Object.hasOwn(selected, "caddy_ingress_network") ||
          selected.caddy_ingress_network === DEFAULT_INGRESS_NETWORK)
      )
    ) {
      return undefined;
    }
    const primary = sites.find(
      (site) => site === devHost || site.endsWith(`.${devHost}`)
    );
    if (!primary) {
      return undefined;
    }
    const prefix =
      primary === devHost ? "" : primary.slice(0, -(devHost.length + 1));
    // The compiler reserves "project" as its apex sentinel, not a literal prefix.
    if (prefix === "project" || (prefix !== "" && !LABEL.test(prefix))) {
      return undefined;
    }
    const aliases = aliasHost
      ? [prefix ? `${prefix}.${aliasHost}` : aliasHost]
      : [];
    if (
      JSON.stringify([...sites].sort()) !==
        JSON.stringify([primary, ...aliases].sort()) ||
      sites.some((site) => occupied.has(site))
    ) {
      return undefined;
    }
    for (const site of sites) {
      occupied.add(site);
    }
    routes.push({
      service,
      hostname: prefix || "project",
      port,
      origins: sites.map((site) => `https://${site}`).sort(),
      labels: Object.freeze({ ...selected }),
    });
    pointers.push({
      document: "compose",
      source: `${servicePointer}/labels`,
      target: `/routes/http/${service}`,
    });
  }
  if (!routes.some((route) => route.hostname === "project")) {
    return undefined;
  }
  const openOrigin = `https://${openPreference !== "dev" && aliasHost ? aliasHost : devHost}`;
  return {
    intent: Object.freeze({
      version: 14,
      devHost,
      aliasHost,
      openPreference,
      openOrigin,
      routes: Object.freeze(routes),
    }),
    candidate: Object.freeze({
      routes: {
        origin: `https://${devHost}`,
        ...(aliasHost
          ? {
              aliases: { oauth: { origin: `https://${aliasHost}` } },
              oauth_alias: "oauth",
            }
          : {}),
        http: Object.fromEntries(
          routes.map((route) => [
            route.service,
            {
              service: route.service,
              port: route.port,
              hostname: route.hostname,
            },
          ])
        ),
      },
      open: { prefer: openPreference },
    }),
    pointers: Object.freeze(pointers),
  };
}

/** Storage admission remains the existing default-bridge/named-volume contract;
 * the separately verified routing owner owns the removed shared attachment. */
export function legacyRoutingStorageDocument(
  compose: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...compose };
  Reflect.deleteProperty(result, "networks");
  if (isRecord(compose.services)) {
    result.services = Object.fromEntries(
      Object.entries(compose.services).map(([name, value]) => {
        if (!isRecord(value)) {
          return [name, value];
        }
        const service = { ...value };
        Reflect.deleteProperty(service, "networks");
        return [name, service];
      })
    );
  }
  return result;
}
