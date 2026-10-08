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

function proxyHandler(value: Record<string, unknown>, scope: HostScope): Proxy {
  if (!Array.isArray(value.upstreams)) {
    return refused();
  }
  const dials = value.upstreams
    .map((upstream) => {
      if (!isRecord(upstream) || typeof upstream.dial !== "string") {
        return refused();
      }
      return upstream.dial;
    })
    .sort();
  if (new Set(dials).size !== dials.length) {
    return refused();
  }
  let protocol: "http" | "https" = "http";
  if (value.transport !== undefined) {
    if (!isRecord(value.transport) || value.transport.protocol !== "http") {
      return refused();
    }
    protocol = value.transport.tls === undefined ? "http" : "https";
  }
  return { ...scope, dials, protocol };
}

function collectRoutes(
  value: unknown,
  inherited: HostScope,
  output: { hosts: Set<string>; proxies: Proxy[] },
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
    if (route.match !== undefined) {
      for (const hostname of scope.hosts) {
        output.hosts.add(hostname);
      }
    }
    collectHandlers(route.handle, scope, output, depth);
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
  output: { hosts: Set<string>; proxies: Proxy[] },
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
      output.proxies.push(proxy);
      for (const hostname of proxy.hosts) {
        output.hosts.add(hostname);
      }
    }
    if (handler.handler === "subroute") {
      collectRoutes(handler.routes, scope, output, depth + 1);
    }
  }
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
  const result = { hosts: new Set<string>(), proxies: [] as Proxy[] };
  for (const server of Object.values(opts.servers)) {
    if (!isRecord(server)) {
      return refused();
    }
    if (server.routes !== undefined) {
      collectRoutes(
        server.routes,
        { hosts: ["*"], conditional: false },
        result
      );
    }
  }
  if (
    opts.absentHostnames.some((host) =>
      [...result.hosts].some((active) => covers(active, host))
    )
  ) {
    return false;
  }
  for (const route of opts.expected) {
    for (const hostname of route.hostnames) {
      const candidates = result.proxies.filter((proxy) =>
        proxy.hosts.some((active) => covers(active, hostname))
      );
      if (
        candidates.length !== 1 ||
        candidates[0]?.conditional ||
        !candidates[0]?.hosts.includes(hostname) ||
        candidates[0]?.protocol !== route.protocol ||
        candidates[0]?.dials.join() !== [...route.dials].sort().join()
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
