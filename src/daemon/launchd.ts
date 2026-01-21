import { homedir } from "node:os";
import { dirname } from "node:path";

import { DAEMON_LAUNCHD_LABEL } from "../constants.ts";
import type { DaemonLaunchdConfig } from "../control-plane/sdk/config.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import type { DaemonPaths } from "./paths.ts";

export interface LaunchdPlistOptions {
  readonly hackBinPath: string;
  readonly home: string;
  readonly runAtLoad: boolean;
  readonly guiSessionOnly: boolean;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * Generates the launchd plist XML for hackd.
 */
export function renderLaunchdPlist(opts: LaunchdPlistOptions): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${DAEMON_LAUNCHD_LABEL}</string>`,
    "",
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${opts.hackBinPath}</string>`,
    "    <string>daemon</string>",
    "    <string>start</string>",
    "    <string>--foreground</string>",
    "  </array>",
    "",
    "  <key>RunAtLoad</key>",
    `  <${opts.runAtLoad}/>`,
    "",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "",
    "  <key>StandardOutPath</key>",
    `  <string>${opts.stdoutPath}</string>`,
    "",
    "  <key>StandardErrorPath</key>",
    `  <string>${opts.stderrPath}</string>`,
    "",
    "  <key>WorkingDirectory</key>",
    `  <string>${opts.home}</string>`,
    "",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    <string>${opts.home}</string>`,
    "    <key>PATH</key>",
    `    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${opts.home}/.bun/bin:${opts.home}/.hack/bin</string>`,
    "  </dict>",
  ];

  if (opts.guiSessionOnly) {
    lines.push(
      "",
      "  <key>LimitLoadToSessionType</key>",
      "  <string>Aqua</string>"
    );
  }

  lines.push("</dict>", "</plist>", "");

  return lines.join("\n");
}

export interface LaunchdInstallResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly alreadyInstalled?: boolean;
}

/**
 * Installs the launchd plist and bootstraps the service.
 */
export async function installLaunchdService({
  paths,
  config,
}: {
  readonly paths: DaemonPaths;
  readonly config: DaemonLaunchdConfig;
}): Promise<LaunchdInstallResult> {
  if (process.platform !== "darwin") {
    return { ok: false, error: "launchd is only available on macOS" };
  }

  const invocation = await resolveHackInvocation();
  const hackBinPath = invocation.bin;
  const home = process.env.HOME ?? homedir();

  const plistContent = renderLaunchdPlist({
    hackBinPath,
    home,
    runAtLoad: config.runAtLoad,
    guiSessionOnly: config.guiSessionOnly,
    stdoutPath: paths.launchdStdoutPath,
    stderrPath: paths.launchdStderrPath,
  });

  await ensureDir(dirname(paths.launchdPlistPath));
  await ensureDir(paths.root);

  const existingPlist = await readTextFile(paths.launchdPlistPath);
  if (existingPlist !== null) {
    if (existingPlist === plistContent) {
      return { ok: true, alreadyInstalled: true };
    }
    const unloadResult = await unloadLaunchdService();
    if (!(unloadResult.ok || unloadResult.notLoaded)) {
      return {
        ok: false,
        error: `Failed to unload existing service: ${unloadResult.error}`,
      };
    }
  }

  await writeTextFile(paths.launchdPlistPath, plistContent);

  const loadResult = await loadLaunchdService({
    plistPath: paths.launchdPlistPath,
  });
  if (!loadResult.ok) {
    return { ok: false, error: `Failed to load service: ${loadResult.error}` };
  }

  return { ok: true };
}

export interface LaunchdUninstallResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly notInstalled?: boolean;
}

/**
 * Uninstalls the launchd service and removes the plist.
 */
export async function uninstallLaunchdService({
  paths,
}: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdUninstallResult> {
  if (process.platform !== "darwin") {
    return { ok: false, error: "launchd is only available on macOS" };
  }

  const plistExists = await pathExists(paths.launchdPlistPath);
  if (!plistExists) {
    return { ok: true, notInstalled: true };
  }

  const unloadResult = await unloadLaunchdService();
  if (!(unloadResult.ok || unloadResult.notLoaded)) {
    return {
      ok: false,
      error: `Failed to unload service: ${unloadResult.error}`,
    };
  }

  try {
    await Bun.file(paths.launchdPlistPath).delete();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to remove plist: ${message}` };
  }

  return { ok: true };
}

