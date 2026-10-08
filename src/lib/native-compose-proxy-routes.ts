import { isIP } from "node:net";
import { isRecord } from "./guards.ts";
import {
  type NativeComposeIngressBinding,
  observeNativeComposeIngress,
} from "./native-compose-ingress.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { NativeComposeRoutingError } from "./native-compose-routing.ts";

const ID = /^[a-f0-9]{64}$/;
const INSPECT =
  '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"generation":{{json (index .Config.Labels "io.hack.native-config.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"running":{{json .State.Running}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"ip":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .IPAddress}}{{else}}null{{end}}}';

export type NativeComposeProxyRoute = {
  readonly hostnames: readonly string[];
  /** Selected frontend origins, independent of the upstream transport protocol. */
  readonly origins: readonly string[];
  readonly service: string;
  readonly port: number;
  readonly protocol: "http" | "https";
};
type Proxy = {
  readonly hosts: readonly string[];
  readonly dials: readonly string[];
  readonly protocol: "http" | "https";
  readonly conditional: boolean;
};
type Activity = HostScope & { readonly proxy?: Proxy };
type ServerProjection = {
  readonly listen: readonly string[];
  readonly tls: boolean | null;
  readonly activities: readonly Activity[];
};
type HostScope = {
  readonly hosts: readonly string[];
  readonly conditional: boolean;
};
type ExpectedRoute = NativeComposeProxyRoute & {
  readonly dials: readonly string[];
};
const ADMIN_URL = "http://127.0.0.1:2019/config/apps/http/servers";
async function readActiveProxy(opts: {
  readonly binding: NativeComposeIngressBinding;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const probe = createNativeComposeProbe({ signal: opts.signal });
  const output = await probe([
    "exec",
    opts.binding.proxyId,
    "curl",
    "--disable",
    "--silent",
    "--show-error",
    "--fail",
    "--proxy",
    "",
    "--noproxy",
    "*",
    "--proto",
    "=http",
    "--max-time",
    "10",
    "--max-redirs",
    "0",
    "--write-out",
    "\n%{http_code}",
    "--url",
    ADMIN_URL,
  ]);
  if (!output.endsWith("\n200")) {
    return refused();
  }
  return JSON.parse(output.slice(0, -4));
}

export class NativeComposeProxyAccessError extends Error {
  readonly code = "E_NATIVE_COMPOSE_PROXY_ACCESS";
  constructor() {
    super(
      "Native Compose routing needs the verified live Caddy API reader. Refresh the global runtime template with hack global install or the guided hack doctor --fix repair, retaining caddy_data, before restarting it. Values omitted."
    );
    this.name = "NativeComposeProxyAccessError";
  }
}

/** Verify live read access before any project effect; never repair or replace the proxy here. */
export async function assertNativeComposeProxyAccess(opts: {
  readonly binding: NativeComposeIngressBinding;
  readonly signal?: AbortSignal;
}): Promise<void> {
  try {
    const selected = {
      binding: Object.freeze({ ...opts.binding }),
      signal: opts.signal,
    };
    await observeNativeComposeIngress({
      expected: selected.binding,
      signal: selected.signal,
    });
    nativeComposeProxyRoutesMatch({
      servers: await readActiveProxy(selected),
      expected: [],
      absentHostnames: [],
    });
    await observeNativeComposeIngress({
      expected: selected.binding,
      signal: selected.signal,
    });
  } catch {
    throw new NativeComposeProxyAccessError();
  }
}
function refused(): never {
  throw new NativeComposeRoutingError();
}
function covers(pattern: string, hostname: string): boolean {
  return (
    pattern === hostname ||
    pattern === "*" ||
    (pattern.startsWith("*.") && hostname.endsWith(pattern.slice(1)))
  );
}
function hostStrings(value: unknown): string[] {
  if (
    !(
      Array.isArray(value) &&
      value.every((item) => typeof item === "string" && item.length > 0)
    )
  ) {
    return refused();
  }
  return [...value];
}

function proxyHandler(
  value: Record<string, unknown>,
  scope: HostScope
): Proxy | null {
  if (
    Object.keys(value).some(
      (key) => !["handler", "upstreams", "transport"].includes(key)
    ) ||
    !Array.isArray(value.upstreams) ||
    !value.upstreams.length
  ) {
    return null;
  }
  const dials: string[] = [];
  for (const upstream of value.upstreams) {
    if (
      !isRecord(upstream) ||
      Object.keys(upstream).join() !== "dial" ||
      typeof upstream.dial !== "string"
    ) {
      return null;
    }
    dials.push(upstream.dial);
  }
  if (new Set(dials).size !== dials.length) {
    return null;
  }
  let protocol: "http" | "https" = "http";
  if (value.transport !== undefined) {
    if (
      !isRecord(value.transport) ||
      value.transport.protocol !== "http" ||
      Object.keys(value.transport).some(
        (key) => !["protocol", "tls"].includes(key)
      ) ||
      (value.transport.tls !== undefined &&
        (!isRecord(value.transport.tls) ||
          Object.keys(value.transport.tls).length !== 0))
    ) {
      return null;
    }
    protocol = value.transport.tls === undefined ? "http" : "https";
  }
  return { ...scope, dials: dials.sort(), protocol };
}

function collectRoutes(
  value: unknown,
  inherited: HostScope,
  output: { hosts: Set<string>; activities: Activity[] },
  depth = 0
): void {
  if (!Array.isArray(value) || depth > 64) {
    refused();
  }
  for (const route of value) {
    if (!isRecord(route)) {
      refused();
    }
    const scope = matchedHosts(route.match, inherited);
    if (
      route.group !== undefined ||
      Object.keys(route).some(
        (key) => !["match", "handle", "terminal"].includes(key)
      )
    ) {
      // Group dispatch and unknown route controls can skip or alter the nominal handler path.
      output.activities.push(scope);
    }
    if (route.match !== undefined) {
      for (const hostname of scope.hosts) {
        output.hosts.add(hostname);
      }
    }
    collectHandlers(route.handle, scope, output, depth);
    // A terminal matched route can stop dispatch even when its nested handlers did not respond.
    if (route.terminal === true) {
      output.activities.push(scope);
    }
  }
}

function matchedHosts(value: unknown, inherited: HostScope): HostScope {
  if (value === undefined) {
    return inherited;
  }
  if (!Array.isArray(value)) {
    return refused();
  }
  const explicit: string[] = [];
  let conditional = inherited.conditional;
  for (const matcher of value) {
    if (!isRecord(matcher)) {
      return refused();
    }
    conditional ||= Object.keys(matcher).some((key) => key !== "host");
    const hosts =
      matcher.host === undefined ? ["*"] : hostStrings(matcher.host);
    for (const host of hosts) {
      explicit.push(...intersectHosts(host, inherited.hosts));
    }
  }
  if (!value.length) {
    return inherited;
  }
  return { hosts: [...new Set(explicit)], conditional };
}

function intersectHosts(host: string, parents: readonly string[]): string[] {
  return parents.flatMap((parent) => {
    if (covers(parent, host)) {
      return [host];
    }
    return covers(host, parent) ? [parent] : [];
  });
}

function collectHandlers(
  value: unknown,
  scope: HostScope,
  output: { hosts: Set<string>; activities: Activity[] },
  depth: number
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    refused();
  }
  for (const handler of value) {
    if (!isRecord(handler)) {
      refused();
    }
    if (handler.handler === "reverse_proxy") {
      const proxy = proxyHandler(handler, scope);
      output.activities.push({ ...scope, ...(proxy ? { proxy } : {}) });
      for (const hostname of scope.hosts) {
        output.hosts.add(hostname);
      }
    }
    if (handler.handler === "subroute") {
      if (
        Object.keys(handler).some((key) => !["handler", "routes"].includes(key))
      ) {
        output.activities.push(scope);
      }
      collectRoutes(handler.routes, scope, output, depth + 1);
    } else if (handler.handler !== "reverse_proxy") {
      // Unknown middleware and responders may alter or terminate dispatch. They cannot prove a route.
      output.activities.push(scope);
    }
  }
}

