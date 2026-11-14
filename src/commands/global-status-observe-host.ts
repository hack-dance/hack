/**
 * Real boundaries for `hack global status --observe` (HACK-2218, R13). Each
 * keeps "could not read" apart from "read and found": a read that fails,
 * times out or cannot be parsed is `"unknown"`, never `false` or missing.
 * Docker reads are bounded and read-only; nothing is started.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ProxyContainerState,
  parseProxyContainerInspect,
} from "../lib/global-proxy-network.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { exec } from "../lib/shell.ts";
import {
  inspectProxyNetwork,
  proxyNetworkStatusPayload,
} from "./global-proxy-network.ts";
import type { Tri } from "./global-status-observe.ts";

/** Bound for each Docker read after the initial `docker info` probe. */
export const DOCKER_READ_TIMEOUT_MS = 5000;

export function isServiceRunning(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("running") || normalized.includes("up");
}

/**
 * Docker `--format json` output, strictly: empty output is no records; one
 * JSON array or object, or one object per line; anything else (a line that
 * does not parse, a value that is not an object) is null, so a partly
 * readable answer is never taken as a complete one.
 */
export function strictJsonRecords(
  text: string
): readonly Record<string, unknown>[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const whole = tryParse(trimmed);
  if (Array.isArray(whole)) {
    return whole.every(isRecord) ? whole : null;
  }
  if (isRecord(whole)) {
    return [whole];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const value = tryParse(line.trim());
    if (!isRecord(value)) {
      return null;
    }
    records.push(value);
  }
  return records;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A file's text, or whether it is confirmed missing or could not be read. */
export async function readFileOutcome(
  path: string
): Promise<{ readonly text: string } | "missing" | "unknown"> {
  try {
    return { text: await readFile(path, "utf8") };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

export type ComposeObservation = {
  readonly ok: Tri;
  readonly error: string | null;
  readonly services: readonly {
    readonly service: string;
    readonly name: string;
    readonly status: string;
    readonly ports: string;
  }[];
};

/**
 * A global stack: not installed (`false`) only when its Compose file is
 * confirmed missing; otherwise Docker's bounded `compose ps`, and unknown
 * when that does not answer.
 */
export async function observeComposeStack(opts: {
  readonly composeFile: string;
}): Promise<ComposeObservation> {
  const file = await readFileOutcome(opts.composeFile);
  if (file === "missing") {
    return {
      ok: false,
      error: `Missing ${opts.composeFile} (run: hack global install)`,
      services: [],
    };
  }
  if (file === "unknown") {
    return {
      ok: "unknown",
      error: `Could not read ${opts.composeFile}`,
      services: [],
    };
  }
  const res = await exec(
    ["docker", "compose", "-f", opts.composeFile, "ps", "--format", "json"],
    {
      cwd: dirname(opts.composeFile),
      stdin: "ignore",
      timeoutMs: DOCKER_READ_TIMEOUT_MS,
    }
  ).catch(() => null);
  if (res === null || res.exitCode !== 0) {
    return {
      ok: "unknown",
      error: `docker compose ps did not answer for ${opts.composeFile}`,
      services: [],
    };
  }
  const rows = strictJsonRecords(res.stdout);
  if (
    rows === null ||
    rows.some(
      (row) => typeof row.Service !== "string" || typeof row.Status !== "string"
    )
  ) {
    return {
      ok: "unknown",
      error: `docker compose ps gave output that could not be read for ${opts.composeFile}`,
      services: [],
    };
  }
  const services = rows.map((entry) => ({
    service: getString(entry, "Service") ?? "",
    name: getString(entry, "Name") ?? "",
    status: getString(entry, "Status") ?? "",
    ports: getString(entry, "Ports") ?? "",
  }));
  return {
    ok:
      services.length > 0 &&
      services.every((service) => isServiceRunning(service.status)),
    error: null,
    services,
  };
}

export type NetworksObservation = {
  readonly ok: Tri;
  readonly error: string | null;
  readonly missing: readonly string[];
  readonly networks: readonly {
    readonly name: string;
    readonly id: string;
    readonly driver: string;
    readonly scope: string;
  }[];
};

/** Hack's networks from a bounded `docker network ls`; unknown if it fails. */
export async function observeNetworks(opts: {
  readonly names: readonly string[];
}): Promise<NetworksObservation> {
  const res = await exec(["docker", "network", "ls", "--format", "json"], {
    stdin: "ignore",
    timeoutMs: DOCKER_READ_TIMEOUT_MS,
  }).catch(() => null);
  if (res === null || res.exitCode !== 0) {
    return {
      ok: "unknown",
      error: "docker network ls did not answer",
      missing: [],
      networks: [],
    };
  }
  const rows = strictJsonRecords(res.stdout);
  if (rows === null || rows.some((row) => typeof row.Name !== "string")) {
    return {
      ok: "unknown",
      error: "docker network ls gave output that could not be read",
      missing: [],
      networks: [],
    };
  }
  const networks = rows
    .map((entry) => ({
      name: getString(entry, "Name") ?? "",
      id: getString(entry, "ID") ?? "",
      driver: getString(entry, "Driver") ?? "",
      scope: getString(entry, "Scope") ?? "",
    }))
    .filter(
      (entry) => entry.name.length > 0 && opts.names.includes(entry.name)
    );
  const present = new Set(networks.map((network) => network.name));
  const missing = opts.names.filter((name) => !present.has(name));
  return { ok: missing.length === 0, error: null, missing, networks };
}

export type ProxyObservation = {
  readonly ok: Tri;
  readonly readable: boolean;
  readonly error?: string;
  readonly issues: readonly unknown[];
};

/**
 * The proxy containers' network addresses: not installed (`false`) only
 * when the Caddy Compose file is confirmed missing; unknown when the file or
 * Docker cannot be read (the container reader is itself bounded).
 */
export async function observeProxyNetwork(opts: {
  readonly composeFile: string;
}): Promise<ProxyObservation> {
  const file = await readFileOutcome(opts.composeFile);
  if (file === "missing") {
    return {
      ok: false,
      readable: false,
      issues: [],
      error: `Missing ${opts.composeFile} (run: hack global install)`,
    };
  }
  if (file === "unknown") {
    return {
      ok: "unknown",
      readable: false,
      issues: [],
      error: `Could not read ${opts.composeFile}`,
    };
  }
  const payload = proxyNetworkStatusPayload(
    await inspectProxyNetwork({
      composeFile: opts.composeFile,
      readContainers: async () => {
        const containers = await readProxyContainersStrictly(opts.composeFile);
        return containers === "unknown" ? null : containers;
      },
    }).catch(() => null)
  );
  return { ...payload, ok: payload.ok === null ? "unknown" : payload.ok };
}

/**
 * The proxy stack's containers for an observe-only read: the same bounded
 * `compose ps` and `docker inspect` as the proxy repair path, but any output
 * that cannot be fully read (a malformed line, a row without an id, an
 * inspect answer that is not one object per id) is "unknown" rather than an
 * empty, healthy stack.
 */
async function readProxyContainersStrictly(
  composeFile: string
): Promise<readonly ProxyContainerState[] | "unknown"> {
  const ps = await exec(
    ["docker", "compose", "-f", composeFile, "ps", "--format", "json"],
    {
      cwd: dirname(composeFile),
      stdin: "ignore",
      timeoutMs: DOCKER_READ_TIMEOUT_MS,
    }
  ).catch(() => null);
  if (ps === null || ps.exitCode !== 0) {
    return "unknown";
  }
  const rows = strictJsonRecords(ps.stdout);
  if (rows === null) {
    return "unknown";
  }
  const ids = rows.map((row) => getString(row, "ID"));
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    return "unknown";
  }
  if (ids.length === 0) {
    return [];
  }
  const inspect = await exec(["docker", "inspect", ...(ids as string[])], {
    stdin: "ignore",
    timeoutMs: DOCKER_READ_TIMEOUT_MS,
  }).catch(() => null);
  if (inspect === null || inspect.exitCode !== 0) {
    return "unknown";
  }
  const parsed = tryParse(inspect.stdout.trim());
  if (
    !Array.isArray(parsed) ||
    parsed.length !== ids.length ||
    !parsed.every(isCompleteContainerRecord)
  ) {
    return "unknown";
  }
  return parseProxyContainerInspect(inspect.stdout);
}

const PROXY_SERVICES = new Set(["caddy", "coredns"]);

/**
 * Whether an inspect record carries what the proxy assessment reads: its
 * Compose service label and, for a proxy service, its State flags and its
 * network map with a string address for every endpoint. A record of another service is complete with its label; one
 * that cannot be classified or assessed is not.
 */
function isCompleteContainerRecord(record: unknown): boolean {
  if (!isRecord(record)) {
    return false;
  }
  const config = record.Config;
  const labels = isRecord(config) ? config.Labels : undefined;
  const service = isRecord(labels)
    ? labels["com.docker.compose.service"]
    : undefined;
  if (typeof service !== "string") {
    return false;
  }
  if (!PROXY_SERVICES.has(service)) {
    return true;
  }
  const state = record.State;
  const settings = record.NetworkSettings;
  return (
    isRecord(state) &&
    typeof state.Running === "boolean" &&
    typeof state.Restarting === "boolean" &&
    typeof state.Paused === "boolean" &&
    isRecord(settings) &&
    isRecord(settings.Networks) &&
    // Every endpoint the assessment reads must carry a string address
    // (Docker reports "" for one without an IPv4 address); an empty map is
    // a confirmed "on no network".
    Object.values(settings.Networks).every(
      (endpoint) => isRecord(endpoint) && typeof endpoint.IPAddress === "string"
    )
  );
}
