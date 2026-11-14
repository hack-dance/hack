/**
 * `hack global status --json --observe` (HACK-2218, R13): routing, DNS and
 * proxy state for pollers (scripts, agents, the desktop app) that must never
 * start anything.
 *
 * Contract: this module never starts Docker, a container, `hackd`, a VM or a
 * service, and never prompts. It runs only the read-only probes listed in
 * `OBSERVE_PROBES` (docs/global-status-observe.md), each bounded by a
 * timeout. Docker is asked once (`docker info`); when that does not answer,
 * nothing else is asked of Docker and every Docker-derived part is
 * `"unknown"`. "Unknown" is never reported as absent or as a failure of the
 * thing itself.
 */
import {
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
} from "../constants.ts";
import type { LinuxDnsInspection } from "../lib/linux-dns-setup.ts";
import type { ExecResult } from "../lib/shell.ts";
import type { CheckResult } from "./global-mac-dns.ts";

export const OBSERVE_STATUS_SCHEMA = "hack.global-status.observe.v1";

/** A yes/no answer, or "unknown" when it could not be determined. */
export type Tri = true | false | "unknown";

/** How long Hack waits for `docker info` before calling Docker unknown. */
export const DOCKER_PROBE_TIMEOUT_MS = 3000;

type ComposeGroup = {
  readonly ok: boolean;
  readonly error: string | null;
  readonly services: readonly unknown[];
};

type NetworksGroup = {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly networks: readonly unknown[];
};

type ProxyNetworkPayload = {
  readonly ok: boolean | null;
  readonly readable: boolean;
  readonly issues: readonly unknown[];
  readonly error?: string;
};

/** Everything the observer reads, injected so tests replace each boundary. */
export type ObserveDeps = {
  readonly platform: NodeJS.Platform;
  readonly dockerInstalled: () => boolean;
  /** `docker info`, bounded by {@link DOCKER_PROBE_TIMEOUT_MS}. */
  readonly probeDocker: () => Promise<ExecResult>;
  /** Only called when Docker answered. */
  readonly readCaddy: () => Promise<ComposeGroup>;
  readonly readLogging: () => Promise<ComposeGroup>;
  readonly readNetworks: () => Promise<NetworksGroup>;
  readonly readProxyNetwork: () => Promise<ProxyNetworkPayload>;
  readonly caddyIp: () => Promise<string | null>;
  readonly inspectLinuxDns: () => Promise<LinuxDnsInspection>;
  readonly macResolver: (domain: string) => Promise<CheckResult>;
  readonly macDnsmasqConfig: (
    domain: string,
    opts: { readonly caddyIp: () => Promise<string | null> }
  ) => Promise<CheckResult>;
  readonly macDnsmasqPort53: () => Promise<CheckResult>;
  readonly now: () => Date;
};

type DockerState = "running" | "not_running" | "not_installed" | "unknown";

/** The macOS routed suffixes `hack doctor` checks. */
const MAC_DOMAINS = [
  DEFAULT_PROJECT_TLD,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
] as const;

