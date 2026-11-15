import { resolve } from "node:path";
import { resolveSystemdSummary } from "../commands/daemon-systemd.ts";
import { collectProjectNativePreflight } from "../commands/doctor-native-preflight.ts";
import { inspectLinuxGlobalDns } from "../commands/global-linux-dns.ts";
import {
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CADDY_PROJECT_NAME,
} from "../constants.ts";
import { getLaunchdServiceStatus } from "../daemon/launchd.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { summarizeLaunchdService } from "../daemon/service-summary.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { pathExists } from "./fs.ts";
import type { LinuxDnsInspection } from "./linux-dns-setup.ts";
import {
  inspectProxyLoopback,
  type ProxyLoopbackReport,
} from "./proxy-loopback.ts";
import { detectHackInstall } from "./self-update.ts";
import { exec } from "./shell.ts";

/**
 * The host probes `hack upgrade check` uses (HACK-2189). Every probe is
 * read-only: it reads files or runs a read-only command with a time limit,
 * and never starts Docker, the daemon or a service, prompts, or writes.
 * Tests replace them; the project checks run against real files.
 */
export type UpgradeCheckProbes = {
  /** True for the refusing stand-ins; the report is then incomplete. */
  readonly disabled?: boolean;
  /** The first `hack` on PATH: where it is, how it was installed, its version. */
  readonly pathHack: () => Promise<PathHackProbe>;
  /** Who runs hackd and whether a login service is registered. */
  readonly daemon: () => Promise<DaemonProbe>;
  /** Whether the Docker engine answers. */
  readonly docker: () => Promise<"reachable" | "unreachable" | "missing">;
  /** Hack's global proxy files and containers. */
  readonly globalInfra: (opts: {
    readonly docker: "reachable" | "unreachable" | "missing";
  }) => Promise<GlobalInfraProbe>;
  /** Linux only: the DNS route on Hack's bridge; null elsewhere. */
  readonly linuxDns: () => Promise<LinuxDnsInspection | null>;
  /** The loopback proxy ports check (doctor's `proxy ports`). */
  readonly proxyPorts: () => Promise<ProxyLoopbackReport>;
  /** Apple Silicon only: the in-process native preflight for one project. */
  readonly nativePreflight: (opts: {
    readonly projectRoot: string;
  }) => Promise<NativePreflightProbe | null>;
};

export type PathHackProbe = {
  readonly path: string | null;
  readonly install: string;
  readonly version: string | null;
};

export type DaemonProbe = {
  /** `systemd`, `launchd`, or null on a host with neither. */
  readonly manager: "systemd" | "launchd" | null;
  /** A login service is registered (unit or plist installed). */
  readonly registered: boolean;
  /** The service is enabled to start at login; null when unknown. */
  readonly enabled: boolean | null;
  /** hackd is running (its pid file names a live process). */
  readonly running: boolean;
  /** The service manager runs that hackd. */
  readonly managed: boolean;
  readonly summary: string;
  readonly severity: "ok" | "warn";
  readonly nextStep: string | null;
};

export type GlobalInfraProbe = {
  /** `hack global install` has written the proxy files. */
  readonly installed: boolean;
  /** The proxy containers run; null when it was not established. */
  readonly running: boolean | null;
  /** True when Docker answered but listing the containers failed or timed out. */
  readonly listFailed?: boolean;
};

export type NativePreflightProbe = {
  /** Configuration blockers only; runtime setup and admission are not inspected. */
  readonly ready: boolean;
  readonly blockers: number;
  readonly warnings: number;
};

const COMMAND_TIMEOUT_MS = 5000;
const WHITESPACE = /\s+/u;

/**
 * Hard deny: when set to `1`, no host probe runs (Docker, the Linux
 * resolver, service managers, the `hack` on PATH, native preflight); each
 * of their checks reports "not checked", never a pass. The test preload sets
 * it, so tests never read the host.
 */
export const HOST_PROBES_DISABLE_ENV = "HACK_HOST_PROBES_DISABLE";

const disabled = (): Promise<never> =>
  Promise.reject(new Error("Host probes are disabled."));