interface LaunchctlResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly notLoaded?: boolean;
}

async function loadLaunchdService({
  plistPath,
}: {
  readonly plistPath: string;
}): Promise<LaunchctlResult> {
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;

  const proc = Bun.spawn(["launchctl", "bootstrap", domain, plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return { ok: true };
  }

  const stderr = await new Response(proc.stderr).text();
  if (
    stderr.includes("already loaded") ||
    stderr.includes("service already loaded")
  ) {
    return { ok: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}

async function unloadLaunchdService(): Promise<LaunchctlResult> {
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${DAEMON_LAUNCHD_LABEL}`;

  const proc = Bun.spawn(["launchctl", "bootout", serviceTarget], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return { ok: true };
  }

  const stderr = await new Response(proc.stderr).text();
  if (
    stderr.includes("Could not find specified service") ||
    stderr.includes("No such process") ||
    stderr.includes("not loaded")
  ) {
    return { ok: true, notLoaded: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}

export interface LaunchdServiceStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly exitStatus: number | null;
}

/**
 * Gets the current status of the launchd service.
 */
export async function getLaunchdServiceStatus({
  paths,
}: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdServiceStatus> {
  if (process.platform !== "darwin") {
    return {
      installed: false,
      loaded: false,
      running: false,
      pid: null,
      exitStatus: null,
    };
  }

  const plistExists = await pathExists(paths.launchdPlistPath);
  if (!plistExists) {
    return {
      installed: false,
      loaded: false,
      running: false,
      pid: null,
      exitStatus: null,
    };
  }

  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${DAEMON_LAUNCHD_LABEL}`;

  const proc = Bun.spawn(["launchctl", "print", serviceTarget], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    return {
      installed: true,
      loaded: false,
      running: false,
      pid: null,
      exitStatus: null,
    };
  }

  const stdout = await new Response(proc.stdout).text();

  const pidMatch = stdout.match(/pid\s*=\s*(\d+)/i);
  const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : null;

  const stateMatch = stdout.match(/state\s*=\s*(\w+)/i);
  const state = stateMatch?.[1]?.toLowerCase() ?? null;
  const running = state === "running" || (pid !== null && pid > 0);

  const exitStatusMatch = stdout.match(/last exit code\s*=\s*(-?\d+)/i);
  const exitStatus = exitStatusMatch?.[1]
    ? Number.parseInt(exitStatusMatch[1], 10)
    : null;

  return {
    installed: true,
    loaded: true,
    running,
    pid,
    exitStatus,
  };
}

/**
 * Kicks the launchd service to start it.
 */
export async function kickstartLaunchdService(): Promise<LaunchctlResult> {
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${DAEMON_LAUNCHD_LABEL}`;

  const proc = Bun.spawn(["launchctl", "kickstart", "-k", serviceTarget], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return { ok: true };
  }

  const stderr = await new Response(proc.stderr).text();
  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}

/**
 * Stops the launchd service by sending SIGTERM.
 */
export async function stopLaunchdService(): Promise<LaunchctlResult> {
  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${DAEMON_LAUNCHD_LABEL}`;

  const proc = Bun.spawn(["launchctl", "kill", "SIGTERM", serviceTarget], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return { ok: true };
  }

  const stderr = await new Response(proc.stderr).text();
  if (stderr.includes("No such process") || stderr.includes("not running")) {
    return { ok: true, notLoaded: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}
