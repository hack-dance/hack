/**
 * Real boundaries for `hack global status --observe` (HACK-2218, R13). Each
 * keeps "could not read" apart from "read and found": a read that fails,
 * times out or cannot be parsed is `"unknown"`, never `false` or missing.
 * Docker reads are bounded and read-only; nothing is started.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getString } from "../lib/guards.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
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
  const services = parseJsonLines(res.stdout).map((entry) => ({
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
  const networks = parseJsonLines(res.stdout)
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
    await inspectProxyNetwork({ composeFile: opts.composeFile }).catch(
      () => null
    )
  );
  return { ...payload, ok: payload.ok === null ? "unknown" : payload.ok };
}
