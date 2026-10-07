import { isRecord } from "./guards.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

type OpenPreference = "auto" | "alias" | "dev";
type Protocol = "http" | "https";
export type NativeResolvedRoute = {
  readonly service: string;
  readonly port: number;
  readonly protocol: Protocol;
  readonly origin: string;
  readonly aliases: Readonly<Record<string, string>>;
};

/** Public origins are a preview, never evidence of DNS, trust, or OAuth acceptance. */
export type NativeRoutingResolution = {
  readonly domain: string;
  readonly domain_origin:
    | "default"
    | "global"
    | "project"
    | "primary_local"
    | "checkout_local"
    | "explicit";
  readonly project_origin: string;
  readonly aliases: Readonly<Record<string, string>>;
  readonly oauth_alias: string | null;
  readonly open_preference: OpenPreference;
  readonly open_preference_origin:
    | "default"
    | "project"
    | "primary_local"
    | "checkout_local";
  readonly open_origin: string;
  readonly routes: Readonly<Record<string, NativeResolvedRoute>>;
  readonly branch?: string;
};

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function domain(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) {
    return false;
  }
  const labels = value.split(".");
  return (
    (labels.length >= 2 || value === "hack") &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    !NUMERIC_LABEL.test(labels.at(-1) ?? "")
  );
}

function relativeHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.split(".").every((label) => DNS_LABEL.test(label))
  );
}

/** Check the compiler's canonical origin encoding without resolving a hostname. */
function origin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      (host.startsWith("[") || relativeHost(host))
    );
  } catch {
    return false;
  }
}

function preference(value: unknown): value is OpenPreference {
  return value === "auto" || value === "alias" || value === "dev";
}

function domainOrigin(
  value: unknown
): value is NativeRoutingResolution["domain_origin"] {
  return (
    value === "default" ||
    value === "global" ||
    value === "project" ||
    value === "primary_local" ||
    value === "checkout_local" ||
    value === "explicit"
  );
}

function openPreferenceOrigin(
  value: unknown
): value is NativeRoutingResolution["open_preference_origin"] {
  return (
    value === "default" ||
    value === "project" ||
    value === "primary_local" ||
    value === "checkout_local"
  );
}

function protocol(value: unknown): value is Protocol {
  return value === "http" || value === "https";
}

function port(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function origins(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries: [string, string][] = [];
  for (const [name, item] of Object.entries(value)) {
    if (!(NAME.test(name) && origin(item))) {
      return null;
    }
    entries.push([name, item]);
  }
  return Object.fromEntries(entries);
}

/** Validate additive portable declarations; Rust still owns authored validation and selection. */
export function nativeRoutingPlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): boolean {
  const routes = opts.plan.routes;
  const open = opts.plan.open;
  if (
    open !== undefined &&
    !(isRecord(open) && keys(open, ["prefer"]) && preference(open.prefer))
  ) {
    return false;
  }
  if (routes === undefined) {
    return true;
  }
  if (
    !(
      isRecord(routes) &&
      keys(routes, ["domain", "origin", "aliases", "oauth_alias", "http"]) &&
      isRecord(routes.aliases) &&
      isRecord(routes.http)
    )
  ) {
    return false;
  }
  if (
    (routes.domain !== undefined && !domain(routes.domain)) ||
    (routes.origin !== undefined && !origin(routes.origin))
  ) {
    return false;
  }
  return (
    aliasDeclarationsValid(routes.aliases) &&
    (routes.oauth_alias === undefined ||
      (typeof routes.oauth_alias === "string" &&
        Object.hasOwn(routes.aliases, routes.oauth_alias))) &&
    routeDeclarationsValid(routes.http, opts.declared)
  );
}

function aliasDeclarationsValid(aliases: Record<string, unknown>): boolean {
  for (const [name, alias] of Object.entries(aliases)) {
    if (!(NAME.test(name) && isRecord(alias))) {
      return false;
    }
    const fields = Object.keys(alias);
    if (
      fields.length !== 1 ||
      !(fields[0] === "domain"
        ? domain(alias.domain)
        : fields[0] === "origin" && origin(alias.origin))
    ) {
      return false;
    }
  }
  return true;
}

function routeDeclarationsValid(
  routes: Record<string, unknown>,
  declared: NativeDeclaredWorkloads | undefined
): boolean {
  for (const [name, route] of Object.entries(routes)) {
    if (
      !(
        NAME.test(name) &&
        isRecord(route) &&
        keys(route, ["service", "port", "protocol", "hostname"]) &&
        typeof route.service === "string" &&
        declared?.[route.service] === "service" &&
        port(route.port) &&
        protocol(route.protocol) &&
        relativeHost(route.hostname)
      )
    ) {
      return false;
    }
  }
  return true;
}

