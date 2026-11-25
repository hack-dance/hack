import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
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
  writeTextFileAtomicIfChanged,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";
import {
  checkReplaceableChain,
  lettingOthersCreate,
} from "../lib/path-trust.ts";
import { boundedTimeoutMs } from "../lib/process-deadline.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import { resolveExecutingCliPath } from "./executing-cli.ts";
import {
  parseLaunchdPlistCommand,
  parseLaunchdPlistEnvironment,
  parseLaunchdPlistProgram,
} from "./launchd-plist.ts";
import {
  type LaunchdLoadedJob,
  parseLaunchdPrintJob,
} from "./launchd-print.ts";
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
 * The `launchctl` macOS ships. It is run by this absolute path, never
 * looked up on PATH (HACK-2216): `hack update` and `start` reach launchd
 * automatically, and a `launchctl` planted in an earlier PATH directory
 * would otherwise run as this user.
 */
export const LAUNCHCTL_PATH = "/bin/launchctl";

let launchctlBinary: string = LAUNCHCTL_PATH;

/**
 * Test-only: points every launchd operation at a stub `launchctl`, for
 * tests that run launchd code on any host. Called only from a test
 * `--preload` module; production code never calls it, and no environment
 * variable selects the binary.
 */
export function useLaunchctlBinaryForTests(path: string): void {
  launchctlBinary = path;
}

/** The argv of one `launchctl` run: {@link LAUNCHCTL_PATH} and `args`. */
export function launchctlArgv(args: readonly string[]): readonly string[] {
  return [launchctlBinary, ...args];
}

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
  const proc = Bun.spawn([...launchctlArgv(args)], {
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

/** The system directories on the PATH the rendered plist gives hackd. */
export const LAUNCHD_SYSTEM_PATH_DIRECTORIES = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
] as const;

/** The PATH directories the rendered plist gives hackd, in order. */
export function renderedLaunchdPathDirectories(opts: {
  readonly home: string;
  /**
   * Test seam: replaces {@link LAUNCHD_SYSTEM_PATH_DIRECTORIES} so tests do
   * not depend on the host's own system directories.
   */
  readonly systemDirectories?: readonly string[];
}): readonly string[] {
  return [
    ...(opts.systemDirectories ?? LAUNCHD_SYSTEM_PATH_DIRECTORIES),
    `${opts.home}/.bun/bin`,
    `${opts.home}/.hack/bin`,
  ];
}

/**
 * hackd runs helpers such as `docker` by bare name through the plist's
 * PATH, so a directory on it that another account can add programs to (or
 * create) has them run as this user (HACK-2216). Every directory of the
 * PATH the rendered plist gives hackd gets the checks systemd makes for
 * its rendered unit ({@link checkServicePathDirectories} in systemd.ts),
 * with no exception for administrator directories. Null, or why not.
 */
export async function checkLaunchdServicePath(opts: {
  readonly home: string;
  /** Test seam; see {@link renderedLaunchdPathDirectories}. */
  readonly systemDirectories?: readonly string[];
}): Promise<string | null> {
  // Loaded lazily: systemd.ts imports this module.
  const { checkServicePathDirectories } = await import("./systemd.ts");
  const error = await checkServicePathDirectories({
    dirs: renderedLaunchdPathDirectories(opts),
  });
  return error === null
    ? null
    : `the PATH the launchd service would give hackd is not safe: ${error.replace("the hackd.service PATH", "its PATH")}`;
}

/**
 * The PATH directories a plist sets for hackd: its own `PATH`, which an
 * automatic start requires (HACK-2216). launchd's default or inherited
 * PATH is never assumed: it can hold a directory another account writes.
 * With the test seam, the system directories among them are replaced by
 * `systemDirectories`. Null when the plist sets no PATH, a non-string one,
 * or cannot be read.
 */
function launchdPlistPathDirectories(opts: {
  readonly plistText: string;
  readonly systemDirectories?: readonly string[];
}): readonly string[] | null {
  const raw = readPlistPath(opts.plistText);
  if (raw === null) {
    return null;
  }
  const dirs = raw.split(":");
  const seam = opts.systemDirectories;
  if (seam === undefined) {
    return dirs;
  }
  const system = new Set<string>(LAUNCHD_SYSTEM_PATH_DIRECTORIES);
  return [...dirs.filter((dir) => !system.has(dir)), ...seam];
}

/** The plist's own `PATH` string, or null when it sets none it can read. */
function readPlistPath(plistText: string): string | null {
  const env = parseLaunchdPlistEnvironment({ plistText });
  if (env.kind === "unknown") {
    return null;
  }
  const raw = env.env.get("PATH");
  return typeof raw === "string" ? raw : null;
}

/**
 * The only command an automatic start runs: `<program> daemon start
 * --foreground`, the program first (HACK-2216). Hack writes exactly this.
 */
function expectedArguments(program: string): readonly string[] {
  return [program, "daemon", "start", "--foreground"];
}

function sameArguments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, index) => arg === b[index]);
}

