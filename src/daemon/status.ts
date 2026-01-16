import { pathExists } from "../lib/fs.ts"
import { isProcessRunning, readDaemonPid } from "./process.ts"

import type { DaemonPaths } from "./paths.ts"

export interface DaemonStatus {
  readonly running: boolean
  readonly pid: number | null
  readonly socketExists: boolean
  readonly logExists: boolean
}

export type DaemonStatusLabel = "running" | "starting" | "stale" | "stopped"
export type DaemonStaleReason = "pid_not_running" | "socket_only" | null

export interface DaemonStatusReport {
  readonly status: DaemonStatusLabel
  readonly running: boolean
  readonly apiOk: boolean
  readonly processRunning: boolean
  readonly pid: number | null
  readonly socketExists: boolean
  readonly logExists: boolean
  readonly stale: boolean
  readonly staleReason: DaemonStaleReason
}

export async function readDaemonStatus({
  paths
}: {
  readonly paths: DaemonPaths
}): Promise<DaemonStatus> {
  const pid = await readDaemonPid({ pidPath: paths.pidPath })
  const socketExists = await pathExists(paths.socketPath)
  const logExists = await pathExists(paths.logPath)
  const running = pid !== null && isProcessRunning({ pid })

  return {
    running,
    pid,
    socketExists,
    logExists
  }
}

export function buildDaemonStatusReport(opts: {
  readonly pid: number | null
  readonly processRunning: boolean
  readonly socketExists: boolean
  readonly logExists: boolean
  readonly apiOk: boolean
}): DaemonStatusReport {
  if (opts.apiOk) {
    return {
      status: "running",
      running: opts.processRunning,
      apiOk: true,
      processRunning: opts.processRunning,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: false,
      staleReason: null
    }
  }

  if (opts.processRunning) {
    return {
      status: "starting",
      running: true,
      apiOk: false,
      processRunning: true,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: false,
      staleReason: null
    }
  }

  if (opts.pid !== null) {
    return {
      status: "stale",
      running: false,
      apiOk: false,
      processRunning: false,
      pid: opts.pid,
      socketExists: opts.socketExists,
      logExists: opts.logExists,
      stale: true,
      staleReason: "pid_not_running"
    }
  }

  if (opts.socketExists) {
    return {
      status: "stale",
      running: false,
      apiOk: false,
      processRunning: false,
      pid: null,
      socketExists: true,
      logExists: opts.logExists,
      stale: true,
      staleReason: "socket_only"
    }
  }

  return {
    status: "stopped",
    running: false,
    apiOk: false,
    processRunning: false,
    pid: null,
    socketExists: false,
    logExists: opts.logExists,
    stale: false,
    staleReason: null
  }
}
