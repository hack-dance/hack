import { homedir } from "node:os"
import { resolve } from "node:path"

import {
  DAEMON_LAUNCHD_PLIST_FILENAME,
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_DAEMON_LOG_FILENAME,
  GLOBAL_DAEMON_PID_FILENAME,
  GLOBAL_DAEMON_SOCKET_FILENAME,
  GLOBAL_HACK_DIR_NAME
} from "../constants.ts"

export interface DaemonPaths {
  readonly root: string
  readonly socketPath: string
  readonly pidPath: string
  readonly logPath: string
  readonly launchdPlistPath: string
  readonly launchdStdoutPath: string
  readonly launchdStderrPath: string
}

export function resolveDaemonPaths({ home }: { readonly home?: string }): DaemonPaths {
  const baseHome = (home ?? process.env.HOME ?? homedir()).trim()
  const root = resolve(baseHome, GLOBAL_HACK_DIR_NAME, GLOBAL_DAEMON_DIR_NAME)
  const launchAgentsDir = resolve(baseHome, "Library", "LaunchAgents")
  return {
    root,
    socketPath: resolve(root, GLOBAL_DAEMON_SOCKET_FILENAME),
    pidPath: resolve(root, GLOBAL_DAEMON_PID_FILENAME),
    logPath: resolve(root, GLOBAL_DAEMON_LOG_FILENAME),
    launchdPlistPath: resolve(launchAgentsDir, DAEMON_LAUNCHD_PLIST_FILENAME),
    launchdStdoutPath: resolve(root, "hackd.stdout.log"),
    launchdStderrPath: resolve(root, "hackd.stderr.log")
  }
}