/**
 * The last check before launchd is asked to load or start this job
 * (HACK-2216): a kickstart, reload or bootstrap for `start`, `restart`,
 * the post-update reconcile, a stopped-service start or autostart. It runs
 * before anything is unloaded or loaded. The plist must:
 * - run exactly `<program> daemon start --foreground` (its complete
 *   `ProgramArguments`, with `Program` taking precedence), so a reload with
 *   `RunAtLoad` or `KeepAlive` cannot run custom arguments;
 * - name a program safe from other accounts along its whole path
 *   (`checkServiceExecutableTrusted`);
 * - set its own `PATH` (launchd's default or inherited one is never
 *   assumed), every directory of which passes the checks systemd makes for
 *   its unit's PATH (`checkServicePathDirectories`): hackd runs helpers such
 *   as `docker` by bare name.
 * Hack always renders `PATH`; a plist without one is refreshed by the
 * checked repair when it is Hack's, and refused otherwise. Null, or why
 * launchd must not start it.
 */
export async function checkLaunchdJobBeforeStart(opts: {
  readonly plistText: string;
  /** Test seam; see {@link renderedLaunchdPathDirectories}. */
  readonly systemDirectories?: readonly string[];
}): Promise<string | null> {
  const command = parseLaunchdPlistCommand({ plistText: opts.plistText });
  if (command.kind !== "command") {
    return `the command the launchd service runs cannot be read (${command.reason})`;
  }
  if (!sameArguments(command.arguments, expectedArguments(command.program))) {
    return "the launchd service runs other arguments than `hack daemon start --foreground`, which an automatic start does not run";
  }
  const dirs = launchdPlistPathDirectories(opts);
  if (dirs === null) {
    return "the launchd plist sets no PATH of its own (launchd's default or inherited PATH is not checked), so it is not started automatically";
  }
  // Loaded lazily: systemd.ts imports this module.
  const { checkServiceExecutableTrusted, checkServicePathDirectories } =
    await import("./systemd.ts");
  const untrusted = await checkServiceExecutableTrusted({
    path: command.program,
  });
  if (untrusted !== null) {
    return untrusted.replace(
      "hackd.service would run",
      "the launchd service would run"
    );
  }
  const unsafePath = await checkServicePathDirectories({ dirs });
  return unsafePath === null
    ? null
    : `the PATH the launchd service gives hackd is not safe: ${unsafePath.replace("the hackd.service PATH", "its PATH")}`;
}

/** The configuration launchd has loaded for hackd, read strictly. */
export async function readLaunchdLoadedJob(): Promise<LaunchdLoadedJob> {
  const { exitCode, stdout } = await runLaunchctl([
    "print",
    launchdServiceTarget(),
  ]);
  return exitCode === 0
    ? parseLaunchdPrintJob(stdout)
    : { kind: "unknown", reason: `launchctl print exited ${exitCode}` };
}

/**
 * Whether the loaded job runs exactly what the checked plist says: the same
 * program, the arguments Hack writes (`<program> daemon start
 * --foreground`), and the same explicit `PATH` in the job's own
 * environment. A job or plist without its own PATH never matches.
 */
export function loadedJobMatchesPlist(opts: {
  readonly loaded: LaunchdLoadedJob;
  readonly plistText: string;
}): boolean {
  const { loaded } = opts;
  if (loaded.kind !== "job") {
    return false;
  }
  const command = parseLaunchdPlistCommand({ plistText: opts.plistText });
  const path = readPlistPath(opts.plistText);
  if (command.kind !== "command" || path === null) {
    return false;
  }
  return (
    loaded.program === command.program &&
    sameArguments(loaded.arguments, expectedArguments(command.program)) &&
    loaded.path === path
  );
}