export function parseNativeRoutingResolution(
  value: unknown
): NativeRoutingResolution | null {
  if (
    !(
      isRecord(value) &&
      keys(value, [
        "domain",
        "domain_origin",
        "project_origin",
        "aliases",
        "oauth_alias",
        "open_preference",
        "open_preference_origin",
        "open_origin",
        "routes",
        "branch",
      ]) &&
      domain(value.domain) &&
      domainOrigin(value.domain_origin) &&
      origin(value.project_origin) &&
      preference(value.open_preference) &&
      openPreferenceOrigin(value.open_preference_origin) &&
      origin(value.open_origin) &&
      isRecord(value.routes)
    )
  ) {
    return null;
  }
  if (
    value.branch !== undefined &&
    !(typeof value.branch === "string" && DNS_LABEL.test(value.branch))
  ) {
    return null;
  }
  const aliases = origins(value.aliases);
  if (
    !(
      aliases &&
      (value.oauth_alias === null ||
        (typeof value.oauth_alias === "string" &&
          Object.hasOwn(aliases, value.oauth_alias)))
    )
  ) {
    return null;
  }
  if (
    new Set([value.project_origin, ...Object.values(aliases)]).size !==
    Object.keys(aliases).length + 1
  ) {
    return null;
  }
  const entries: [string, NativeResolvedRoute][] = [];
  for (const [name, route] of Object.entries(value.routes)) {
    if (
      !(
        NAME.test(name) &&
        isRecord(route) &&
        keys(route, ["service", "port", "protocol", "origin", "aliases"]) &&
        typeof route.service === "string" &&
        NAME.test(route.service) &&
        port(route.port) &&
        protocol(route.protocol) &&
        origin(route.origin)
      )
    ) {
      return null;
    }
    const routeAliases = origins(route.aliases);
    if (!routeAliases) {
      return null;
    }
    entries.push([
      name,
      {
        service: route.service,
        port: route.port,
        protocol: route.protocol,
        origin: route.origin,
        aliases: routeAliases,
      },
    ]);
  }
  return {
    domain: value.domain,
    domain_origin: value.domain_origin,
    project_origin: value.project_origin,
    aliases,
    oauth_alias: value.oauth_alias,
    open_preference: value.open_preference,
    open_preference_origin: value.open_preference_origin,
    open_origin: value.open_origin,
    routes: Object.fromEntries(entries),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
  };
}

function sameNames(
  left: Record<string, unknown>,
  right: Readonly<Record<string, unknown>>
): boolean {
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => Object.hasOwn(right, name))
  );
}

/** Cross-check declaration/selection cardinality so stale or foreign routes cannot enter the report. */
export function nativeRoutingSelectionMatches(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly resolution?: NativeRoutingResolution;
  readonly required?: boolean;
  readonly branch?: string;
  readonly explicitDomain?: string;
  readonly globalDomain?: string;
}): boolean {
  if (!nativeRoutingPlanIsValid(opts)) {
    return false;
  }
  const resolution = opts.resolution;
  if (!resolution) {
    return (
      !opts.required &&
      opts.plan.routes === undefined &&
      opts.plan.open === undefined
    );
  }
  if (
    resolution.branch !== opts.branch ||
    (opts.explicitDomain !== undefined &&
      (resolution.domain !== opts.explicitDomain ||
        resolution.domain_origin !== "explicit")) ||
    (resolution.domain_origin === "explicit" &&
      opts.explicitDomain === undefined) ||
    (resolution.domain_origin === "global" &&
      resolution.domain !== opts.globalDomain) ||
    (resolution.domain_origin === "default" &&
      resolution.domain !== "hack.local")
  ) {
    return false;
  }
  const routes = opts.plan.routes;
  const declaredRoutes =
    isRecord(routes) && isRecord(routes.http) ? routes.http : {};
  const aliases =
    isRecord(routes) && isRecord(routes.aliases) ? routes.aliases : {};
  const selected = opts.plan.services;
  if (!(isRecord(selected) && sameNames(aliases, resolution.aliases))) {
    return false;
  }
  return (
    selectedRoutesMatch({ declaredRoutes, aliases, selected, resolution }) &&
    routingOriginsMatch({
      routes,
      aliases,
      resolution,
      projectName: opts.plan.name,
    }) &&
    openSelectionMatches(opts.plan.open, resolution)
  );
}