function frontendTls(value: unknown): boolean | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return false;
  }
  return Array.isArray(value) &&
    value.length === 1 &&
    isRecord(value[0]) &&
    Object.keys(value[0]).length === 0
    ? true
    : null;
}

function frontendListener(server: ServerProjection, origin: URL): boolean {
  const port = origin.protocol === "https:" ? 443 : 80;
  return (
    server.tls === (origin.protocol === "https:") &&
    server.listen.some((address) =>
      [`:${port}`, `0.0.0.0:${port}`, `[::]:${port}`].includes(address)
    )
  );
}

function routeMatches(
  server: ServerProjection,
  route: ExpectedRoute,
  hostname: string
): boolean {
  const candidates = server.activities
    .map((activity, index) => ({ activity, index }))
    .filter(
      ({ activity }) =>
        activity.proxy &&
        activity.hosts.some((active) => covers(active, hostname))
    );
  if (candidates.length !== 1) {
    return false;
  }
  const selected = candidates[0];
  const proxy = selected?.activity.proxy;
  if (!(selected && proxy)) {
    return false;
  }
  return (
    !proxy.conditional &&
    proxy.hosts.includes(hostname) &&
    proxy.protocol === route.protocol &&
    proxy.dials.join() === [...route.dials].sort().join() &&
    !server.activities
      .slice(0, selected.index)
      .some((activity) =>
        activity.hosts.some((active) => covers(active, hostname))
      )
  );
}

