import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { YAML } from "bun";
import {
  DEFAULT_INGRESS_NETWORK,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CADDY_REMOTE_ROUTES_COMPOSE_FILENAME,
  GLOBAL_CADDY_REMOTE_ROUTES_PROJECT_NAME,
  GLOBAL_CADDY_REMOTE_ROUTES_REGISTRY_FILENAME,
  GLOBAL_HACK_DIR_NAME,
  PROJECT_COMPOSE_FILENAME,
} from "../constants.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "./fs.ts";
import { isRecord } from "./guards.ts";
import type { NodeRecord } from "./nodes-registry.ts";
import { sanitizeProjectSlug } from "./project.ts";
import { exec } from "./shell.ts";

const REMOTE_ROUTE_REGISTRY_VERSION = 1 as const;
const REMOTE_CADDY_UPSTREAM_PORT = 80 as const;
const BRACKETED_HOST_PATTERN = /^\[(.+)\](?::\d+)?$/;
const HOST_WITH_PORT_PATTERN = /^([^:]+):\d+$/;

type RemoteRouteRegistryRecord = {
  readonly id: string;
  readonly projectKey: string;
  readonly host: string;
  readonly upstream: string;
  readonly nodeId: string;
  readonly updatedAt: string;
};

type RemoteRouteRegistry = {
  readonly version: typeof REMOTE_ROUTE_REGISTRY_VERSION;
  readonly routes: readonly RemoteRouteRegistryRecord[];
};

export type RemoteCaddyRouteRecord = {
  readonly id: string;
  readonly projectKey: string;
  readonly host: string;
  readonly upstream: string;
  readonly nodeId: string;
  readonly updatedAt: string;
};

export type RemoteCaddyRouteBridgeState = {
  readonly caddyDir: string;
  readonly caddyComposePath: string;
  readonly routesComposePath: string;
  readonly routesRegistryPath: string;
  readonly caddyComposeExists: boolean;
  readonly routesComposeExists: boolean;
  readonly routesRegistryExists: boolean;
  readonly routes: readonly RemoteCaddyRouteRecord[];
};

export type RemoteCaddyRouteBridgeResult = {
  readonly status: "applied" | "saved" | "skipped" | "failed";
  readonly reason:
    | "applied"
    | "saved_pending_global_caddy"
    | "no_hosts"
    | "upstream_unresolved"
    | "apply_failed";
  readonly hosts: readonly string[];
  readonly upstream: string | null;
  readonly composePath: string;
  readonly registryPath: string;
  readonly error?: string;
};

type RemoteRouteBridgePaths = {
  readonly caddyDir: string;
  readonly caddyComposePath: string;
  readonly routesComposePath: string;
  readonly routesRegistryPath: string;
};

type SyncRemoteRoutesResult = {
  readonly status: "applied" | "saved" | "failed";
  readonly reason: "applied" | "saved_pending_global_caddy" | "apply_failed";
  readonly error?: string;
};

/**
 * Reconciles local Caddy route bridge entries for a remote dispatch target.
 *
 * This writes a durable controller-side route registry and materializes a
 * compose stack whose label-only sidecar containers are discovered by
 * `caddy-docker-proxy`. Dispatch continues even when bridge application fails;
 * callers can surface the warning as needed.
 */
