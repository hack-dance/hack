import { isDeepStrictEqual } from "node:util";
import { isRecord } from "./guards.ts";

const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NUMBERED_ROUTE = /^caddy_\d+$/;
const MAP_ROUTE = /^(\s*)caddy:\s*(.*)$/;
const LIST_ITEM = /^(\s*-\s*)(.*)$/;
const YAML_INDIRECTION = /(?:^|[\s,[{])[&*!][^\s]/m;
const LIST_CADDY = /^["']?caddy=/;
const TRAILING_DOT = /\.$/;

type Route = {
  readonly service: string;
  readonly hosts: readonly string[];
  readonly update: (value: string) => void;
};

function reject(): never {
  throw new Error(
    "Domain migration requires explicit, unambiguous literal Compose routes"
  );
}

function parseConfig(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "Domain migration requires valid JSON project configuration"
    );
  }
  if (!isRecord(value)) {
    throw new Error("Domain migration requires a project configuration object");
  }
  return value;
}

function parseYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch {
    return reject();
  }
}

function resolveHosts(config: Record<string, unknown>) {
  const fromHost = config.dev_host;
  if (typeof fromHost !== "string" || !HOST.test(fromHost)) {
    throw new Error("Domain migration requires an explicit lowercase dev_host");
  }
  const suffix = fromHost.endsWith(".hack.gy") ? ".hack.gy" : ".hack";
  if (!fromHost.endsWith(suffix)) {
    throw new Error(
      "Domain migration supports only existing .hack or .hack.gy hosts"
    );
  }
  const prefix = fromHost.slice(0, -suffix.length);
  const toHost = `${prefix}.hack.local`;
  return {
    fromHost,
    toHost,
    legacyHosts: [`${prefix}.hack`, `${prefix}.hack.gy`],
  };
}

function literalHosts(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return reject();
  }
  const hosts = value.split(",").map((host) => host.trim());
  if (!hosts.length || hosts.some((host) => !HOST.test(host))) {
    return reject();
  }
  return hosts;
}

function validateStructure(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      validateStructure(entry);
    }
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (["<<", "include", "extends", "volumes_from"].includes(key)) {
        reject();
      }
      validateStructure(entry);
    }
  }
}

function mapRoutes(labels: Record<string, unknown>, service: string): Route[] {
  const routes: Route[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (key.includes("$") || NUMBERED_ROUTE.test(key)) {
      return reject();
    }
    if (key === "caddy") {
      routes.push({
        service,
        hosts: literalHosts(value),
        update: (next) => {
          labels[key] = next;
        },
      });
    }
  }
  return routes;
}

function listRoutes(labels: unknown[], service: string): Route[] {
  const routes: Route[] = [];
  for (const [index, value] of labels.entries()) {
    if (typeof value !== "string") {
      return reject();
    }
    const equal = value.indexOf("=");
    const key = equal < 0 ? value : value.slice(0, equal);
    if (key.includes("$") || NUMBERED_ROUTE.test(key)) {
      return reject();
    }
    if (key !== "caddy") {
      continue;
    }
    if (routes.length || equal < 0) {
      return reject();
    }
    routes.push({
      service,
      hosts: literalHosts(value.slice(equal + 1)),
      update: (next) => {
        labels[index] = `caddy=${next}`;
      },
    });
  }
  return routes;
}

function collectRoutes(compose: unknown): Route[] {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return reject();
  }
  const routes: Route[] = [];
  for (const [service, spec] of Object.entries(compose.services)) {
    if (!isRecord(spec)) {
      return reject();
    }
    const labels = spec.labels;
    if (labels === undefined) {
      continue;
    }
    if (isRecord(labels)) {
      routes.push(...mapRoutes(labels, service));
    } else if (Array.isArray(labels)) {
      routes.push(...listRoutes(labels, service));
    } else {
      return reject();
    }
  }
  return routes;
}

function migratedHost(
  host: string,
  legacyHosts: readonly string[],
  toHost: string
): string | null {
  for (const legacy of legacyHosts) {
    if (host === legacy) {
      return toHost;
    }
    if (host.endsWith(`.${legacy}`)) {
      return `${host.slice(0, -legacy.length)}${toHost}`;
    }
  }
  return null;
}

