/**
 * `hack global status --json --observe` (HACK-2218, R13): routing, DNS and
 * proxy state for pollers (scripts, agents, the desktop app) that must never
 * start anything.
 *
 * Contract: this module never starts Docker, a container, `hackd`, a VM or a
 * service, and never prompts. It runs only the read-only probes listed in
 * docs/reference/global-status-observe.md, each bounded by a timeout. Docker
 * is asked first (`docker info`); when that does not answer, nothing else is
 * asked of Docker and every Docker-derived part is `"unknown"`. Each
 * boundary (global-status-observe-host.ts, the macOS and Linux DNS readers)
 * keeps "could not read" apart from "read and found", so unknown is never
 * reported as absent or as a failure of the thing.
 */
import type { LinuxDnsInspection } from "../lib/linux-dns-setup.ts";
import { MACHINE_SCHEMAS } from "../lib/machine-output.ts";
import type { ExecResult } from "../lib/shell.ts";
import type { ObservedCheck } from "./global-mac-dns.ts";
import type {
  ComposeObservation,
  NetworksObservation,
  ProxyObservation,
} from "./global-status-observe-host.ts";

export const OBSERVE_STATUS_SCHEMA = MACHINE_SCHEMAS.globalStatusObserve;

/** A yes/no answer, or "unknown" when it could not be determined. */
export type Tri = true | false | "unknown";

/** How long Hack waits for `docker info` before calling Docker unknown. */
export const DOCKER_PROBE_TIMEOUT_MS = 3000;

/** Everything the observer reads, injected so tests replace each boundary. */
export type ObserveDeps = {
  readonly platform: NodeJS.Platform;
  readonly dockerInstalled: () => boolean;
  /** `docker info`, bounded by {@link DOCKER_PROBE_TIMEOUT_MS}. */
  readonly probeDocker: () => Promise<ExecResult>;
  /** Only called when Docker answered. */
  readonly readCaddy: () => Promise<ComposeObservation>;
  readonly readLogging: () => Promise<ComposeObservation>;
  readonly readNetworks: () => Promise<NetworksObservation>;
  readonly readProxyNetwork: () => Promise<ProxyObservation>;
  /** Caddy's address; null when Docker confirms none, "unknown" otherwise. */
  readonly caddyIp: () => Promise<string | null | "unknown">;
  /** The Linux route, and every read it rested on that failed. */
  readonly inspectLinuxDns: () => Promise<{
    readonly inspection: LinuxDnsInspection;
    readonly unreadable: readonly string[];
  }>;
  /**
   * The suffixes Hack routes on macOS: the built-ins and the configured
   * default domain (as `hack global install` sets them up). Throws when the
   * configuration cannot be read.
   */
  readonly macDomains: () => Promise<readonly string[]>;
  readonly observeMacDns: (opts: {
    readonly domains: readonly string[];
    readonly caddyIp: () => Promise<string | null | "unknown">;
  }) => Promise<readonly ObservedCheck[]>;
  readonly now: () => Date;
};

type DockerState = "running" | "not_running" | "not_installed" | "unknown";

/** A read that threw: its part is unknown, never a failure of the thing. */
const READ_FAILED = "This part could not be read";

export async function observeGlobalStatus(deps: ObserveDeps) {
  const docker = await observeDocker(deps);
  const dockerUp = docker.state === "running";
  const reason = unknownReason(docker);
  const [caddy, logging, networks, proxyNetwork, hostDns] = await Promise.all([
    dockerUp
      ? deps.readCaddy().catch(() => unknownCompose(READ_FAILED))
      : Promise.resolve(unknownCompose(reason)),
    dockerUp
      ? deps.readLogging().catch(() => unknownCompose(READ_FAILED))
      : Promise.resolve(unknownCompose(reason)),
    dockerUp
      ? deps.readNetworks().catch(() => unknownNetworks(READ_FAILED))
      : Promise.resolve(unknownNetworks(reason)),
    dockerUp
      ? deps.readProxyNetwork().catch(() => unknownProxy(READ_FAILED))
      : Promise.resolve(unknownProxy(reason)),
    observeHostDns({
      deps,
      // A dynamic Caddy address can only come from a running Docker.
      caddyIp: dockerUp
        ? async () => await deps.caddyIp().catch(() => "unknown" as const)
        : async () => await Promise.resolve("unknown" as const),
    }),
  ]);
  const summary = {
    docker_ok: dockerOk(docker.state),
    caddy_ok: caddy.ok,
    logging_ok: logging.ok,
    networks_ok: networks.ok,
    proxy_network_ok: proxyNetwork.ok,
    host_dns_ok: hostDns.ok,
  };
  return {
    schema: OBSERVE_STATUS_SCHEMA,
    generated_at: deps.now().toISOString(),
    observe: true,
    platform: deps.platform,
    docker,
    caddy,
    logging,
    networks,
    proxy_network: proxyNetwork,
    host_dns: hostDns,
    summary: { ...summary, ok: allOk(Object.values(summary)) },
  } as const;
}