export async function observeGlobalStatus(deps: ObserveDeps) {
  const docker = await observeDocker(deps);
  const dockerUp = docker.state === "running";
  const [caddy, logging, networks, proxyNetwork, hostDns] = await Promise.all([
    dockerUp
      ? deps.readCaddy().then(composeTri, () => unknownGroup(READ_FAILED))
      : Promise.resolve(unknownGroup(unknownReason(docker))),
    dockerUp
      ? deps.readLogging().then(composeTri, () => unknownGroup(READ_FAILED))
      : Promise.resolve(unknownGroup(unknownReason(docker))),
    dockerUp
      ? deps
          .readNetworks()
          .then(networksTri, () => unknownNetworks(READ_FAILED))
      : Promise.resolve(unknownNetworks(unknownReason(docker))),
    dockerUp
      ? deps.readProxyNetwork().then(proxyTri, () => unknownProxy(READ_FAILED))
      : Promise.resolve(unknownProxy(unknownReason(docker))),
    observeHostDns({
      deps,
      // A dynamic Caddy address can only come from a running Docker.
      caddyIp: dockerUp ? deps.caddyIp : async () => null,
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

/** A read that threw: its part is unknown, never a failure of the thing. */
const READ_FAILED = "Docker answered, but this part could not be read";

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

function composeTri(group: ComposeGroup) {
  return { ...group, ok: group.ok as Tri };
}

function unknownGroup(reason: string) {
  return {
    ok: "unknown" as Tri,
    error: reason,
    services: [] as readonly unknown[],
  };
}

function networksTri(group: NetworksGroup) {
  return { ...group, ok: group.ok as Tri };
}

function unknownNetworks(reason: string) {
  return {
    ok: "unknown" as Tri,
    error: reason,
    missing: [] as readonly string[],
    networks: [] as readonly unknown[],
  };
}

function proxyTri(payload: ProxyNetworkPayload) {
  return {
    ...payload,
    ok: (payload.ok === null ? "unknown" : payload.ok) as Tri,
  };
}

function unknownProxy(reason: string) {
  return {
    ok: "unknown" as Tri,
    readable: false,
    error: reason,
    issues: [] as readonly unknown[],
  };
}

/**
 * Host DNS for Hack's routed suffixes. Linux: the systemd-resolved route
 * (`configured` is yes; a state Hack does not manage is unknown). macOS: the
 * resolver files, dnsmasq lines and an answer from 127.0.0.1:53, as `hack
 * doctor` checks them. Elsewhere: unknown.
 */
async function observeHostDns(opts: {
  readonly deps: ObserveDeps;
  readonly caddyIp: () => Promise<string | null>;
}) {
  const { deps } = opts;
  if (deps.platform === "linux") {
    const inspection = await deps.inspectLinuxDns().catch(() => null);
    if (inspection === null) {
      return {
        platform: "linux",
        state: "unknown",
        ok: "unknown" as Tri,
        message: "The Linux DNS route could not be inspected",
      } as const;
    }
    return {
      platform: "linux",
      resolver: inspection.resolver.kind,
      state: inspection.state,
      ok: linuxDnsOk(inspection.state),
      code: inspection.code,
      link: inspection.link,
      message: inspection.message,
      fix: inspection.fix,
    } as const;
  }
  if (deps.platform === "darwin") {
    const checks = await Promise.all([
      ...MAC_DOMAINS.map((domain) => deps.macResolver(domain)),
      ...MAC_DOMAINS.map((domain) =>
        deps.macDnsmasqConfig(domain, { caddyIp: opts.caddyIp })
      ),
      deps.macDnsmasqPort53(),
    ]).catch(() => null);
    if (checks === null) {
      return {
        platform: "darwin",
        state: "unknown",
        ok: "unknown" as Tri,
        checks: [] as readonly CheckResult[],
      } as const;
    }
    const ok = macDnsOk(checks);
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
 * judged from here, so unknown; every other state is a route that is not in
 * place.
 */
function linuxDnsOk(state: LinuxDnsInspection["state"]): Tri {
  if (state === "configured") {
    return true;
  }
  return state === "manual" ? "unknown" : false;
}

function macDnsState(ok: Tri): "configured" | "not_configured" | "unknown" {
  if (ok === "unknown") {
    return "unknown";
  }
  return ok ? "configured" : "not_configured";
}

/** A check that could not look (no Homebrew to locate dnsmasq.conf) is unknown. */
function macDnsOk(checks: readonly CheckResult[]): Tri {
  if (checks.every((check) => check.status === "ok")) {
    return true;
  }
  const couldNotLook = (check: CheckResult) =>
    check.status !== "ok" && check.message.startsWith("Homebrew not found");
  if (checks.some((check) => check.status !== "ok" && !couldNotLook(check))) {
    return false;
  }
  return "unknown";
}

/** false if any part is false; otherwise unknown if any is; otherwise true. */
function allOk(values: readonly Tri[]): Tri {
  if (values.includes(false)) {
    return false;
  }
  return values.includes("unknown") ? "unknown" : true;
}