/**
 * The plist launchd loads, and every directory above it, must be safe from
 * other accounts before Hack unloads, writes or bootstraps anything
 * (HACK-2216): the directory chain up to `/` is not replaceable
 * (`checkReplaceableChain`), `~/Library/LaunchAgents` itself does not let
 * others add or replace entries, and an existing plist is a regular file
 * (not a link) owned by this user that nobody else can write. Nothing is
 * repaired: a file others could write may already hold their content.
 * Null, or why not (reported as `blocked: "untrusted-unit"`).
 */
export async function checkLaunchdPlistTrusted(opts: {
  readonly plistPath: string;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const dir = dirname(opts.plistPath);
  const chain = checkReplaceableChain({ path: dir, uid, hackHome: null });
  if (chain !== null) {
    return `the launchd plist's directory ${dir} is not safe from other accounts: ${chain}`;
  }
  const creatable = lettingOthersCreate(dir);
  if (creatable !== null) {
    return `${dir} lets other users replace the launchd plist (${creatable}); run: chmod go-w ${dir}`;
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(opts.plistPath);
  } catch (error: unknown) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? null
      : `could not inspect ${opts.plistPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!info.isFile()) {
    return `${opts.plistPath} is not a regular file (a link or other entry Hack did not write)`;
  }
  if (uid >= 0 && info.uid !== uid) {
    return `${opts.plistPath} is owned by another user (uid ${info.uid})`;
  }
  return (Number(info.mode) & 0o022) === 0
    ? null
    : `${opts.plistPath} is writable by other users (mode ${(Number(info.mode) & 0o777).toString(8)}), so its contents cannot be trusted`;
}

/** A plist read through a descriptor that does not follow a link. */
interface BoundPlist {
  readonly text: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Reads the plist without following a link at its path (`O_NOFOLLOW`), with
 * the identity of the file read. Null when it is a link, not a regular
 * file, or cannot be read.
 */
async function readBoundPlist(plistPath: string): Promise<BoundPlist | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(plistPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      return null;
    }
    const text = await handle.readFile("utf8");
    return { text, dev: Number(info.dev), ino: Number(info.ino) };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Bootstraps the plist only when the file at its path is still exactly the
 * one checked (HACK-2216): read again through `O_NOFOLLOW` right before
 * `launchctl bootstrap`, with the same bytes and the same device and inode.
 * Otherwise nothing is loaded.
 */
async function bootstrapBoundPlist(opts: {
  readonly plistPath: string;
  readonly bound: BoundPlist;
}): Promise<LaunchctlResult> {
  const now = await readBoundPlist(opts.plistPath);
  if (
    now === null ||
    now.text !== opts.bound.text ||
    now.dev !== opts.bound.dev ||
    now.ino !== opts.bound.ino
  ) {
    return {
      ok: false,
      error: `${opts.plistPath} changed after it was checked, so it was not loaded`,
    };
  }
  return await loadLaunchdService({ plistPath: opts.plistPath });
}

/**
 * Unloads the job and loads the plist on disk again, bound to the checked
 * bytes: the file must still be the one read (same bytes, device and
 * inode) both before the unload and right before the bootstrap.
 */
async function reloadLaunchdPlist(opts: {
  readonly paths: DaemonPaths;
  readonly bound: BoundPlist;
}): Promise<LaunchctlResult> {
  const plistPath = opts.paths.launchdPlistPath;
  const before = await readBoundPlist(plistPath);
  if (
    before === null ||
    before.text !== opts.bound.text ||
    before.dev !== opts.bound.dev ||
    before.ino !== opts.bound.ino
  ) {
    return {
      ok: false,
      error: `${plistPath} changed after it was checked, so the job was not reloaded`,
    };
  }
  const unloaded = await unloadLaunchdService();
  if (!(unloaded.ok || unloaded.notLoaded)) {
    return unloaded;
  }
  return await bootstrapBoundPlist({ plistPath, bound: opts.bound });
}

/**
 * Everything before an automatic kickstart (HACK-2216). A kickstart runs
 * the configuration launchd has LOADED, not the plist on disk, so:
 * 1. the plist on disk gets {@link checkLaunchdJobBeforeStart} (command,
 *    program, explicit PATH) before anything is unloaded or loaded;
 * 2. the loaded job ({@link readLaunchdLoadedJob}) must run exactly that
 *    plist ({@link loadedJobMatchesPlist});
 * 3. when it does not, or cannot be read, the job is reloaded from the
 *    checked plist, but only on fresh evidence that it is stopped
 *    (`isRunning`, read right before the bootout): a running job is
 *    refused, because a reload would stop hackd;
 * 4. after that reload, a re-read that positively differs refuses. One
 *    that cannot be read is accepted: launchd has just loaded the plist
 *    that passed step 1. Reading real `launchctl print` output is a
 *    compatibility point that is not verified against every macOS
 *    release, and this keeps the service available if its format moves.
 * Null when the kickstart may run, or why it must not. Nothing is
 * kickstarted here.
 */
export async function verifyLaunchdJobBeforeKickstart(opts: {
  readonly paths: DaemonPaths;
  readonly plistText: string;
  /** Whether the job runs a process now; read fresh right before a reload. */
  readonly isRunning: () => Promise<boolean>;
  /** Test seam; see {@link renderedLaunchdPathDirectories}. */
  readonly systemDirectories?: readonly string[];
  /** Defaults to {@link readLaunchdLoadedJob}; tests pin it. */
  readonly readLoaded?: () => Promise<LaunchdLoadedJob>;
  /** Defaults to bootout plus bootstrap of the plist; tests pin it. */
  readonly reload?: () => Promise<{
    readonly ok: boolean;
    readonly error?: string;
  }>;
  /** Test seam for the plist file and directory owner check. */
  readonly uid?: number;
}): Promise<LaunchdStartRefusal | null> {
  const untrusted = await checkLaunchdPlistTrusted({
    plistPath: opts.paths.launchdPlistPath,
    uid: opts.uid,
  });
  if (untrusted !== null) {
    return { reason: untrusted, blocked: "untrusted-unit" };
  }
  const refused = (reason: string): LaunchdStartRefusal => ({
    reason,
    blocked: "rewrite-refused",
  });
  const unsafe = await checkLaunchdJobBeforeStart(opts);
  if (unsafe !== null) {
    return refused(unsafe);
  }
  const read = opts.readLoaded ?? readLaunchdLoadedJob;
  const loaded = await read();
  if (loadedJobMatchesPlist({ loaded, plistText: opts.plistText })) {
    return null;
  }
  const why =
    loaded.kind === "unknown"
      ? `its loaded configuration could not be read (${loaded.reason})`
      : "its loaded configuration differs from the checked plist";
  if (await opts.isRunning()) {
    return refused(
      `launchd would restart hackd from a configuration that was not checked: ${why}, and hackd runs, so it was not reloaded`
    );
  }
  const reloaded = await (opts.reload ?? (() => reloadChecked(opts)))();
  if (!reloaded.ok) {
    return refused(
      `${why}, and reloading the checked plist failed: ${reloaded.error ?? "unknown error"}`
    );
  }
  const again = await read();
  if (again.kind === "unknown") {
    return null;
  }
  return loadedJobMatchesPlist({ loaded: again, plistText: opts.plistText })
    ? null
    : refused(`${why}, and it still differs after reloading the checked plist`);
}

/** Why an automatic launchd start was refused, with its `--json` reason. */
export interface LaunchdStartRefusal {
  readonly reason: string;
  readonly blocked: "untrusted-unit" | "rewrite-refused";
}

/**
 * The default reload: the plist file read through `O_NOFOLLOW` must hold
 * exactly the bytes that were checked, and stays bound to them (same
 * device and inode) up to the bootstrap.
 */
async function reloadChecked(opts: {
  readonly paths: DaemonPaths;
  readonly plistText: string;
}): Promise<LaunchctlResult> {
  const bound = await readBoundPlist(opts.paths.launchdPlistPath);
  if (bound === null || bound.text !== opts.plistText) {
    return {
      ok: false,
      error: `${opts.paths.launchdPlistPath} is not the plist that was checked (changed, or a link)`,
    };
  }
  return await reloadLaunchdPlist({ paths: opts.paths, bound });
}

/**
 * Whether a launchd status shows a job that runs (or may run) a process:
 * an unreadable status counts as running, so nothing is reloaded on it.
 */
export function launchdJobMayBeRunning(status: LaunchdServiceStatus): boolean {
  if (status.observation === "not-found") {
    return false;
  }
  if (status.observation !== undefined && status.observation !== "reported") {
    return true;
  }
  return status.running || status.pid !== null;
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
    "    <key>HACK_DAEMON_LOGIN_SERVICE</key>",
    "    <string>1</string>",
    "    <key>HACK_NO_INTERACTIVE</key>",
    "    <string>1</string>",
    "    <key>HOME</key>",
    `    <string>${opts.home}</string>`,
    "    <key>PATH</key>",
    `    <string>${renderedLaunchdPathDirectories({ home: opts.home }).join(":")}</string>`,
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
  /**
   * Set when the PATH the plist would give hackd failed
   * {@link checkLaunchdServicePath}; nothing was unloaded, written or loaded.
   */
  readonly unsafePath?: true;
  /**
   * Set when the program the plist would run failed
   * `checkServiceExecutableTrusted`; nothing was unloaded, written or loaded.
   */
  readonly unsafeProgram?: true;
  /**
   * Set when the plist file or its directories failed
   * {@link checkLaunchdPlistTrusted}; nothing was unloaded, written or loaded.
   */
  readonly untrustedPlist?: true;
}

/**
 * Installs the launchd plist and bootstraps the service.
 *
 * Refuses, without touching the plist or launchctl, when
 * {@link resolveLaunchdAccess} denies access, or when the PATH the plist
 * would give hackd fails {@link checkLaunchdServicePath} (`unsafePath`).
 * The PATH check runs for an explicit `hack daemon install` and for every
 * automatic refresh or retarget alike, right before anything is unloaded
 * or written.
 */
export async function installLaunchdService({
  paths,
  config,
  hackBinPath: keepProgram,
  systemPathDirectories,
}: {
  readonly paths: DaemonPaths;
  readonly config: DaemonLaunchdConfig;
  /**
   * The program to write, when a refresh keeps the plist's own path (a
   * link to this CLI stays a link). Defaults to this CLI's resolution.
   */
  readonly hackBinPath?: string;
  /** Test seam; see {@link renderedLaunchdPathDirectories}. */
  readonly systemPathDirectories?: readonly string[];
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
  // The program the plist will run, safe from other accounts along its
  // whole path, for every caller: explicit install, autostart's implicit
  // install, refresh and retarget (HACK-2216). Loaded lazily: systemd.ts
  // imports this module.
  const { checkServiceExecutableTrusted } = await import("./systemd.ts");
  const untrusted = await checkServiceExecutableTrusted({ path: hackBinPath });
  if (untrusted !== null) {
    return {
      ok: false,
      error: untrusted.replace(
        "hackd.service would run",
        "the launchd service would run"
      ),
      unsafeProgram: true,
    };
  }
  const unsafePath = await checkLaunchdServicePath({
    home,
    systemDirectories: systemPathDirectories,
  });
  if (unsafePath !== null) {
    return { ok: false, error: unsafePath, unsafePath: true };
  }

  const plistContent = renderLaunchdPlist({
    hackBinPath,
    home,
    runAtLoad: config.runAtLoad,
    guiSessionOnly: config.guiSessionOnly,
  });

  await ensureDir(dirname(paths.launchdPlistPath), 0o755);
  await ensureDir(paths.root, 0o700);

  // The plist file and its directories, before anything is unloaded,
  // written or loaded (HACK-2216).
  const untrustedPlist = await checkLaunchdPlistTrusted({
    plistPath: paths.launchdPlistPath,
  });
  if (untrustedPlist !== null) {
    return { ok: false, error: untrustedPlist, untrustedPlist: true };
  }

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

  // A fresh file renamed onto the path itself (a link there is refused,
  // never written through), then loaded only while it still holds exactly
  // these bytes.
  await writeTextFileAtomicIfChanged(paths.launchdPlistPath, plistContent, {
    noFollowTarget: true,
    createMode: 0o644,
  });
  const bound = await readBoundPlist(paths.launchdPlistPath);
  if (bound === null || bound.text !== plistContent) {
    return {
      ok: false,
      error: `${paths.launchdPlistPath} changed after it was written, so it was not loaded`,
    };
  }
  const loadResult = await bootstrapBoundPlist({
    plistPath: paths.launchdPlistPath,
    bound,
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
 * Whether two paths name the same executable file now: both are resolved
 * (every symlink followed) and the files they resolve to must have the
 * same device and inode. Equal path strings are not enough: a pathname can
 * be replaced after this CLI was started from it. A hard link or a bind
 * mount counts as the same file. False when either cannot be read. A
 * service whose program is the same file as this CLI's runs this version;
 * any other existing program may be one the user chose (HACK-2216).
 */
export async function isSameExecutableFile(
  a: string,
  b: string,
  io: {
    /** Defaults to `fs.realpath`; tests inject it. */
    readonly realpath?: (path: string) => Promise<string>;
    /** Defaults to `fs.stat`; tests inject it. */
    readonly stat?: (
      path: string
    ) => Promise<{ readonly dev: number; readonly ino: number }>;
  } = {}
): Promise<boolean> {
  const resolvePath = io.realpath ?? realpath;
  const statPath = io.stat ?? stat;
  try {
    const [realA, realB] = await Promise.all([resolvePath(a), resolvePath(b)]);
    const [statA, statB] = await Promise.all([
      statPath(realA),
      statPath(realB),
    ]);
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
 * `refresh-refused`: the plist is stale, but the program a refresh would
 * keep fails the same checks (a source file, a non-durable location, or
 * one another account can replace), left as it is;
 * `untrusted-plist`: the plist file or a directory above it could have
 * been written by another account ({@link checkLaunchdPlistTrusted}), so
 * nothing was unloaded, written or loaded;
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
  | "refresh-refused"
  | "untrusted-plist"
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
  /** Test seam; see {@link renderedLaunchdPathDirectories}. */
  readonly systemPathDirectories?: readonly string[];
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
  // checks a systemd retarget makes (HACK-2216). Checked early so nothing
  // else is read for an unfit target, and again just before the write.
  if (program === null) {
    const refused = await (opts.validateRetarget ?? checkLaunchdRetargetTarget)(
      target
    );
    if (refused !== null) {
      return "retarget-refused";
    }
  }
  const owner = await refuseJobRewrite({ ...opts, plistText, target });
  if (owner !== null) {
    return owner;
  }
  // Last, right before the plist is written and the job booted out and
  // bootstrapped: the program the rewritten plist runs, kept by a refresh
  // or new for a retarget, gets the full target checks (HACK-2216). A
  // refresh of a pathname another account can replace would bootstrap
  // whatever they put there. installLaunchdService then checks the PATH
  // the plist gives hackd before it unloads or writes anything.
  const refused = program === null ? "retarget-refused" : "refresh-refused";
  const unfit = await (opts.validateRetarget ?? checkLaunchdRetargetTarget)(
    target
  );
  if (unfit !== null) {
    return refused;
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
    systemPathDirectories: opts.systemPathDirectories,
  });
  if (result.untrustedPlist) {
    return "untrusted-plist";
  }
  if (result.unsafePath || result.unsafeProgram) {
    return refused;
  }
  if (!result.ok) {
    return "failed";
  }
  return program === null ? "repaired" : "refreshed";
}

/**
 * A rewrite unloads the loaded job and replaces its plist: it must be this
 * home's (HACK-2216). The plist must not bind another home
 * (`home-binding`), a running hackd may only be restarted by an eligible
 * CLI ({@link refuseRunningRewrite}), and the job must be proven this
 * home's (`unproven-owner`). Unknown refuses. Null when the rewrite may go on.
 */
async function refuseJobRewrite(opts: {
  readonly paths: DaemonPaths;
  readonly plistText: string;
  readonly target: string;
  readonly proveJob?: () => Promise<boolean>;
  readonly executing?: string | null;
  readonly daemonRunning?: boolean;
  readonly readStatus?: () => Promise<LaunchdServiceStatus>;
}): Promise<LaunchdProgramRepairResult | null> {
  if (!plistKeepsThisHome({ plistText: opts.plistText })) {
    return "home-binding";
  }
  const status = await (
    opts.readStatus ?? (() => getLaunchdServiceStatus({ paths: opts.paths }))
  )();
  const running =
    opts.daemonRunning === true || status.running || status.pid !== null;
  if (running) {
    const refused = await refuseRunningRewrite({
      target: opts.target,
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
  return proven ? null : "unproven-owner";
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
export async function refuseRunningRewrite(opts: {
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
 * The program a content refresh of this plist would keep, or null when
 * {@link repairLaunchdProgramIfInvalid} would not refresh it (current,
 * unmanaged, another or unreadable program, or a retarget instead). Reads
 * only; for the check before a running daemon is stopped (HACK-2216).
 */
export async function readLaunchdRefreshTarget(opts: {
  readonly paths: DaemonPaths;
  readonly plistText: string;
  readonly executing?: string | null;
}): Promise<string | null> {
  const decided = await decideLaunchdRewrite(opts);
  return decided.kind === "rewrite" && decided.program !== null
    ? decided.target
    : null;
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