async function observeDocker(deps: ObserveDeps): Promise<{
  readonly state: DockerState;
  readonly detail: string | null;
}> {
  if (!deps.dockerInstalled()) {
    return { state: "not_installed", detail: "docker is not on PATH" };
  }
  const result = await deps.probeDocker().catch(() => null);
  // exec reports a timeout as exit 124 (and stops the probe).
  if (result === null || result.exitCode === 124) {
    return {
      state: "unknown",
      detail: `docker info did not answer within ${DOCKER_PROBE_TIMEOUT_MS / 1000} s`,
    };
  }
  if (result.exitCode === 0) {
    return { state: "running", detail: null };
  }
  const firstLine = result.stderr.trim().split("\n")[0] ?? "";
  return {
    state: "not_running",
    detail:
      firstLine.length > 0
        ? firstLine
        : `docker info exited ${result.exitCode}`,
  };
}

function dockerOk(state: DockerState): Tri {
  if (state === "running") {
    return true;
  }
  return state === "unknown" ? "unknown" : false;
}

function unknownReason(docker: { readonly state: DockerState }): string {
  switch (docker.state) {
    case "not_installed":
      return "Docker is not installed";
    case "not_running":
      return "Docker is not running (not started: this is an observe-only read)";
    default:
      return "Docker did not answer in time";
  }
}

function unknownCompose(reason: string): ComposeObservation {
  return { ok: "unknown", error: reason, services: [] };
}

function unknownNetworks(reason: string): NetworksObservation {
  return { ok: "unknown", error: reason, missing: [], networks: [] };
}

function unknownProxy(reason: string): ProxyObservation {
  return { ok: "unknown", readable: false, error: reason, issues: [] };
}

/**
 * Host DNS for Hack's routed suffixes. Linux: the systemd-resolved route
 * (`configured` is yes; a resolver Hack does not manage, or an answer that
 * rests on a failed read, is unknown). macOS: for each routed suffix (the
 * built-ins and the configured default domain), the resolver file and the
 * dnsmasq line, and an answer from 127.0.0.1:53. Elsewhere: unknown.
 */
async function observeHostDns(opts: {
  readonly deps: ObserveDeps;
  readonly caddyIp: () => Promise<string | null | "unknown">;
}) {
  const { deps } = opts;
  if (deps.platform === "linux") {
    const read = await deps.inspectLinuxDns().catch(() => null);
    if (read === null) {
      return {
        platform: "linux",
        state: "unknown",
        ok: "unknown" as Tri,
        message: "The Linux DNS route could not be inspected",
      } as const;
    }
    const { inspection, unreadable } = read;
    return {
      platform: "linux",
      resolver: inspection.resolver.kind,
      state: inspection.state,
      ok: linuxDnsOk({ state: inspection.state, unreadable }),
      code: inspection.code,
      link: inspection.link,
      message: inspection.message,
      fix: inspection.fix,
      unreadable,
    } as const;
  }
  if (deps.platform === "darwin") {
    const domains = await deps.macDomains().catch(() => null);
    const checks =
      domains === null
        ? null
        : await deps
            .observeMacDns({ domains, caddyIp: opts.caddyIp })
            .catch(() => null);
    if (checks === null) {
      return {
        platform: "darwin",
        state: "unknown",
        ok: "unknown" as Tri,
        checks: [] as readonly ObservedCheck[],
        ...(domains === null
          ? { message: "The configured default domain could not be read" }
          : {}),
      } as const;
    }
    const ok = allOk(checks.map((check) => checkOk(check)));
    return {
      platform: "darwin",
      state: macDnsState(ok),
      ok,
      checks,
    } as const;
  }
  return {
    platform: deps.platform,
    state: "unknown",
    ok: "unknown" as Tri,
    message: "Host DNS is not checked on this platform",
  } as const;
}

/**
 * `configured` is yes. `manual` (a resolver Hack does not manage) cannot be
 * judged from here, and neither can a state reached through a read that
 * failed: unknown. Every other state is a route that is not in place.
 */
function linuxDnsOk(opts: {
  readonly state: LinuxDnsInspection["state"];
  readonly unreadable: readonly string[];
}): Tri {
  if (opts.state === "configured") {
    return true;
  }
  if (opts.state === "manual" || opts.unreadable.length > 0) {
    return "unknown";
  }
  return false;
}

function checkOk(check: ObservedCheck): Tri {
  if (check.outcome === "unknown") {
    return "unknown";
  }
  return check.outcome === "ok";
}

function macDnsState(ok: Tri): "configured" | "not_configured" | "unknown" {
  if (ok === "unknown") {
    return "unknown";
  }
  return ok ? "configured" : "not_configured";
}

/** false if any part is false; otherwise unknown if any is; otherwise true. */
function allOk(values: readonly Tri[]): Tri {
  if (values.includes(false)) {
    return false;
  }
  return values.includes("unknown") ? "unknown" : true;
}