/** The real probes, or refusing stand-ins under {@link HOST_PROBES_DISABLE_ENV}. */
export function defaultUpgradeCheckProbes(
  opts: { readonly env?: Readonly<Record<string, string | undefined>> } = {}
): UpgradeCheckProbes {
  const env = opts.env ?? process.env;
  if ((env[HOST_PROBES_DISABLE_ENV] ?? "").trim() === "1") {
    return {
      disabled: true,
      pathHack: disabled,
      daemon: disabled,
      docker: () => Promise.resolve("unreachable" as const),
      globalInfra: disabled,
      linuxDns: disabled,
      proxyPorts: disabled,
      // Reported once, as the report-level host-probes finding.
      nativePreflight: () => Promise.resolve(null),
    };
  }
  return {
    pathHack: probePathHack,
    daemon: probeDaemon,
    docker: probeDocker,
    globalInfra: probeGlobalInfra,
    linuxDns: async () =>
      process.platform === "linux" ? await inspectLinuxGlobalDns() : null,
    proxyPorts: async () => await inspectProxyLoopback(),
    nativePreflight: probeNativePreflight,
  };
}

async function probePathHack(): Promise<PathHackProbe> {
  const path = Bun.which("hack");
  if (path === null) {
    return { path: null, install: "missing", version: null };
  }
  const install = await detectHackInstall({ path });
  const kind = install.status === "present" ? install.kind : install.status;
  const result = await exec([path, "--version"], {
    stdin: "ignore",
    timeoutMs: COMMAND_TIMEOUT_MS,
  }).catch(() => null);
  const version =
    result !== null && result.exitCode === 0
      ? (result.stdout.trim().split(WHITESPACE).at(-1) ?? null)
      : null;
  return { path, install: kind, version };
}

async function probeDaemon(): Promise<DaemonProbe> {
  const paths = resolveDaemonPaths({});
  const daemon = await readDaemonStatus({ paths });
  if (process.platform === "linux") {
    const summary = await resolveSystemdSummary({ paths });
    if (summary !== null) {
      return {
        manager: "systemd",
        registered: summary.installed,
        enabled: summary.enabled,
        running: daemon.running,
        managed: summary.ownsDaemon,
        summary: summary.summary,
        severity: summary.severity === "warn" ? "warn" : "ok",
        nextStep: summary.nextStep,
      };
    }
  }
  if (process.platform === "darwin") {
    const status = await getLaunchdServiceStatus({ paths });
    const summary = summarizeLaunchdService({
      status,
      daemonPid: daemon.pid,
      daemonRunning: daemon.running,
    });
    return {
      manager: "launchd",
      registered: status.installed,
      enabled: status.installed ? status.loaded : null,
      running: daemon.running,
      managed: summary.ownsDaemon,
      summary: summary.summary,
      severity: summary.severity === "warn" ? "warn" : "ok",
      nextStep: summary.nextStep,
    };
  }
  return {
    manager: null,
    registered: false,
    enabled: null,
    running: daemon.running,
    managed: false,
    summary: "no login service manager on this host",
    severity: "ok",
    nextStep: null,
  };
}

async function probeDocker(): Promise<"reachable" | "unreachable" | "missing"> {
  if (Bun.which("docker") === null) {
    return "missing";
  }
  const result = await exec(
    ["docker", "info", "--format", "{{.ServerVersion}}"],
    {
      stdin: "ignore",
      timeoutMs: COMMAND_TIMEOUT_MS,
    }
  ).catch(() => null);
  return result !== null && result.exitCode === 0 ? "reachable" : "unreachable";
}

async function probeGlobalInfra(opts: {
  readonly docker: "reachable" | "unreachable" | "missing";
}): Promise<GlobalInfraProbe> {
  const installed = await pathExists(
    resolve(
      resolveGlobalHackDir(),
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    )
  );
  if (opts.docker !== "reachable") {
    return { installed, running: null };
  }
  const result = await exec(
    [
      "docker",
      "ps",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME}`,
      "--format",
      "{{.State}}",
    ],
    { stdin: "ignore", timeoutMs: COMMAND_TIMEOUT_MS }
  ).catch(() => null);
  if (result === null || result.exitCode !== 0) {
    return { installed, running: null, listFailed: true };
  }
  const states = result.stdout.split("\n").filter((line) => line.trim() !== "");
  return {
    installed,
    running:
      states.length > 0 && states.every((state) => state.trim() === "running"),
  };
}

async function probeNativePreflight(opts: {
  readonly projectRoot: string;
}): Promise<NativePreflightProbe | null> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return null;
  }
  const report = await collectProjectNativePreflight({
    startDir: opts.projectRoot,
    profiles: [],
    runtimeReview: false,
  });
  return {
    ready: report.blockers.length === 0,
    blockers: report.blockers.length,
    warnings: report.warnings.length,
  };
}