export async function reconcileRemoteCaddyRoutesForProject(input: {
  readonly projectKey: string;
  readonly projectDir?: string;
  readonly fallbackProjectHost?: string;
  readonly node: NodeRecord;
}): Promise<RemoteCaddyRouteBridgeResult> {
  const paths = resolveRemoteRouteBridgePaths({ homeDir: resolveHomeDir() });
  const hosts = await resolveProjectHostsForBridge({
    projectDir: input.projectDir,
    fallbackProjectHost: input.fallbackProjectHost,
  });
  const upstream = resolveRemoteCaddyUpstream({
    endpoint: input.node.endpoint,
    source: input.node.source,
  });
  if (hosts.length === 0) {
    return {
      status: "skipped",
      reason: "no_hosts",
      hosts,
      upstream,
      composePath: paths.routesComposePath,
      registryPath: paths.routesRegistryPath,
    };
  }
  if (!upstream) {
    return {
      status: "skipped",
      reason: "upstream_unresolved",
      hosts,
      upstream,
      composePath: paths.routesComposePath,
      registryPath: paths.routesRegistryPath,
    };
  }

  await ensureDir(paths.caddyDir);
  const registry = await readRemoteRouteRegistry({
    registryPath: paths.routesRegistryPath,
  });
  const nextRegistry = upsertRemoteRouteRegistryEntries({
    registry,
    projectKey: input.projectKey,
    nodeId: input.node.id,
    hosts,
    upstream,
    updatedAt: new Date().toISOString(),
  });
  await writeTextFileIfChanged(
    paths.routesRegistryPath,
    `${JSON.stringify(nextRegistry, null, 2)}\n`
  );
  await writeTextFileIfChanged(
    paths.routesComposePath,
    renderRemoteRouteCompose({
      routes: nextRegistry.routes,
    })
  );

  const syncResult = await syncRemoteRouteBridgeStack({
    paths,
    registry: nextRegistry,
  });
  return {
    status: syncResult.status,
    reason: syncResult.reason,
    hosts,
    upstream,
    composePath: paths.routesComposePath,
    registryPath: paths.routesRegistryPath,
    ...(syncResult.error ? { error: syncResult.error } : {}),
  };
}

/**
 * Re-applies remote bridge routes during `hack global up` so previously
 * registered remote hosts become available again after daemon/docker restarts.
 */
export async function reconcileRemoteCaddyRoutesStack(): Promise<
  | {
      readonly status: "applied" | "saved" | "none";
      readonly composePath: string;
      readonly routeCount: number;
    }
  | {
      readonly status: "failed";
      readonly composePath: string;
      readonly routeCount: number;
      readonly error: string;
    }
> {
  const paths = resolveRemoteRouteBridgePaths({ homeDir: resolveHomeDir() });
  const registry = await readRemoteRouteRegistry({
    registryPath: paths.routesRegistryPath,
  });
  await ensureDir(paths.caddyDir);
  await writeTextFileIfChanged(
    paths.routesComposePath,
    renderRemoteRouteCompose({
      routes: registry.routes,
    })
  );
  if (registry.routes.length === 0) {
    return {
      status: "none",
      composePath: paths.routesComposePath,
      routeCount: 0,
    };
  }
  const syncResult = await syncRemoteRouteBridgeStack({ paths, registry });
  if (syncResult.status === "failed") {
    return {
      status: "failed",
      composePath: paths.routesComposePath,
      routeCount: registry.routes.length,
      error: syncResult.error ?? "unknown_error",
    };
  }
  return {
    status: syncResult.status,
    composePath: paths.routesComposePath,
    routeCount: registry.routes.length,
  };
}

/**
 * Stops the remote route bridge stack (best-effort) during global shutdown.
 */
export async function stopRemoteCaddyRoutesStack(): Promise<
  | {
      readonly status: "stopped" | "missing";
      readonly composePath: string;
    }
  | {
      readonly status: "failed";
      readonly composePath: string;
      readonly error: string;
    }
> {
  const paths = resolveRemoteRouteBridgePaths({ homeDir: resolveHomeDir() });
  if (!(await pathExists(paths.routesComposePath))) {
    return {
      status: "missing",
      composePath: paths.routesComposePath,
    };
  }
  const stopped = await exec(
    [
      "docker",
      "compose",
      "-f",
      paths.routesComposePath,
      "down",
      "--remove-orphans",
    ],
    {
      cwd: dirname(paths.routesComposePath),
      stdin: "ignore",
    }
  );
  if (stopped.exitCode !== 0) {
    const message = [stopped.stderr.trim(), stopped.stdout.trim()]
      .filter((entry) => entry.length > 0)
      .join(" | ");
    return {
      status: "failed",
      composePath: paths.routesComposePath,
      error: message.length > 0 ? message : "docker_compose_failed",
    };
  }
  return {
    status: "stopped",
    composePath: paths.routesComposePath,
  };
}

