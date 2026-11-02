import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { DAEMON_LAUNCHD_LABEL, GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import type { DaemonLaunchdConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import type { DaemonPaths } from "./paths.ts";

const PID_PATTERN = /pid\s*=\s*(\d+)/i;
const STATE_PATTERN = /state\s*=\s*(\w+)/i;
const LAST_EXIT_CODE_PATTERN = /last exit code\s*=\s*(-?\d+)/i;

/**
 * Hard deny: when set to `1`, no launchd operation runs, whatever HACK_HOME
 * is. Test harnesses set it, so a regression in the HACK_HOME check below
 * still cannot reach the per-user launchd service.
 */
export const LAUNCHD_DISABLE_ENV = "HACK_LAUNCHD_DISABLE";

/**
 * Opt-in: when set to `1`, launchd management is allowed even though
 * HACK_HOME is not `$HOME/.hack`. {@link LAUNCHD_DISABLE_ENV} still wins.
 */
export const LAUNCHD_ALLOW_ISOLATED_ENV = "HACK_LAUNCHD_ALLOW_ISOLATED_HOME";

export type LaunchdAccessBlockReason = "disabled" | "isolated-hack-home";

export type LaunchdAccess =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: LaunchdAccessBlockReason;
      readonly message: string;
    };

/**
 * Decides whether this process may touch the hackd launchd service.
 *
 * The service is a per-user singleton: one label
 * (`gui/<uid>/dance.hack.hackd`) and one plist under
 * `$HOME/Library/LaunchAgents`, both outside HACK_HOME. A process with an
 * isolated HACK_HOME (tests, sandboxes, a second state root) does not own
 * that service. Installing, repairing, bootstrapping, kickstarting, stopping
 * or inspecting it from there acts on the real user's daemon and can point
 * its logs into the isolated directory (HACK-1313).
 *
 * Invariant: launchd is allowed only when HACK_HOME is unset or blank,
 * resolves to `$HOME/.hack`, or {@link LAUNCHD_ALLOW_ISOLATED_ENV} opts in;
 * and never when {@link LAUNCHD_DISABLE_ENV} is set. Paths are compared after
 * `resolve`, not `realpath`: a symlinked alias of `~/.hack` counts as
 * isolated. That fails safe, because callers then start hackd directly.
 */
export function resolveLaunchdAccess(
  opts: { readonly env?: Readonly<Record<string, string | undefined>> } = {}
): LaunchdAccess {
  const env = opts.env ?? process.env;
  if ((env[LAUNCHD_DISABLE_ENV] ?? "").trim() === "1") {
    return {
      allowed: false,
      reason: "disabled",
      message: `launchd management is disabled by ${LAUNCHD_DISABLE_ENV}=1.`,
    };
  }
  const override = (env.HACK_HOME ?? "").trim();
  if (override.length === 0) {
    return { allowed: true };
  }
  const home = (env.HOME ?? homedir()).trim();
  if (resolve(override) === resolve(home, GLOBAL_HACK_DIR_NAME)) {
    return { allowed: true };
  }
  if ((env[LAUNCHD_ALLOW_ISOLATED_ENV] ?? "").trim() === "1") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "isolated-hack-home",
    message: `launchd management is disabled for an isolated HACK_HOME: the hackd launchd service belongs to $HOME/.hack. Set ${LAUNCHD_ALLOW_ISOLATED_ENV}=1 to manage it anyway.`,
  };
}

const NOT_INSTALLED_STATUS: LaunchdServiceStatus = {
  installed: false,
  loaded: false,
  running: false,
  pid: null,
  exitStatus: null,
};

type LaunchctlRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * The only place this module runs `launchctl`. It re-checks
 * {@link resolveLaunchdAccess}, so a caller that skips the check still
 * cannot reach the per-user service from an isolated HACK_HOME.
 */