function selectedRoutesMatch(opts: {
  readonly declaredRoutes: Record<string, unknown>;
  readonly aliases: Record<string, unknown>;
  readonly selected: Record<string, unknown>;
  readonly resolution: NativeRoutingResolution;
}): boolean {
  const { declaredRoutes, aliases, selected, resolution } = opts;
  const expected = Object.entries(declaredRoutes).filter(
    ([, route]) =>
      isRecord(route) &&
      typeof route.service === "string" &&
      Object.hasOwn(selected, route.service)
  );
  if (expected.length !== Object.keys(resolution.routes).length) {
    return false;
  }
  const seen = new Set<string>();
  for (const [name, route] of expected) {
    const item = resolution.routes[name];
    if (
      !(isRecord(route) && item) ||
      item.service !== route.service ||
      item.port !== route.port ||
      item.protocol !== route.protocol ||
      !sameNames(aliases, item.aliases) ||
      !scopedOriginsMatch({ route, item, resolution, seen })
    ) {
      return false;
    }
  }
  return true;
}

function scopedOriginsMatch(opts: {
  readonly route: Record<string, unknown>;
  readonly item: NativeResolvedRoute;
  readonly resolution: NativeRoutingResolution;
  readonly seen: Set<string>;
}): boolean {
  if (
    typeof opts.route.hostname !== "string" ||
    opts.item.origin !==
      scopedOrigin(opts.route.hostname, opts.resolution.project_origin)
  ) {
    return false;
  }
  for (const [name, base] of Object.entries(opts.resolution.aliases)) {
    if (opts.item.aliases[name] !== scopedOrigin(opts.route.hostname, base)) {
      return false;
    }
  }
  for (const value of [opts.item.origin, ...Object.values(opts.item.aliases)]) {
    if (opts.seen.has(value)) {
      return false;
    }
    opts.seen.add(value);
  }
  return true;
}

/** Verify the fixed wire relation only; Rust owns route admission and domain precedence. */
function scopedOrigin(hostname: string, base: string): string | null {
  if (hostname === "project") {
    return base;
  }
  const parsed = new URL(base);
  if (parsed.hostname.startsWith("[") || IPV4.test(parsed.hostname)) {
    return null;
  }
  const result = `${parsed.protocol}//${hostname}.${parsed.host}`;
  return origin(result) ? result : null;
}

function routingOriginsMatch(opts: {
  readonly routes: unknown;
  readonly aliases: Record<string, unknown>;
  readonly resolution: NativeRoutingResolution;
  readonly projectName: unknown;
}): boolean {
  const { routes, aliases, resolution } = opts;
  const oauthAlias = isRecord(routes) ? (routes.oauth_alias ?? null) : null;
  if (
    oauthAlias !== resolution.oauth_alias ||
    (isRecord(routes) &&
      routes.origin !== undefined &&
      routes.origin !== resolution.project_origin)
  ) {
    return false;
  }
  if (typeof opts.projectName !== "string") {
    return false;
  }
  const namespace = `${resolution.branch === undefined ? "" : `${resolution.branch}.`}${opts.projectName}`;
  if (
    (!isRecord(routes) || routes.origin === undefined) &&
    resolution.project_origin !== `https://${namespace}.${resolution.domain}`
  ) {
    return false;
  }
  if (
    resolution.domain_origin === "project" &&
    (!isRecord(routes) || routes.domain !== resolution.domain)
  ) {
    return false;
  }
  for (const [name, alias] of Object.entries(aliases)) {
    if (
      isRecord(alias) &&
      alias.origin !== undefined &&
      resolution.aliases[name] !== alias.origin
    ) {
      return false;
    }
    if (
      isRecord(alias) &&
      typeof alias.domain === "string" &&
      resolution.aliases[name] !== `https://${namespace}.${alias.domain}`
    ) {
      return false;
    }
  }
  return true;
}

function openSelectionMatches(
  open: unknown,
  resolution: NativeRoutingResolution
): boolean {
  if (
    resolution.open_preference_origin === "project" &&
    (!isRecord(open) || open.prefer !== resolution.open_preference)
  ) {
    return false;
  }
  if (
    resolution.open_preference_origin === "default" &&
    resolution.open_preference !== "auto"
  ) {
    return false;
  }
  const aliasOrigin =
    resolution.oauth_alias === null
      ? undefined
      : resolution.aliases[resolution.oauth_alias];
  const expectedOpen =
    resolution.open_preference === "dev"
      ? resolution.project_origin
      : (aliasOrigin ?? resolution.project_origin);
  return (
    !(resolution.open_preference === "alias" && aliasOrigin === undefined) &&
    resolution.open_origin === expectedOpen
  );
}
