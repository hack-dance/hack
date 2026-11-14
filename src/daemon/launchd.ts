import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { DAEMON_LAUNCHD_LABEL, GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import type { DaemonLaunchdConfig } from "../control-plane/sdk/config.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";
import { boundedTimeoutMs } from "../lib/process-deadline.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import { resolveExecutingCliPath } from "./executing-cli.ts";
import {
  parseLaunchdPlistEnvironment,
  parseLaunchdPlistProgram,
} from "./launchd-plist.ts";
import type { DaemonPaths } from "./paths.ts";
import { type DaemonProcessProof, proveOwnedDaemonProcess } from "./process.ts";

// biome-ignore lint/performance/noBarrelFile: keeps launchd's public surface in one module
export {
  type LaunchdPlistProgram,
  parseLaunchdPlistProgram,
} from "./launchd-plist.ts";

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
  // A home that is not absolute cannot own the service, so it never matches.
  const home = normalizeHomeDir(env.HOME) ?? normalizeHomeDir(homedir());
  if (home && resolve(override) === resolve(home, GLOBAL_HACK_DIR_NAME)) {
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
  // Within a process deadline (withProcessDeadline), never outlive it;
  // outside one, unchanged.
  const limitMs = boundedTimeoutMs();
  if (limitMs !== undefined && limitMs <= 0) {
    return {
      exitCode: 124,
      stdout: "",
      stderr: "launchctl not run: deadline passed",
    };
  }
  const proc = Bun.spawn(["launchctl", ...args], {
    env: childEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer =
    limitMs === undefined
      ? undefined
      : setTimeout(() => proc.kill("SIGKILL"), limitMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export interface LaunchdPlistOptions {
  readonly hackBinPath: string;
  readonly home: string;
  readonly runAtLoad: boolean;
  readonly guiSessionOnly: boolean;
}

/**
 * Marks a plist Hack wrote and may rewrite whole (HACK-2216). Plists from
 * earlier Hack versions lack it; see {@link isHackManagedPlist}.
 */
export const LAUNCHD_MANAGED_MARKER =
  "<!-- Managed by hack: written by hack daemon install; local changes are replaced on the next install. -->";

const PLIST_LABEL_PATTERN = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/;

/** The plist's `Label` string, or null when it has none. */
export function readLaunchdPlistLabel(opts: {
  readonly plistText: string;
}): string | null {
  return PLIST_LABEL_PATTERN.exec(opts.plistText)?.[1] ?? null;
}

/**
 * Whether Hack may rewrite the plist whole (owner decision, HACK-2216): it
 * carries {@link LAUNCHD_MANAGED_MARKER}, or its `Label` is Hack's own
 * ({@link DAEMON_LAUNCHD_LABEL}). Callers read it only from Hack's own
 * LaunchAgents path and rewrite it only when its program is this CLI's
 * executable or is gone, so a plist from an earlier Hack (no marker) is
 * still refreshed on upgrade. launchd has no drop-ins, so the systemd
 * header rule (HACK-2052) does not carry over; a plist that runs another
 * existing program is still left alone.
 */
export function isHackManagedPlist(opts: {
  readonly plistText: string;
}): boolean {
  return (
    opts.plistText.split("\n").includes(LAUNCHD_MANAGED_MARKER) ||
    readLaunchdPlistLabel(opts) === DAEMON_LAUNCHD_LABEL
  );
}

/**
 * Generates the launchd plist XML for hackd.
 */
export function renderLaunchdPlist(opts: LaunchdPlistOptions): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    LAUNCHD_MANAGED_MARKER,
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
    "  <string>/dev/null</string>",
    "",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
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
  hackBinPath: keepProgram,
}: {
  readonly paths: DaemonPaths;
  readonly config: DaemonLaunchdConfig;
  /**
   * The program to write, when a refresh keeps the plist's own path (a
   * link to this CLI stays a link). Defaults to this CLI's resolution.
   */
  readonly hackBinPath?: string;
}): Promise<LaunchdInstallResult> {
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    return { ok: false, error: access.message, blocked: access.reason };
  }
  if (process.platform !== "darwin") {
    return { ok: false, error: "launchd is only available on macOS" };
  }

  const hackBinPath =
    keepProgram ??
    (await resolveLaunchdHackBinPath({
      invocation: await resolveHackInvocation(),
    }));
  if (!hackBinPath) {
    return {
      ok: false,
      error: "Could not resolve hack binary path for launchd service",
    };
  }
  const home = resolveUserHomeDir();

  const plistContent = renderLaunchdPlist({
    hackBinPath,
    home,
    runAtLoad: config.runAtLoad,
    guiSessionOnly: config.guiSessionOnly,
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
 * Whether two paths name the same executable file: the same path, the same
 * resolved path, or the same device and inode (a hard link or a bind
 * mount). False when either cannot be read. A service whose program is
 * the same file as this CLI's runs this version; any other existing
 * program may be one the user chose (HACK-2216).
 */
export async function isSameExecutableFile(
  a: string,
  b: string
): Promise<boolean> {
  if (a === b) {
    return true;
  }
  try {
    const [realA, realB] = await Promise.all([realpath(a), realpath(b)]);
    if (realA === realB) {
      return true;
    }
    const [statA, statB] = await Promise.all([stat(realA), stat(realB)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
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
 * Whether a plist's program file exists, for deciding whether a retarget
 * is allowed (HACK-2216). `missing` only for ENOENT or ENOTDIR; any other
 * error (EACCES, EIO, ELOOP...) is `unknown`, which never authorizes an
 * automatic replacement. {@link pathExists} is not used here: it reports
 * every error as absence.
 */
export async function classifyLaunchdProgramPath(opts: {
  readonly path: string;
  /** Defaults to `fs.stat`; tests inject errors. */
  readonly stat?: (path: string) => Promise<unknown>;
}): Promise<"exists" | "missing" | "unknown"> {
  try {
    await (opts.stat ?? stat)(opts.path);
    return "exists";
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

/**
 * The program launchd runs (see {@link parseLaunchdPlistProgram}), or null
 * when there is none or it cannot be read.
 */
export function extractLaunchdProgramPath(opts: {
  readonly plistText: string;
}): string | null {
  const parsed = parseLaunchdPlistProgram(opts);
  return parsed.kind === "path" ? parsed.path : null;
}

/** launchd holds output descriptors open, so rename rotation cannot bound them.
 * Keep diagnostics in the daemon's capped log instead of duplicating stderr.
 */
export function hasBoundedLaunchdOutput(opts: {
  readonly plistText: string;
}): boolean {
  return ["StandardOutPath", "StandardErrorPath"].every((key) =>
    opts.plistText.includes(`<key>${key}</key>\n  <string>/dev/null</string>`)
  );
}

/**
 * `repaired`: the program path was invalid or stale and was replaced;
 * `refreshed`: the program was current but the rest of the plist (its
 * environment, output paths or other keys) differed from what this CLI
 * renders, and the plist was rewritten (HACK-2216);
 * `other-program`: it runs another existing program, left as it is;
 * `unmanaged`: it runs this CLI's executable and differs only in content,
 * but is not Hack's ({@link isHackManagedPlist}: no marker and another
 * `Label`), so it was left as it is;
 * `unknown-program`: its program cannot be read, left as it is;
 * `home-binding`: a rewrite was needed, but the plist binds another Hack
 * home (`HACK_HOME`, or a `HOME` the renderer would not write), left as it
 * is ({@link plistKeepsThisHome});
 * `unproven-owner`: a rewrite was needed, but the loaded job is not proven
 * to be this home's ({@link proveLaunchdJobOwnership}), or hackd runs and
 * the executing CLI cannot be shown to be what the plist will run (a source
 * invocation), left as it is;
 * `retarget-refused`: the program is gone, but the `hack` it would be
 * retargeted to is not fit for a login service
 * ({@link checkLaunchdRetargetTarget}), left as it is;
 * `failed`: a rewrite was needed but did not complete (unload, write or
 * load failed, or no installable hack resolves); the service may be
 * stopped.
 */
export type LaunchdProgramRepairResult =
  | "ok"
  | "repaired"
  | "refreshed"
  | "other-program"
  | "unknown-program"
  | "home-binding"
  | "unproven-owner"
  | "retarget-refused"
  | "unmanaged"
  | "not-installed"
  | "failed";

/** The install options an existing plist was rendered with. */
export function readLaunchdPlistOptions(opts: {
  readonly plistText: string;
}): Pick<LaunchdPlistOptions, "runAtLoad" | "guiSessionOnly"> {
  return {
    runAtLoad: opts.plistText.includes("<key>RunAtLoad</key>\n  <true/>"),
    guiSessionOnly: opts.plistText.includes("LimitLoadToSessionType"),
  };
}

/**
 * Whether an installed plist is exactly what this CLI renders for the same
 * program, home and install options. Any other difference (an environment
 * entry added or removed by an upgrade, unbounded output paths) is stale.
 */
export function isLaunchdPlistCurrent(opts: {
  readonly plistText: string;
  readonly hackBinPath: string;
  readonly home: string;
}): boolean {
  return (
    opts.plistText ===
    renderLaunchdPlist({
      hackBinPath: opts.hackBinPath,
      home: opts.home,
      ...readLaunchdPlistOptions({ plistText: opts.plistText }),
    })
  );
}

/**
 * What the installed plist's program is, relative to this CLI:
 * `missing` (absent, unreadable or a compiled-binary virtual path: never
 * runnable), `ours` (the same file as this CLI's resolution, see
 * {@link isSameExecutableFile}), or `other` (another existing program, which
 * the user may have chosen; only `hack daemon install` switches it), or
 * `unknown` (the plist's program cannot be read, see
 * {@link parseLaunchdPlistProgram}; never replaced automatically).
 * `resolved` is this CLI's program, null when none resolves.
 */
export type LaunchdProgramState =
  | {
      readonly kind: "missing" | "ours" | "other" | "unknown";
      readonly program: string | null;
      readonly resolved: string | null;
    }
  | { readonly kind: "not-installed" };

export async function readLaunchdProgramState(opts: {
  readonly paths: DaemonPaths;
  readonly plistText?: string | null;
  /** Defaults to `fs.stat`; tests inject errors. */
  readonly stat?: (path: string) => Promise<unknown>;
  /**
   * The executing CLI ({@link resolveExecutingCliPath}); null: a source
   * invocation, never "ours". Test drivers pin it.
   */
  readonly executing?: string | null;
}): Promise<LaunchdProgramState> {
  if (!resolveLaunchdAccess().allowed) {
    return { kind: "not-installed" };
  }
  const plistText =
    opts.plistText ?? (await readTextFile(opts.paths.launchdPlistPath));
  if (plistText === null) {
    return { kind: "not-installed" };
  }
  const parsed = parseLaunchdPlistProgram({ plistText });
  const resolved = await resolveLaunchdHackBinPath({
    invocation: await resolveHackInvocation(),
  });
  if (parsed.kind === "unknown") {
    return { kind: "unknown", program: null, resolved };
  }
  const program = parsed.kind === "path" ? parsed.path : null;
  // Absence is established only by no program at all, a virtual path, or
  // a path stat reports as ENOENT/ENOTDIR; any other stat error is unknown.
  if (program === null || isVirtualExecutablePath(program)) {
    return { kind: "missing", program, resolved };
  }
  const presence = await classifyLaunchdProgramPath({
    path: program,
    stat: opts.stat,
  });
  if (presence !== "exists") {
    return { kind: presence, program, resolved };
  }
  // "This CLI" is the executing binary, not the PATH-selected `hack`
  // (`resolved`, which stays the retarget target): a newer CLI run by path
  // must not treat an older `hack` first on PATH as itself.
  const executing =
    opts.executing === undefined ? resolveExecutingCliPath() : opts.executing;
  const ours =
    executing !== null && (await isSameExecutableFile(program, executing));
  return { kind: ours ? "ours" : "other", program, resolved };
}

/**
 * Whether a rewrite would keep the plist's home binding: its
 * `EnvironmentVariables` sets no `HACK_HOME` (the renderer writes none) and
 * its `HOME`, if set, is the home the renderer writes. An unreadable
 * environment is not proof (false).
 */
export function plistKeepsThisHome(opts: {
  readonly plistText: string;
  readonly home?: string;
}): boolean {
  const parsed = parseLaunchdPlistEnvironment({ plistText: opts.plistText });
  if (parsed.kind !== "env") {
    return false;
  }
  if (parsed.env.has("HACK_HOME")) {
    return false;
  }
  const home = parsed.env.get("HOME");
  return home === undefined || home === (opts.home ?? resolveUserHomeDir());
}

/**
 * Whether launchd will not start hackd on its own any more (HACK-2216,
 * owner decision): `idle` only when `launchctl print` for Hack's label,
 * queried whether or not the plist file exists (moving or deleting it does
 * not unload the job), positively answers not-found
 * ({@link isLaunchdServiceNotFound}). Any loaded job is `unknown`, whatever
 * its plist on disk says: the loaded configuration can differ from the
 * file, and KeepAlive, RunAtLoad, StartInterval, StartCalendarInterval or
 * WatchPaths can start it again. Any other result is `unknown` too.
 *
 * A process that may not use launchd (an isolated HACK_HOME, or
 * HACK_LAUNCHD_DISABLE) cannot query it; it never started a launchd job
 * either, so the job it would ask about is not this replacement's: `idle`.
 */
export async function readLaunchdManagerState(
  opts: {
    /** Defaults to `launchctl print gui/<uid>/<label>`; tests pin it. */
    readonly query?: () => Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>;
  } = {}
): Promise<"idle" | "unknown"> {
  if (!resolveLaunchdAccess().allowed) {
    return "idle";
  }
  const result = await (
    opts.query ?? (() => runLaunchctl(["print", launchdServiceTarget()]))
  )();
  return result.exitCode !== 0 &&
    isLaunchdServiceNotFound({
      exitCode: result.exitCode,
      output: `${result.stderr}\n${result.stdout}`,
    })
    ? "idle"
    : "unknown";
}

/**
 * Whether the loaded job may be unloaded as this home's: launchd positively
 * reports it absent (`observation: "not-found"`; a failed query proves
 * nothing and is refused), it runs nothing (loaded, not running, no pid),
 * or its pid is proven to be this home's hackd
 * ({@link proveOwnedDaemonProcess}: a hackd holding a socket in this home's
 * daemon directory). A running job without a pid, or one that fails the
 * proof, is not this home's (false).
 */
export async function proveLaunchdJobOwnership(opts: {
  readonly paths: DaemonPaths;
  readonly status?: LaunchdServiceStatus;
  readonly prove?: (pid: number) => Promise<DaemonProcessProof>;
}): Promise<boolean> {
  const status =
    opts.status ?? (await getLaunchdServiceStatus({ paths: opts.paths }));
  if (!status.loaded) {
    // Only a positively identified absence lets the plist be replaced: a
    // failed query (or none) may hide a running job of another home.
    return status.observation === "not-found";
  }
  if (status.pid === null || status.pid <= 1) {
    return !status.running;
  }
  const proof = await (
    opts.prove ??
    ((pid: number) =>
      proveOwnedDaemonProcess({ pid, daemonRoot: opts.paths.root }))
  )(status.pid);
  return proof.kind === "owned";
}

/**
 * Repairs an installed launchd plist (HACK-2216):
 * - a program that is gone or a compiled-binary virtual path (/$bunfs) is
 *   retargeted to this CLI ("repaired"): such a plist leaves launchd
 *   flapping with exit status 78;
 * - a plist that runs this CLI's executable but differs from what it
 *   renders is rewritten for its own program path, with the marker
 *   ("refreshed"), when it is Hack's ({@link isHackManagedPlist}: the
 *   marker, or Hack's `Label`, which covers plists from earlier Hack
 *   versions) or its output paths are unbounded (the older repair, kept);
 * - another existing program is left alone ("other-program"), even a stale
 *   versioned path; `hack daemon install` switches it. A plist that is not
 *   Hack's and only differs in content is left alone too ("unmanaged").
 *
 * Reports "not-installed" without reading the plist when
 * {@link resolveLaunchdAccess} denies access: this process does not own the
 * service, so it has nothing to repair.
 */
export async function repairLaunchdProgramIfInvalid(opts: {
  readonly paths: DaemonPaths;
  /** Defaults to {@link proveLaunchdJobOwnership}; tests pin it. */
  readonly proveJob?: () => Promise<boolean>;
  /** See {@link readLaunchdProgramState}; test drivers pin it. */
  readonly executing?: string | null;
  /**
   * The caller knows this home's hackd runs (start found it compatible and
   * running). A rewrite unloads and restarts it, so it needs an eligible
   * executing CLI ({@link refuseRunningRewrite}). A running job counts too.
   */
  readonly daemonRunning?: boolean;
  /** Defaults to {@link checkLaunchdRetargetTarget}; tests pin it. */
  readonly validateRetarget?: (path: string) => Promise<string | null>;
  /** Defaults to the real launchd status; tests pin it. */
  readonly readStatus?: () => Promise<LaunchdServiceStatus>;
}): Promise<LaunchdProgramRepairResult> {
  if (!resolveLaunchdAccess().allowed) {
    return "not-installed";
  }
  const plistText = await readTextFile(opts.paths.launchdPlistPath);
  if (plistText === null) {
    return "not-installed";
  }
  const decided = await decideLaunchdRewrite({
    paths: opts.paths,
    plistText,
    executing: opts.executing,
  });
  if (decided.kind === "result") {
    return decided.result;
  }
  const { program, target } = decided;
  // A retarget writes a new program into the login service: the same
  // checks a systemd retarget makes (HACK-2216).
  if (program === null) {
    const refused = await (opts.validateRetarget ?? checkLaunchdRetargetTarget)(
      target
    );
    if (refused !== null) {
      return "retarget-refused";
    }
  }
  // A rewrite unloads the loaded job and replaces its plist: it must be
  // this home's (HACK-2216). The plist must not bind another home, and a
  // running job must be this home's proven hackd. Unknown refuses.
  if (!plistKeepsThisHome({ plistText })) {
    return "home-binding";
  }
  const status = await (
    opts.readStatus ?? (() => getLaunchdServiceStatus({ paths: opts.paths }))
  )();
  const running =
    opts.daemonRunning === true || status.running || status.pid !== null;
  if (running) {
    const refused = await refuseRunningRewrite({
      target,
      executing:
        opts.executing === undefined
          ? resolveExecutingCliPath()
          : opts.executing,
    });
    if (refused !== null) {
      return refused;
    }
  }
  const proven = await (
    opts.proveJob ??
    (() => proveLaunchdJobOwnership({ paths: opts.paths, status }))
  )();
  if (!proven) {
    return "unproven-owner";
  }
  const result = await installLaunchdService({
    paths: opts.paths,
    config: {
      installed: true,
      ...readLaunchdPlistOptions({ plistText }),
    },
    // A refresh keeps the plist's own program path; a retarget writes the
    // validated target.
    hackBinPath: target,
  });
  if (!result.ok) {
    return "failed";
  }
  return program === null ? "repaired" : "refreshed";
}

/**
 * A rewrite of a loaded plist unloads and restarts a running hackd
 * (HACK-2216). Only an eligible executing CLI may do that: a compiled
 * binary ({@link resolveExecutingCliPath}; a source invocation is unknown)
 * that is the same file as the program the plist will run. Otherwise the
 * job is not touched: `unproven-owner` for an unknown executing CLI,
 * `other-program` for another one. A stopped job may still be repaired
 * from any CLI.
 */
async function refuseRunningRewrite(opts: {
  readonly target: string;
  readonly executing: string | null;
}): Promise<"other-program" | "unproven-owner" | null> {
  if (opts.executing === null) {
    return "unproven-owner";
  }
  return (await isSameExecutableFile(opts.target, opts.executing))
    ? null
    : "other-program";
}

const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|tsx|jsx)$/i;
const BUN_SHEBANG = /^#!.*\bbun\b/;

/**
 * Why `path` may not become the program of a login service by an automatic
 * retarget, or null when it may (HACK-2216): not a source file (`.ts`,
 * `.js`...), not a `#!` script run by bun, durable
 * (`assessExecutableDurability`, as for a systemd retarget) and safe from
 * other accounts (`checkServiceExecutableTrusted`). `hack daemon install`
 * still writes what it is asked to, with its own checks.
 */
export async function checkLaunchdRetargetTarget(
  path: string,
  opts: {
    readonly readHead?: (path: string) => Promise<string | null>;
    readonly assessDurability?: (opts: {
      readonly path: string;
    }) => Promise<{ readonly durable: boolean; readonly reason?: string }>;
    readonly checkTrusted?: (opts: {
      readonly path: string;
    }) => Promise<string | null>;
  } = {}
): Promise<string | null> {
  if (SCRIPT_EXTENSION.test(path)) {
    return `${path} is a source file, not an installed hack`;
  }
  const head = await (opts.readHead ?? readFileHead)(path);
  if (head === null) {
    return `${path} could not be read`;
  }
  if (BUN_SHEBANG.test(head.split("\n", 1)[0] ?? "")) {
    return `${path} is a script run by bun, not an installed hack`;
  }
  // Loaded lazily: systemd.ts imports this module.
  const systemd = await import("./systemd.ts");
  const durability = await (
    opts.assessDurability ?? systemd.assessExecutableDurability
  )({ path });
  if (!durability.durable) {
    return `${path} is not a stable location for a login service: ${durability.reason ?? "unknown reason"}`;
  }
  return await (opts.checkTrusted ?? systemd.checkServiceExecutableTrusted)({
    path,
  });
}

async function readFileHead(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).slice(0, 256).text();
  } catch {
    return null;
  }
}

/**
 * Whether the plist needs a rewrite, before any ownership check: a final
 * `result` (nothing to rewrite, or a reason not to), or `rewrite` with the
 * program to keep (null: retarget to this CLI).
 */
async function decideLaunchdRewrite(opts: {
  readonly paths: DaemonPaths;
  readonly plistText: string;
  readonly executing?: string | null;
}): Promise<
  | { readonly kind: "result"; readonly result: LaunchdProgramRepairResult }
  | {
      readonly kind: "rewrite";
      /** The plist's own program to keep; null: retarget to `target`. */
      readonly program: string | null;
      /** The program the rewritten plist runs. */
      readonly target: string;
    }
> {
  const { plistText } = opts;
  const state = await readLaunchdProgramState({
    paths: opts.paths,
    plistText,
    executing: opts.executing,
  });
  const final = (result: LaunchdProgramRepairResult) =>
    ({ kind: "result", result }) as const;
  switch (state.kind) {
    case "not-installed":
      return final("not-installed");
    case "other":
      return final("other-program");
    case "unknown":
      return final("unknown-program");
    case "missing":
      return state.resolved === null
        ? final("failed")
        : { kind: "rewrite", program: null, target: state.resolved };
    default:
      break;
  }
  const program = state.program;
  if (program === null) {
    return state.resolved === null
      ? final("failed")
      : { kind: "rewrite", program: null, target: state.resolved };
  }
  if (
    isLaunchdPlistCurrent({
      plistText,
      hackBinPath: program,
      home: resolveUserHomeDir(),
    })
  ) {
    return final("ok");
  }
  if (
    hasBoundedLaunchdOutput({ plistText }) &&
    !isHackManagedPlist({ plistText })
  ) {
    return final("unmanaged");
  }
  return { kind: "rewrite", program, target: program };
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
  /**
   * launchd reported the service. False also when the query failed: see
   * `observation` before treating false as "not loaded" for anything that
   * changes the service.
   */
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly exitStatus: number | null;
  /**
   * How `launchctl print` answered, when it ran (HACK-2216): `reported`
   * (exit 0), `not-found` (exit 113 with launchd's "Could not find service"
   * message: absence positively identified), or `failed` (anything else, an
   * observation failure that proves nothing). Absent when no query ran.
   */
  readonly observation?: "reported" | "not-found" | "failed";
}

/** launchd's answer for a service it does not have loaded. */
const LAUNCHCTL_SERVICE_NOT_FOUND_EXIT = 113;
const LAUNCHCTL_SERVICE_NOT_FOUND = /Could not find service/;

/** Whether a failed `launchctl print` positively says the service is absent. */
export function isLaunchdServiceNotFound(opts: {
  readonly exitCode: number;
  readonly output: string;
}): boolean {
  return (
    opts.exitCode === LAUNCHCTL_SERVICE_NOT_FOUND_EXIT &&
    LAUNCHCTL_SERVICE_NOT_FOUND.test(opts.output)
  );
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

  const { exitCode, stdout, stderr } = await runLaunchctl([
    "print",
    launchdServiceTarget(),
  ]);
  if (exitCode !== 0) {
    // `loaded: false` either way, as status and doctor display it; the
    // observation says whether that is known.
    return {
      installed: true,
      loaded: false,
      running: false,
      pid: null,
      exitStatus: null,
      observation: isLaunchdServiceNotFound({
        exitCode,
        output: `${stderr}\n${stdout}`,
      })
        ? "not-found"
        : "failed",
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
    observation: "reported",
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