async function runLaunchctl(args: readonly string[]): Promise<LaunchctlRun> {
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    return { exitCode: 1, stdout: "", stderr: access.message };
  }
  const proc = Bun.spawn(["launchctl", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

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
  /** Set when {@link resolveLaunchdAccess} refused; nothing was read or written. */
  readonly blocked?: LaunchdAccessBlockReason;
}

/**
 * Installs the launchd plist and bootstraps the service.
 *
 * Refuses, without touching the plist or launchctl, when
 * {@link resolveLaunchdAccess} denies access.
 */
export async function installLaunchdService({
  paths,
  config,
}: {
  readonly paths: DaemonPaths;
  readonly config: DaemonLaunchdConfig;
}): Promise<LaunchdInstallResult> {
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    return { ok: false, error: access.message, blocked: access.reason };
  }
  if (process.platform !== "darwin") {
    return { ok: false, error: "launchd is only available on macOS" };
  }

  const invocation = await resolveHackInvocation();
  const hackBinPath = await resolveLaunchdHackBinPath({ invocation });
  if (!hackBinPath) {
    return {
      ok: false,
      error: "Could not resolve hack binary path for launchd service",
    };
  }
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

/**
 * Resolve a stable absolute path to the hack executable for launchd.
 *
 * launchd should execute `hack` directly; writing `bun` here can break daemon
 * startup when Bun is unavailable in non-interactive PATH contexts.
 */
export async function resolveLaunchdHackBinPath(opts: {
  readonly invocation: {
    readonly bin: string;
    readonly args: readonly string[];
  };
  readonly findExecutable?: typeof findExecutableInPath;
  readonly exists?: typeof pathExists;
  readonly globalHackBinPath?: string;
  readonly argvPath?: string | null;
}): Promise<string | null> {
  const findExecutable = opts.findExecutable ?? findExecutableInPath;
  const exists = opts.exists ?? pathExists;

  // Prefer the executable selected for this invocation. A valid
  // ~/.hack/bin/hack may be an older local-development shim alongside a
  // newer Homebrew install; choosing that fallback first makes every daemon
  // restart downgrade hackd. Keep stable PATH/invocation locations ahead of
  // the global fallback, while still rejecting compiled Bun virtual paths.
  const candidates = [
    opts.invocation.args[0] ?? null,
    opts.invocation.bin,
    await findExecutable("hack"),
    opts.globalHackBinPath ?? resolve(resolveGlobalHackDir(), "bin", "hack"),
    opts.argvPath === undefined ? (process.argv[1] ?? null) : opts.argvPath,
  ];

  for (const raw of candidates) {
    const path = normalizeHackExecutablePath(raw);
    if (!path) {
      continue;
    }
    if (await exists(path)) {
      return path;
    }
  }
  return null;
}

function normalizeHackExecutablePath(raw: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (isVirtualExecutablePath(trimmed)) {
    return null;
  }
  const base = basename(trimmed).toLowerCase();
  if (!(base === "hack" || base.startsWith("hack-"))) {
    return null;
  }
  return trimmed;
}

/**
 * Paths inside a compiled Bun binary's virtual filesystem. They pass
 * pathExists from INSIDE the same process but no other process (launchd
 * included) can exec them.
 */
export function isVirtualExecutablePath(path: string): boolean {
  return path.startsWith("/$bunfs/") || path.includes("~BUN");
}

/**
 * Extracts ProgramArguments[0] from rendered launchd plist text.
 */
const PLIST_STRING_PATTERN = /<string>([^<]+)<\/string>/;

export function extractLaunchdProgramPath(opts: {
  readonly plistText: string;
}): string | null {
  const anchor = opts.plistText.indexOf("<key>ProgramArguments</key>");
  if (anchor < 0) {
    return null;
  }
  const match = opts.plistText.slice(anchor).match(PLIST_STRING_PATTERN);
  return match?.[1] ?? null;
}

export type LaunchdProgramRepairResult =
  | "ok"
  | "repaired"
  | "not-installed"
  | "failed";

/**
 * Repairs an installed launchd plist whose program path is invalid — a
 * compiled-binary virtual path (/$bunfs) or a binary that no longer exists
 * (e.g. an upgraded homebrew Cellar path). Broken plists leave launchd
 * flapping with exit status 78 and the daemon unable to stay up.
 *
 * Reports "not-installed" without reading the plist when
 * {@link resolveLaunchdAccess} denies access: this process does not own the
 * service, so it has nothing to repair.
 */
export async function repairLaunchdProgramIfInvalid(opts: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdProgramRepairResult> {
  if (!resolveLaunchdAccess().allowed) {
    return "not-installed";
  }
  const plistText = await readTextFile(opts.paths.launchdPlistPath);
  if (plistText === null) {
    return "not-installed";
  }
  const program = extractLaunchdProgramPath({ plistText });
  const invocation = await resolveHackInvocation();
  const resolved = await resolveLaunchdHackBinPath({ invocation });
  const exists =
    program !== null &&
    !isVirtualExecutablePath(program) &&
    (await pathExists(program));
  // A program that still exists can still be stale: a versioned homebrew
  // Cellar path survives until brew cleanup, so kickstart would relaunch
  // the OLD binary forever (incompatible-daemon loop). Normalize to the
  // current stable resolution whenever it differs.
  const valid = exists && (resolved === null || program === resolved);
  if (valid) {
    return "ok";
  }
  if (!exists && resolved === null) {
    return "failed";
  }

  const result = await installLaunchdService({
    paths: opts.paths,
    config: {
      installed: true,
      runAtLoad: plistText.includes("<key>RunAtLoad</key>\n  <true/>"),
      guiSessionOnly: plistText.includes("LimitLoadToSessionType"),
    },
  });
  return result.ok ? "repaired" : "failed";
}

export interface LaunchdUninstallResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly notInstalled?: boolean;
  /** Set when {@link resolveLaunchdAccess} refused; nothing was read or removed. */
  readonly blocked?: LaunchdAccessBlockReason;
}

/**
 * Uninstalls the launchd service and removes the plist.
 */
export async function uninstallLaunchdService({
  paths,
}: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdUninstallResult> {
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    return { ok: false, error: access.message, blocked: access.reason };
  }
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
  const { exitCode, stderr } = await runLaunchctl([
    "bootstrap",
    launchdDomain(),
    plistPath,
  ]);
  if (exitCode === 0) {
    return { ok: true };
  }

  if (
    stderr.includes("already loaded") ||
    stderr.includes("service already loaded")
  ) {
    return { ok: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

function launchdServiceTarget(): string {
  return `${launchdDomain()}/${DAEMON_LAUNCHD_LABEL}`;
}

async function unloadLaunchdService(): Promise<LaunchctlResult> {
  const { exitCode, stderr } = await runLaunchctl([
    "bootout",
    launchdServiceTarget(),
  ]);
  if (exitCode === 0) {
    return { ok: true };
  }

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
 *
 * Reports "not installed" without reading the plist or running launchctl
 * when {@link resolveLaunchdAccess} denies access. Callers then take their
 * non-launchd path, for example starting hackd directly under HACK_HOME.
 */
export async function getLaunchdServiceStatus({
  paths,
}: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdServiceStatus> {
  if (!resolveLaunchdAccess().allowed) {
    return NOT_INSTALLED_STATUS;
  }
  if (process.platform !== "darwin") {
    return NOT_INSTALLED_STATUS;
  }

  const plistExists = await pathExists(paths.launchdPlistPath);
  if (!plistExists) {
    return NOT_INSTALLED_STATUS;
  }

  const { exitCode, stdout } = await runLaunchctl([
    "print",
    launchdServiceTarget(),
  ]);
  if (exitCode !== 0) {
    return {
      installed: true,
      loaded: false,
      running: false,
      pid: null,
      exitStatus: null,
    };
  }

  const pidMatch = stdout.match(PID_PATTERN);
  const pid = pidMatch?.[1] ? Number.parseInt(pidMatch[1], 10) : null;

  const stateMatch = stdout.match(STATE_PATTERN);
  const state = stateMatch?.[1]?.toLowerCase() ?? null;
  const running = state === "running" || (pid !== null && pid > 0);

  const exitStatusMatch = stdout.match(LAST_EXIT_CODE_PATTERN);
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
  const { exitCode, stderr } = await runLaunchctl([
    "kickstart",
    "-k",
    launchdServiceTarget(),
  ]);
  if (exitCode === 0) {
    return { ok: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}

/**
 * Stops the launchd service by sending SIGTERM.
 */
export async function stopLaunchdService(): Promise<LaunchctlResult> {
  const { exitCode, stderr } = await runLaunchctl([
    "kill",
    "SIGTERM",
    launchdServiceTarget(),
  ]);
  if (exitCode === 0) {
    return { ok: true };
  }

  if (stderr.includes("No such process") || stderr.includes("not running")) {
    return { ok: true, notLoaded: true };
  }

  return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
}