/**
 * Reads persisted controller-side remote route bridge state without mutating it.
 */
export async function readRemoteCaddyRoutesState(): Promise<RemoteCaddyRouteBridgeState> {
  const paths = resolveRemoteRouteBridgePaths({ homeDir: resolveHomeDir() });
  const registry = await readRemoteRouteRegistry({
    registryPath: paths.routesRegistryPath,
  });
  const [caddyComposeExists, routesComposeExists, routesRegistryExists] =
    await Promise.all([
      pathExists(paths.caddyComposePath),
      pathExists(paths.routesComposePath),
      pathExists(paths.routesRegistryPath),
    ]);
  return {
    caddyDir: paths.caddyDir,
    caddyComposePath: paths.caddyComposePath,
    routesComposePath: paths.routesComposePath,
    routesRegistryPath: paths.routesRegistryPath,
    caddyComposeExists,
    routesComposeExists,
    routesRegistryExists,
    routes: registry.routes,
  };
}

/**
 * Extracts route hosts from `.hack/docker-compose.yml` caddy labels.
 * Falls back to `<project>.hack` when compose labels are absent.
 */
export async function resolveProjectHostsForBridge(input: {
  readonly projectDir?: string;
  readonly fallbackProjectHost?: string;
}): Promise<readonly string[]> {
  const hosts = new Set<string>();
  if (input.projectDir) {
    const composePath = resolve(input.projectDir, PROJECT_COMPOSE_FILENAME);
    const composeText = await readTextFile(composePath);
    if (composeText) {
      for (const host of extractCaddyHostsFromCompose({ composeText })) {
        hosts.add(host);
      }
    }
  }
  const fallbackHost = normalizeHost({
    rawHost: input.fallbackProjectHost
      ? `${input.fallbackProjectHost}.hack`
      : null,
  });
  if (fallbackHost) {
    hosts.add(fallbackHost);
  }
  return Array.from(hosts).sort((left, right) => left.localeCompare(right));
}

/**
 * Resolves a bridge upstream target from node metadata.
 * Prefers SSH source host when present; falls back to gateway endpoint host.
 */
export function resolveRemoteCaddyUpstream(input: {
  readonly endpoint: string;
  readonly source?: string;
}): string | null {
  const sourceHost = extractNodeSourceHost({ source: input.source });
  if (sourceHost) {
    return `http://${sourceHost}:${REMOTE_CADDY_UPSTREAM_PORT}`;
  }
  const endpointHost = extractEndpointHost({ endpoint: input.endpoint });
  if (!endpointHost) {
    return null;
  }
  return `http://${endpointHost}:${REMOTE_CADDY_UPSTREAM_PORT}`;
}

export function extractCaddyHostsFromCompose(input: {
  readonly composeText: string;
}): readonly string[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(input.composeText);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const services = parsed.services;
  if (!isRecord(services)) {
    return [];
  }

  const hosts = new Set<string>();
  for (const service of Object.values(services)) {
    if (!isRecord(service)) {
      continue;
    }
    const labels = normalizeComposeLabels({ raw: service.labels });
    if (!labels) {
      continue;
    }
    const caddy = labels.caddy;
    if (typeof caddy !== "string") {
      continue;
    }
    for (const host of extractCaddyHostsFromLabel({ value: caddy })) {
      hosts.add(host);
    }
  }
  return Array.from(hosts).sort((left, right) => left.localeCompare(right));
}

function resolveRemoteRouteBridgePaths(input: {
  readonly homeDir: string;
}): RemoteRouteBridgePaths {
  const hackRoot = resolve(input.homeDir, GLOBAL_HACK_DIR_NAME);
  const caddyDir = resolve(hackRoot, GLOBAL_CADDY_DIR_NAME);
  return {
    caddyDir,
    caddyComposePath: resolve(caddyDir, GLOBAL_CADDY_COMPOSE_FILENAME),
    routesComposePath: resolve(
      caddyDir,
      GLOBAL_CADDY_REMOTE_ROUTES_COMPOSE_FILENAME
    ),
    routesRegistryPath: resolve(
      caddyDir,
      GLOBAL_CADDY_REMOTE_ROUTES_REGISTRY_FILENAME
    ),
  };
}

