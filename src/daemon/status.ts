import { pathExists } from "../lib/fs.ts";
import type { DaemonPaths } from "./paths.ts";
import { isProcessRunning, readDaemonPid } from "./process.ts";

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid: number | null;
  readonly socketExists: boolean;
  readonly logExists: boolean;
}

export type DaemonStatusLabel =
  | "running"
  | "starting"
  | "incompatible"
  | "stale"
  | "stopped";
export type DaemonStaleReason = "pid_not_running" | "socket_only" | null;
export type DaemonStatusIssue = "incompatible" | "stale_state" | null;

export interface DaemonStatusReport {
  readonly status: DaemonStatusLabel;
  readonly running: boolean;
  readonly apiOk: boolean;
  readonly apiReachable: boolean;
  readonly apiCompatible: boolean;
  readonly processRunning: boolean;
  readonly pid: number | null;
  readonly socketExists: boolean;
  readonly logExists: boolean;
  readonly stale: boolean;
  readonly staleReason: DaemonStaleReason;
  readonly issue: DaemonStatusIssue;
  readonly nextStep: string | null;
}

type DaemonRepairLaunchdStatus = {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly exitStatus: number | null;
};

export async function readDaemonStatus({
  paths,
}: {
  readonly paths: DaemonPaths;
}): Promise<DaemonStatus> {
  const pid = await readDaemonPid({ pidPath: paths.pidPath });
  const socketExists = await pathExists(paths.socketPath);
  const logExists = await pathExists(paths.logPath);
  const running = pid !== null && isProcessRunning({ pid });

  return {
    running,
    pid,
    socketExists,
    logExists,
  };
}

export function buildDaemonStatusReport(opts: {
  readonly pid: number | null;
  readonly processRunning: boolean;
  readonly socketExists: boolean;
  readonly logExists: boolean;
  readonly apiReachable: boolean;
  readonly apiCompatible: boolean;
  /**
   * A service manager (launchd) has the daemon loaded but not running. The
   * next step is then `hack daemon restart`, so `status --json` and the text
   * repair message name the same command.
   */
  readonly serviceLoaded?: boolean;
}): DaemonStatusReport {
  if (opts.apiReachable && opts.apiCompatible) {
    return {
      status: "running",
      running: opts.processRunning,
      apiOk: true,
      apiReachable: true,
      apiCompatible: true,
      processRunning: opts.processRunning,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: false,
      staleReason: null,
      issue: null,
      nextStep: null,
    };
  }

  if (opts.apiReachable && !opts.apiCompatible) {
    return {
      status: "incompatible",
      running: opts.processRunning,
      apiOk: false,
      apiReachable: true,
      apiCompatible: false,
      processRunning: opts.processRunning,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: false,
      staleReason: null,
      issue: "incompatible",
      nextStep: "hack daemon restart",
    };
  }

  if (opts.processRunning) {
    return {
      status: "starting",
      running: true,
      apiOk: false,
      apiReachable: false,
      apiCompatible: false,
      processRunning: true,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: false,
      staleReason: null,
      issue: null,
      nextStep: "hack daemon logs",
    };
  }

  if (opts.pid !== null) {
    return {
      status: "stale",
      running: false,
      apiOk: false,
      apiReachable: false,
      apiCompatible: false,
      processRunning: false,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: true,
      staleReason: "pid_not_running",
      issue: "stale_state",
      nextStep: "hack daemon start",
    };
  }

  if (opts.socketExists) {
    return {
      status: "stale",
      running: false,
      apiOk: false,
      apiReachable: false,
      apiCompatible: false,
      processRunning: false,
      pid: null,
      socketExists: true,
      logExists: opts.logExists,
      stale: true,
      staleReason: "socket_only",
      issue: "stale_state",
      nextStep: "hack daemon start",
    };
  }

  return {
    status: "stopped",
    running: false,
    apiOk: false,
    apiReachable: false,
    apiCompatible: false,
    processRunning: false,
    pid: null,
    socketExists: false,
    logExists: opts.logExists,
    stale: false,
    staleReason: null,
    issue: null,
    nextStep: opts.serviceLoaded ? "hack daemon restart" : "hack daemon start",
  };
}

export function buildDaemonRepairMessage(opts: {
  readonly report: DaemonStatusReport;
  readonly launchdStatus: DaemonRepairLaunchdStatus | null;
  readonly dockerBackendName: string | null;
  readonly dockerReachable: boolean;
}): string {
  if (opts.report.status === "running") {
    return `hackd running (pid ${opts.report.pid ?? "unknown"})`;
  }

  if (opts.report.status === "starting") {
    return `hackd starting (pid ${
      opts.report.pid ?? "unknown"
    }): API not responding yet | If this persists, check: hack daemon logs --tail 200`;
  }

  // `report.nextStep` is the command `hack daemon status --json` reports as
  // `next_step`; the status command builds the report with `serviceLoaded`
  // from the same launchd status, so both name the same command.
  if (opts.report.stale) {
    return `hackd stopped with stale local state | Run: ${opts.report.nextStep ?? "hack daemon start"} (it clears the stale pid/socket files)`;
  }

  const crashExitStatus = opts.launchdStatus?.loaded
    ? opts.launchdStatus.exitStatus
    : null;
  const startCommand = opts.launchdStatus?.loaded
    ? "hack daemon restart"
    : (opts.report.nextStep ?? "hack daemon start");
  const segments = ["hackd is not running"];

  if (crashExitStatus !== null && crashExitStatus !== 0) {
    segments.push(`launchd last exit status ${crashExitStatus}`);
  }

  if (!opts.dockerReachable) {
    segments.push(
      buildDockerStartHint({ backendName: opts.dockerBackendName })
    );
  }

  segments.push(`Run: ${startCommand}`);

  if (crashExitStatus !== null && crashExitStatus !== 0) {
    segments.push("Then check: hack daemon logs --tail 200");
  }

  return segments.join(" | ");
}

function buildDockerStartHint(opts: {
  readonly backendName: string | null;
}): string {
  if (opts.backendName === "Docker Desktop") {
    return "Start Docker Desktop";
  }

  if (opts.backendName === "OrbStack") {
    return "Start OrbStack";
  }

  if (opts.backendName === "Docker (systemd)") {
    return "Start the Docker system service";
  }

  return "Start Docker";
}