/** Project only public host/dial policy in memory; raw active config is never returned or logged. */
export function nativeComposeProxyRoutesMatch(opts: {
  readonly servers: unknown;
  readonly expected: readonly ExpectedRoute[];
  readonly absentHostnames: readonly string[];
}): boolean {
  if (!isRecord(opts.servers)) {
    return refused();
  }
  const hosts = new Set<string>();
  const servers: ServerProjection[] = [];
  for (const server of Object.values(opts.servers)) {
    if (!isRecord(server)) {
      return refused();
    }
    const result = { hosts, activities: [] as Activity[] };
    if (server.routes !== undefined) {
      collectRoutes(
        server.routes,
        { hosts: ["*"], conditional: false },
        result
      );
    }
    servers.push({
      listen: server.listen === undefined ? [] : hostStrings(server.listen),
      tls: frontendTls(server.tls_connection_policies),
      activities: result.activities,
    });
  }
  if (
    opts.absentHostnames.some((host) =>
      [...hosts].some((active) => covers(active, host))
    )
  ) {
    return false;
  }
  for (const route of opts.expected) {
    const origins = route.origins.map((origin) => new URL(origin));
    if (
      !origins.length ||
      origins.some(
        (origin) =>
          !["http:", "https:"].includes(origin.protocol) ||
          origin.port ||
          origin.username ||
          origin.password ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash
      ) ||
      [...new Set(origins.map((origin) => origin.hostname))].sort().join() !==
        [...route.hostnames].sort().join()
    ) {
      return false;
    }
    for (const origin of origins) {
      const candidates = servers.filter((server) =>
        frontendListener(server, origin)
      );
      // Multiple listeners can dispatch the same origin differently. Require exactly one proven path.
      const server = candidates[0];
      if (
        candidates.length !== 1 ||
        !server ||
        !routeMatches(server, route, origin.hostname)
      ) {
        return false;
      }
    }
  }
  return true;
}