async function readRemoteRouteRegistry(input: {
  readonly registryPath: string;
}): Promise<RemoteRouteRegistry> {
  const text = await readTextFile(input.registryPath);
  if (!text) {
    return {
      version: REMOTE_ROUTE_REGISTRY_VERSION,
      routes: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      version: REMOTE_ROUTE_REGISTRY_VERSION,
      routes: [],
    };
  }
  if (!isRecord(parsed)) {
    return {
      version: REMOTE_ROUTE_REGISTRY_VERSION,
      routes: [],
    };
  }
  const version = parsed.version;
  const routesRaw = parsed.routes;
  if (version !== REMOTE_ROUTE_REGISTRY_VERSION || !Array.isArray(routesRaw)) {
    return {
      version: REMOTE_ROUTE_REGISTRY_VERSION,
      routes: [],
    };
  }
  const routes: RemoteRouteRegistryRecord[] = [];
  for (const entry of routesRaw) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const projectKey =
      typeof entry.projectKey === "string" ? entry.projectKey.trim() : "";
    const host = typeof entry.host === "string" ? entry.host.trim() : "";
    const upstream =
      typeof entry.upstream === "string" ? entry.upstream.trim() : "";
    const nodeId = typeof entry.nodeId === "string" ? entry.nodeId.trim() : "";
    const updatedAt =
      typeof entry.updatedAt === "string" ? entry.updatedAt.trim() : "";
    if (!(id && projectKey && host && upstream && nodeId && updatedAt)) {
      continue;
    }
    routes.push({
      id,
      projectKey,
      host,
      upstream,
      nodeId,
      updatedAt,
    });
  }
  return {
    version: REMOTE_ROUTE_REGISTRY_VERSION,
    routes,
  };
}

function upsertRemoteRouteRegistryEntries(input: {
  readonly registry: RemoteRouteRegistry;
  readonly projectKey: string;
  readonly nodeId: string;
  readonly hosts: readonly string[];
  readonly upstream: string;
  readonly updatedAt: string;
}): RemoteRouteRegistry {
  const projectKey = input.projectKey.trim();
  const filtered = input.registry.routes.filter(
    (entry) => entry.projectKey !== projectKey
  );
  const routes = [...filtered];
  for (const host of input.hosts) {
    routes.push({
      id: `${projectKey}:${host}`,
      projectKey,
      host,
      upstream: input.upstream,
      nodeId: input.nodeId,
      updatedAt: input.updatedAt,
    });
  }
  routes.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: REMOTE_ROUTE_REGISTRY_VERSION,
    routes,
  };
}

function renderRemoteRouteCompose(input: {
  readonly routes: readonly RemoteRouteRegistryRecord[];
}): string {
  const services: Record<string, unknown> = {};
  for (const route of input.routes) {
    const serviceKey = buildRemoteRouteServiceKey({ routeId: route.id });
    services[serviceKey] = {
      image: "alpine:3.20",
      command: ["sh", "-c", "while true; do sleep 3600; done"],
      restart: "unless-stopped",
      labels: {
        caddy: route.host,
        "caddy.reverse_proxy": route.upstream,
        "caddy.tls": "internal",
      },
      networks: [DEFAULT_INGRESS_NETWORK],
    };
  }
  const compose = {
    name: GLOBAL_CADDY_REMOTE_ROUTES_PROJECT_NAME,
    services,
    networks: {
      [DEFAULT_INGRESS_NETWORK]: {
        external: true,
      },
    },
  };
  return `${YAML.stringify(compose, null, 2).trimEnd()}\n`;
}

