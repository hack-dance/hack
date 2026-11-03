import { resolve } from "node:path";

import {
  DAEMON_LAUNCHD_PLIST_FILENAME,
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_DAEMON_LOG_FILENAME,
  GLOBAL_DAEMON_PID_FILENAME,
  GLOBAL_DAEMON_SOCKET_FILENAME,
  GLOBAL_HACK_DIR_NAME,
} from "../constants.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";

export interface DaemonPaths {
  readonly root: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly logPath: string;
  readonly launchdPlistPath: string;
  readonly launchdStdoutPath: string;
  readonly launchdStderrPath: string;
}

export function resolveDaemonPaths({
  home,
}: {
  readonly home?: string;
}): DaemonPaths {
  const explicitHome = resolveExplicitHome({ home });
  const hackDir = explicitHome
    ? resolve(explicitHome, GLOBAL_HACK_DIR_NAME)
    : resolveGlobalHackDir();
  const root = resolve(hackDir, GLOBAL_DAEMON_DIR_NAME);
  return {
    root,
    socketPath: resolve(root, GLOBAL_DAEMON_SOCKET_FILENAME),
    pidPath: resolve(root, GLOBAL_DAEMON_PID_FILENAME),
    logPath: resolve(root, GLOBAL_DAEMON_LOG_FILENAME),
    // Resolved on access: daemon state only needs the hack dir (which an
    // absolute HACK_HOME supplies), so an unusable HOME must fail launchd
    // operations alone, not every daemon client.
    get launchdPlistPath() {
      const baseHome = explicitHome ?? resolveUserHomeDir();
      return resolve(
        baseHome,
        "Library",
        "LaunchAgents",
        DAEMON_LAUNCHD_PLIST_FILENAME
      );
    },
    launchdStdoutPath: resolve(root, "hackd.stdout.log"),
    launchdStderrPath: resolve(root, "hackd.stderr.log"),
  };
}

function resolveExplicitHome({
  home,
}: {
  readonly home: string | undefined;
}): string | null {
  if (home === undefined || home.trim().length === 0) {
    return null;
  }
  const normalized = normalizeHomeDir(home);
  if (!normalized) {
    throw new Error(
      `Daemon home must be an absolute path (got ${JSON.stringify(home)}).`
    );
  }
  return normalized;
}