function containerIds(text: string): string[] {
  const values: unknown[] = text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  if (
    !values.every((value) => typeof value === "string" && ID.test(value)) ||
    new Set(values).size !== values.length
  ) {
    return refused();
  }
  return values as string[];
}
async function expectedRoutes(opts: {
  readonly probe: ReturnType<typeof createNativeComposeProbe>;
  readonly binding: NativeComposeIngressBinding;
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly generationId?: string;
  readonly routes: readonly NativeComposeProxyRoute[];
}): Promise<ExpectedRoute[]> {
  if (!opts.routes.length) {
    return [];
  }
  const selected = containerIds(
    await opts.probe([
      "container",
      "ls",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${opts.composeProject}`,
      "--format",
      "{{json .ID}}",
    ])
  );
  if (!selected.length) {
    return refused();
  }
  const containers: Record<string, unknown>[] = [];
  for (let offset = 0; offset < selected.length; offset += 64) {
    const batch = selected.slice(offset, offset + 64);
    const rows: unknown[] = (
      await opts.probe(["container", "inspect", "--format", INSPECT, ...batch])
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      rows.length !== batch.length ||
      new Set(rows.map((row) => (isRecord(row) ? row.id : null))).size !==
        rows.length ||
      !rows.every(
        (row) =>
          isRecord(row) &&
          Object.keys(row).sort().join() ===
            "generation,id,instance,ip,network,oneoff,owner,project,running,service" &&
          typeof row.id === "string" &&
          batch.includes(row.id)
      )
    ) {
      return refused();
    }
    containers.push(...(rows as Record<string, unknown>[]));
  }
  return opts.routes.map((route) => {
    const matches = containers.filter(
      (container) =>
        container.service === route.service && container.oneoff === "False"
    );
    if (!matches.length) {
      return refused();
    }
    const dials = matches.map((container) => {
      if (
        container.project !== opts.composeProject ||
        container.instance !== opts.composeProject ||
        container.owner !== opts.ownerToken ||
        container.running !== true ||
        (opts.generationId !== undefined &&
          container.generation !== opts.generationId) ||
        container.network !== opts.binding.networkId ||
        typeof container.ip !== "string" ||
        isIP(container.ip) !== 4
      ) {
        return refused();
      }
      return `${container.ip}:${route.port}`;
    });
    return { ...route, dials: dials.sort() };
  });
}

/** Read-only confirmation of the selected active proxy, including its actual upstreams. */
export async function assertNativeComposeProxyRoutes(opts: {
  readonly binding: NativeComposeIngressBinding;
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly generationId?: string;
  readonly routes?: readonly NativeComposeProxyRoute[];
  readonly absentHostnames?: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadline: number;
}): Promise<void> {
  try {
    const remaining = opts.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return refused();
    }
    const deadlineSignal = AbortSignal.timeout(Math.ceil(remaining));
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, deadlineSignal])
      : deadlineSignal;
    const selected = Object.freeze({
      ...opts,
      binding: Object.freeze({ ...opts.binding }),
      routes: Object.freeze(
        (opts.routes ?? []).map((route) =>
          Object.freeze({
            ...route,
            hostnames: Object.freeze([...route.hostnames]),
            origins: Object.freeze([...route.origins]),
          })
        )
      ),
      absentHostnames: Object.freeze([...(opts.absentHostnames ?? [])]),
      signal,
    });
    await observeNativeComposeIngress({ expected: selected.binding, signal });
    const probe = createNativeComposeProbe({ signal });
    let expected = await expectedRoutes({ ...selected, probe });
    const readActive = async () => {
      // Fixed GET inside the exact verified proxy. Nothing is published and no admin mutation occurs.
      const servers = await readActiveProxy(selected);
      return nativeComposeProxyRoutesMatch({
        servers,
        expected,
        absentHostnames: selected.absentHostnames,
      });
    };
    while (Date.now() < selected.deadline && !signal.aborted) {
      if (await readActive()) {
        await observeNativeComposeIngress({
          expected: selected.binding,
          signal,
        });
        expected = await expectedRoutes({
          ...selected,
          probe: createNativeComposeProbe({ signal }),
        });
        if (await readActive()) {
          if (signal.aborted || Date.now() >= selected.deadline) {
            return refused();
          }
          return;
        }
      }
      await Bun.sleep(
        Math.min(500, Math.max(0, selected.deadline - Date.now()))
      );
    }
    refused();
  } catch {
    refused();
  }
}