/** Preserve inline comments; unsupported multiline/flow label styles fail the semantic check. */
function splitComment(text: string): { value: string; comment: string } {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === '"' && char === "\\") {
      i += 1;
    } else if (quote && char === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i += 1;
      } else {
        quote = "";
      }
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && char === "#" && (i === 0 || text[i - 1] === " ")) {
      return {
        value: text.slice(0, i).trimEnd(),
        comment: ` ${text.slice(i)}`,
      };
    }
  }
  return { value: text.trimEnd(), comment: "" };
}

function patchLine(
  line: string,
  replacements: ReadonlyMap<string, string>
): string {
  const map = MAP_ROUTE.exec(line);
  const list = map ? null : LIST_ITEM.exec(line);
  if (!(map || list)) {
    return line;
  }
  const prefix = map?.[1] ?? list?.[1] ?? "";
  const raw = map?.[2] ?? list?.[2] ?? "";
  if (list && !LIST_CADDY.test(raw)) {
    return line;
  }
  const { value, comment } = splitComment(raw);
  const parsed = parseYaml(value);
  if (typeof parsed !== "string") {
    return line;
  }
  const listHosts = parsed.startsWith("caddy=") ? parsed.slice(6) : null;
  const hosts = map ? parsed : listHosts;
  if (hosts === null) {
    return line;
  }
  const next = replacements.get(
    hosts
      .split(",")
      .map((host) => host.trim())
      .join(", ")
  );
  if (!next) {
    return line;
  }
  return map
    ? `${prefix}caddy: ${JSON.stringify(next)}${comment}`
    : `${prefix}${JSON.stringify(`caddy=${next}`)}${comment}`;
}

/**
 * Pure conservative migration. Add routes without removing old hosts or changing
 * non-route fields. Literal block-style label edits preserve comments; comparing
 * the complete parsed output to the planned structure rejects ambiguous edits.
 * The caller owns claim discovery, confirmation, persistence and exact rollback.
 */
export function planProjectDomainMigration(opts: {
  readonly configText: string;
  readonly composeText: string;
  readonly claimedHosts?: readonly string[];
}): {
  readonly fromHost: string;
  readonly toHost: string;
  readonly configText: string;
  readonly composeText: string;
  readonly addedHosts: readonly string[];
} {
  const config = parseConfig(opts.configText);
  const { fromHost, toHost, legacyHosts } = resolveHosts(config);
  if (YAML_INDIRECTION.test(opts.composeText)) {
    return reject();
  }
  const compose = parseYaml(opts.composeText);
  validateStructure(compose);
  const routes = collectRoutes(compose);
  const claimed = new Set(
    (opts.claimedHosts ?? []).map((host) =>
      host.toLowerCase().replace(TRAILING_DOT, "")
    )
  );
  const added = new Set<string>();
  const planned = new Map<string, string>();
  const replacements = new Map<string, string>();
  let matched = false;
  for (const route of routes) {
    const hosts = new Set(route.hosts);
    for (const host of route.hosts) {
      const target = migratedHost(host, legacyHosts, toHost);
      if (!target) {
        continue;
      }
      matched = true;
      const otherOwner = planned.get(target);
      if (
        [...claimed].some(
          (claim) =>
            claim === target ||
            (claim.startsWith("*.") && target.endsWith(claim.slice(1)))
        ) ||
        routes.some(
          (other) =>
            other.service !== route.service && other.hosts.includes(target)
        ) ||
        (otherOwner !== undefined && otherOwner !== route.service)
      ) {
        throw new Error(
          "Domain migration conflicts with an existing hostname claim"
        );
      }
      planned.set(target, route.service);
      if (!hosts.has(target)) {
        added.add(target);
        hosts.add(target);
      }
    }
    const next = [...hosts].join(", ");
    replacements.set(route.hosts.join(", "), next);
    route.update(next);
  }
  if (!matched) {
    throw new Error("Domain migration found no matching legacy project routes");
  }
  const composeText = opts.composeText
    .split("\n")
    .map((line) => patchLine(line, replacements))
    .join("\n");
  if (!isDeepStrictEqual(parseYaml(composeText), compose)) {
    return reject();
  }
  return {
    fromHost,
    toHost,
    configText: `${JSON.stringify({ ...config, dev_host: toHost }, null, 2)}\n`,
    composeText,
    addedHosts: [...added],
  };
}
