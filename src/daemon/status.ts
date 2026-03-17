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
    nextStep: "hack daemon start",
  };
}
