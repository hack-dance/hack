import { pathExists } from "../lib/fs.ts"
import { isProcessRunning, readDaemonPid } from "./process.ts"

import type { DaemonPaths } from "./paths.ts"

export interface DaemonStatus {
  readonly running: boolean
  readonly pid: number | null
  readonly socketExists: boolean
  readonly logExists: boolean
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
