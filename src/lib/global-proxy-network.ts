/**
 * Detect global proxy containers (Caddy, CoreDNS) that Docker reports as
 * running but that are not usable on the ingress network: attached to no
 * network, not attached to `hack-dev`, or holding another address than the
 * reserved one. `docker compose up -d` leaves such a container alone (its
 * config hash is unchanged), and a project container can then take the
 * reserved address, so the reserved-IP conflict check alone cannot see it.
 *
 * Pure decisions plus one Docker read boundary; the repair (recreate the
 * proxy stack) lives with `hack global up`.
 */
import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_INGRESS_NETWORK,
} from "../constants.ts";
import { isRecord } from "./guards.ts";
import { parseJsonLines } from "./json-lines.ts";
import { exec } from "./shell.ts";

export type ProxyService = "caddy" | "coredns";

/** One running proxy container and the networks Docker says it is on. */
export type ProxyContainerState = {
  readonly service: ProxyService;
  readonly name: string;
  readonly running: boolean;
  /** Network name → IPv4 address ("" when Docker reports none). */
  readonly networks: Readonly<Record<string, string>>;
};

export type ProxyNetworkIssue = {
  readonly service: ProxyService;
  readonly name: string;
  readonly problem: "no_network" | "not_on_ingress" | "wrong_address";
  readonly expectedIp: string | null;
  readonly actualIp: string | null;
};

function isProxyService(value: unknown): value is ProxyService {
  return value === "caddy" || value === "coredns";
}

/** Reserved addresses rendered into the compose file (static-IP mode only). */
export function reservedProxyIps(
  composeText: string
): ReadonlyMap<ProxyService, string> {
  const ips = new Map<ProxyService, string>();
  if (composeText.includes(`ipv4_address: ${DEFAULT_CADDY_IP}`)) {
    ips.set("caddy", DEFAULT_CADDY_IP);
  }
  if (composeText.includes(`ipv4_address: ${DEFAULT_COREDNS_IP}`)) {
    ips.set("coredns", DEFAULT_COREDNS_IP);
  }
  return ips;
}

export function findProxyNetworkIssues(opts: {
  readonly containers: readonly ProxyContainerState[];
  readonly reservedIps: ReadonlyMap<ProxyService, string>;
  readonly network?: string;
}): readonly ProxyNetworkIssue[] {
  const network = opts.network ?? DEFAULT_INGRESS_NETWORK;
  const issues: ProxyNetworkIssue[] = [];
  for (const container of opts.containers) {
    if (!container.running) {
      continue;
    }
    const expectedIp = opts.reservedIps.get(container.service) ?? null;
    const base = {
      service: container.service,
      name: container.name,
      expectedIp,
    } as const;
    const names = Object.keys(container.networks);
    if (names.length === 0) {
      issues.push({ ...base, problem: "no_network", actualIp: null });
      continue;
    }
    const actualIp = container.networks[network];
    if (actualIp === undefined) {
      issues.push({ ...base, problem: "not_on_ingress", actualIp: null });
      continue;
    }
    if (expectedIp !== null && actualIp !== expectedIp) {
      issues.push({
        ...base,
        problem: "wrong_address",
        actualIp: actualIp || null,
      });
    }
  }
  return issues;
}

export function describeProxyNetworkIssue(issue: ProxyNetworkIssue): string {
  const expected = issue.expectedIp ? ` (expected ${issue.expectedIp})` : "";
  switch (issue.problem) {
    case "no_network":
      return `${issue.name} is running but attached to no network${expected}`;
    case "not_on_ingress":
      return `${issue.name} is running but not attached to ${DEFAULT_INGRESS_NETWORK}${expected}`;
    case "wrong_address":
      return `${issue.name} holds ${issue.actualIp ?? "no address"} on ${DEFAULT_INGRESS_NETWORK}${expected}`;
    default:
      return issue.name;
  }
}

const LEADING_SLASH = /^\//;

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Container networks as name → IPv4 address ("" when Docker reports none). */
function readNetworks(settings: unknown): Record<string, string> {
  const networks: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    readRecord(readRecord(settings).Networks)
  )) {
    const address = readRecord(value).IPAddress;
    networks[name] = typeof address === "string" ? address : "";
  }
  return networks;
}

function parseProxyContainerEntry(entry: unknown): ProxyContainerState | null {
  const record = readRecord(entry);
  const labels = readRecord(readRecord(record.Config).Labels);
  const service = labels["com.docker.compose.service"];
  if (!isProxyService(service)) {
    return null;
  }
  return {
    service,
    name:
      typeof record.Name === "string"
        ? record.Name.replace(LEADING_SLASH, "")
        : "",
    running: readRecord(record.State).Running === true,
    networks: readNetworks(record.NetworkSettings),
  };
}

/** Parse `docker inspect` JSON for the proxy containers. */
export function parseProxyContainerInspect(
  raw: string
): readonly ProxyContainerState[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map(parseProxyContainerEntry)
    .filter((state): state is ProxyContainerState => state !== null);
}

const DOCKER_TIMEOUT_MS = 5000;

/** Read the proxy stack's containers from Docker; `null` when unreadable. */
export async function readProxyContainers(opts: {
  readonly composeFile: string;
  readonly cwd: string;
}): Promise<readonly ProxyContainerState[] | null> {
  const ps = await exec(
    ["docker", "compose", "-f", opts.composeFile, "ps", "--format", "json"],
    { cwd: opts.cwd, stdin: "ignore", timeoutMs: DOCKER_TIMEOUT_MS }
  );
  if (ps.exitCode !== 0) {
    return null;
  }
  const ids = parseJsonLines(ps.stdout)
    .map((entry) => (isRecord(entry) ? entry.ID : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) {
    return [];
  }
  const inspect = await exec(["docker", "inspect", ...ids], {
    stdin: "ignore",
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  return inspect.exitCode === 0
    ? parseProxyContainerInspect(inspect.stdout)
    : null;
}