async function syncRemoteRouteBridgeStack(input: {
  readonly paths: RemoteRouteBridgePaths;
  readonly registry: RemoteRouteRegistry;
}): Promise<SyncRemoteRoutesResult> {
  if (!(await pathExists(input.paths.caddyComposePath))) {
    return {
      status: "saved",
      reason: "saved_pending_global_caddy",
    };
  }
  const command =
    input.registry.routes.length > 0
      ? [
          "docker",
          "compose",
          "-f",
          input.paths.routesComposePath,
          "up",
          "-d",
          "--remove-orphans",
        ]
      : [
          "docker",
          "compose",
          "-f",
          input.paths.routesComposePath,
          "down",
          "--remove-orphans",
        ];
  const applied = await exec(command, {
    cwd: dirname(input.paths.routesComposePath),
    stdin: "ignore",
  });
  if (applied.exitCode !== 0) {
    const message = [applied.stderr.trim(), applied.stdout.trim()]
      .filter((entry) => entry.length > 0)
      .join(" | ");
    return {
      status: "failed",
      reason: "apply_failed",
      error: message.length > 0 ? message : "docker_compose_failed",
    };
  }
  return {
    status: "applied",
    reason: "applied",
  };
}

function normalizeComposeLabels(input: {
  readonly raw: unknown;
}): Record<string, string> | null {
  const raw = input.raw;
  if (isRecord(raw)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        out[key] = String(value);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const index = entry.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = entry.slice(0, index).trim();
    if (!key) {
      continue;
    }
    out[key] = entry.slice(index + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function extractCaddyHostsFromLabel(input: {
  readonly value: string;
}): readonly string[] {
  const hosts: string[] = [];
  for (const part of input.value.split(",")) {
    const normalized = normalizeHost({ rawHost: part });
    if (normalized) {
      hosts.push(normalized);
    }
  }
  return hosts;
}

function normalizeHost(input: {
  readonly rawHost: string | null;
}): string | null {
  if (!input.rawHost) {
    return null;
  }
  let host = input.rawHost.trim();
  if (!host) {
    return null;
  }
  if (host.startsWith("http://")) {
    host = host.slice("http://".length);
  }
  if (host.startsWith("https://")) {
    host = host.slice("https://".length);
  }
  const slashIndex = host.indexOf("/");
  if (slashIndex >= 0) {
    host = host.slice(0, slashIndex);
  }
  if (
    host.length === 0 ||
    host.includes("*") ||
    host.includes("{") ||
    host.includes("}") ||
    host.includes("$")
  ) {
    return null;
  }
  if (host.includes(":")) {
    return null;
  }
  return host;
}

function extractNodeSourceHost(input: {
  readonly source?: string;
}): string | null {
  const source = (input.source ?? "").trim();
  if (!source) {
    return null;
  }
  const withoutScheme = source.startsWith("ssh://")
    ? source.slice("ssh://".length)
    : source;
  const target = withoutScheme.includes("@")
    ? withoutScheme.slice(withoutScheme.indexOf("@") + 1)
    : withoutScheme;
  if (!target) {
    return null;
  }
  const bracketed = BRACKETED_HOST_PATTERN.exec(target);
  if (bracketed) {
    return bracketed[1]?.trim() || null;
  }
  const hostWithPort = HOST_WITH_PORT_PATTERN.exec(target);
  if (hostWithPort) {
    return hostWithPort[1]?.trim() || null;
  }
  return target.trim() || null;
}

function extractEndpointHost(input: {
  readonly endpoint: string;
}): string | null {
  try {
    const parsed = new URL(input.endpoint);
    return parsed.hostname.trim() || null;
  } catch {
    return null;
  }
}

function buildRemoteRouteServiceKey(input: {
  readonly routeId: string;
}): string {
  const digest = createHash("sha1")
    .update(input.routeId)
    .digest("hex")
    .slice(0, 10);
  const slug = sanitizeProjectSlug(input.routeId).slice(0, 32);
  return `route-${slug}-${digest}`;
}

function resolveHomeDir(): string {
  const homeDir = process.env.HOME?.trim();
  if (!homeDir) {
    throw new Error("HOME is not set");
  }
  return homeDir;
}
