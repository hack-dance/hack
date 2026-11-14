import { lstatSync, readdirSync, type Stats, statSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import {
  pathExists,
  readTextFile,
  writeTextFileAtomicIfChanged,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";
import {
  checkReplaceableChain,
  entryExists,
  isSystemAccount,
  lettingOthersCreate,
  walkReplaceableChain,
} from "../lib/path-trust.ts";
import { boundedTimeoutMs } from "../lib/process-deadline.ts";
import {
  isVirtualExecutablePath,
  resolveLaunchdHackBinPath,
} from "./launchd.ts";

/**
 * hackd as a systemd user service (Linux).
 *
 * Design (HACK-2052):
 * - One per-user unit, {@link SYSTEMD_UNIT_NAME}, written to
 *   `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`. Hack owns the whole
 *   file; local changes belong in a drop-in (`systemctl --user edit hackd`),
 *   which this module never reads or writes.
 * - `ExecStart` runs the absolute path of the `hack` this CLI resolves (the
 *   first `hack` on PATH), not its symlink target, so a stable symlink such as
 *   `~/.local/bin/hack` keeps working when an upgrade moves the real binary.
 *   When the recorded program no longer exists, `hack daemon start` rewrites
 *   the unit; any other difference is reported as drift and fixed by
 *   `hack daemon install`.
 * - `Restart=on-failure`: a crash restarts hackd; `hack daemon stop` (a clean
 *   stop through systemctl) does not. Start limits stop a crash loop.
 * - Keep `KillMode=control-group`: stopping or restarting the service
 *   settles its transient supervisor jobs and shells. Linux login autostart
 *   starts each project in a distinct user scope, so project-owned detached
 *   lifecycle helpers survive replacement of the daemon service.
 * - Every `systemctl`/`loginctl` call goes through a {@link ServiceCommandRunner}
 *   so tests use a fake. The default runner re-checks
 *   {@link resolveSystemdAccess} before it spawns anything.
 * - Linger is reported, never changed: enabling it is the user's decision.
 */

/** The unit name, also used for `systemctl --user` and `journalctl --user -u`. */
export const SYSTEMD_UNIT_NAME = "hackd.service";

/**
 * Hard deny: when set to `1`, no `systemctl`/`loginctl` call runs and no unit
 * file is read or written, whatever HACK_HOME is. The test preload sets it.
 */
export const SYSTEMD_DISABLE_ENV = "HACK_SYSTEMD_DISABLE";

/**
 * Opt-in: when set to `1`, systemd management is allowed even though
 * HACK_HOME is not `$HOME/.hack`. {@link SYSTEMD_DISABLE_ENV} still wins.
 */
export const SYSTEMD_ALLOW_ISOLATED_ENV = "HACK_SYSTEMD_ALLOW_ISOLATED_HOME";

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * A command's time limit: 10 s, capped by any process deadline
 * (withProcessDeadline) so no child outlives it; null once it has passed.
 */
function commandLimitMs(): number | null {
  const limit = boundedTimeoutMs(COMMAND_TIMEOUT_MS) ?? COMMAND_TIMEOUT_MS;
  return limit > 0 ? limit : null;
}
const MAX_OUTPUT_CHARS = 64 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

export type SystemdAccessBlockReason = "disabled" | "isolated-hack-home";

export type SystemdAccess =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: SystemdAccessBlockReason;
      readonly message: string;
    };

/**
 * Decides whether this process may touch the per-user hackd systemd unit.
 *
 * Like the launchd service, the unit is a per-user singleton outside
 * HACK_HOME, and its ExecStart always uses the default `~/.hack` root. A
 * process with an isolated HACK_HOME does not own it, so it starts hackd
 * directly instead. Paths are compared after `resolve`, not `realpath`; a
 * symlinked alias of `~/.hack` counts as isolated, which fails safe.
 */
export function resolveSystemdAccess(
  opts: { readonly env?: Env } = {}
): SystemdAccess {
  const env = opts.env ?? process.env;
  if ((env[SYSTEMD_DISABLE_ENV] ?? "").trim() === "1") {
    return {
      allowed: false,
      reason: "disabled",
      message: `systemd management is disabled by ${SYSTEMD_DISABLE_ENV}=1.`,
    };
  }
  const override = (env.HACK_HOME ?? "").trim();
  if (override.length === 0) {
    return { allowed: true };
  }
  const home = normalizeHomeDir(env.HOME) ?? normalizeHomeDir(homedir());
  if (home && resolve(override) === resolve(home, GLOBAL_HACK_DIR_NAME)) {
    return { allowed: true };
  }
  if ((env[SYSTEMD_ALLOW_ISOLATED_ENV] ?? "").trim() === "1") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "isolated-hack-home",
    message: `systemd management is disabled for an isolated HACK_HOME: the hackd user service belongs to $HOME/.hack. Set ${SYSTEMD_ALLOW_ISOLATED_ENV}=1 to manage it anyway.`,
  };
}

export type ServiceCommandResult = {
  /** 127 when the executable was not found; 124 on timeout. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** The single boundary for `systemctl`, `loginctl` and `getent`. */
export type ServiceCommandRunner = (
  command: "systemctl" | "loginctl" | "getent",
  args: readonly string[]
) => Promise<ServiceCommandResult>;

export interface SystemdDeps {
  readonly env: Env;
  readonly run: ServiceCommandRunner;
  readonly uid: number;
}

/**
 * Production dependencies. The runner refuses (exit 1, no spawn) when
 * {@link resolveSystemdAccess} denies access, so a caller that skipped the
 * check still cannot reach the user's service manager.
 */
export function defaultSystemdDeps(
  opts: { readonly env?: Env } = {}
): SystemdDeps {
  const env = opts.env ?? process.env;
  return {
    env,
    run: createDefaultRunner({ env }),
    uid: process.getuid?.() ?? -1,
  };
}

function createDefaultRunner(opts: {
  readonly env: Env;
}): ServiceCommandRunner {
  return async (command, args) => {
    const access = resolveSystemdAccess({ env: opts.env });
    if (!access.allowed) {
      return { exitCode: 1, stdout: "", stderr: access.message };
    }
    const bin = Bun.which(command, { PATH: opts.env.PATH ?? "" });
    if (!bin) {
      return { exitCode: 127, stdout: "", stderr: `${command} not found` };
    }
    // Never run a manager tool another account could have put on PATH.
    const untrusted = await checkReplaceableChain({
      path: bin,
      uid: process.getuid?.() ?? -1,
      hackHome: null,
    });
    if (untrusted !== null) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `refusing to run ${bin}: ${untrusted}`,
      };
    }
    const limitMs = commandLimitMs();
    if (limitMs === null) {
      return {
        exitCode: 124,
        stdout: "",
        stderr: `${command} not run: deadline passed`,
      };
    }
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: childEnvironment({
          ...opts.env,
          SYSTEMD_PAGER: "",
          SYSTEMD_COLORS: "0",
        }),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 127, stdout: "", stderr: message };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, limitMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      return {
        exitCode: timedOut ? 124 : exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: timedOut
          ? `${command} timed out after ${limitMs}ms`
          : stderr.slice(0, MAX_OUTPUT_CHARS),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/hackd.service`. A relative
 * XDG_CONFIG_HOME is ignored, as the XDG spec requires.
 */
export function resolveSystemdUnitPath(
  opts: { readonly env?: Env; readonly home?: string } = {}
): string {
  const env = opts.env ?? process.env;
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  const configHome =
    xdg.length > 0 && isAbsolute(xdg)
      ? resolve(xdg)
      : resolve(opts.home ?? resolveUserHomeDir(), ".config");
  return resolve(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
}

/**
 * Set to `1` by `hack doctor --fix` when it may not change the service
 * (no TTY, or the install was declined): `hack daemon start` then never
 * writes the unit or runs `daemon-reload`; it reports what it would need.
 */
export const SYSTEMD_READ_ONLY_ENV = "HACK_DAEMON_SERVICE_READ_ONLY";

export function isSystemdReadOnly(env: Env = process.env): boolean {
  return (env[SYSTEMD_READ_ONLY_ENV] ?? "").trim() === "1";
}

const QUOTED_PREFIX = /^"[^"]*"/;
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/dev/shm", "/run/user"];
const EPHEMERAL_SEGMENTS = [
  "node_modules",
  ".cache",
  "_npx",
  ".npm",
  ".bun/install",
  ".pnpm-store",
  ".yarn",
];

export type ExecutableDurability =
  | { readonly durable: true }
  | { readonly durable: false; readonly reason: string };

/**
 * Whether a program path is fit to be written into a login service by an
 * automatic repair. Temporary directories, package caches and a checkout's
 * build output are not: cleaning them later would break login startup.
 * Explicit `hack daemon install` may still write such a path, with a warning.
 *
 * Both the path as written and its fully resolved target must pass: a
 * stable-looking symlink into a temporary directory, a package cache or a
 * build output breaks the same way (HACK-2052). The unit keeps the written
 * spelling, so an upgrade that moves the target behind a stable symlink
 * keeps working.
 */
export async function assessExecutableDurability(opts: {
  readonly path: string;
  readonly tempDirs?: readonly string[];
  readonly exists?: (path: string) => Promise<boolean>;
  /** The checkout walk stops below this directory (default `$HOME`). */
  readonly home?: string | null;
  /** Defaults to `fs.realpath`; tests pin symlink targets. */
  readonly resolveReal?: (path: string) => Promise<string>;
}): Promise<ExecutableDurability> {
  const written = resolve(opts.path);
  const asWritten = await assessPathDurability({ ...opts, path: written });
  if (!asWritten.durable) {
    return asWritten;
  }
  let target: string;
  try {
    target = await (opts.resolveReal ?? realpath)(written);
  } catch {
    return {
      durable: false,
      reason: "its real location could not be resolved",
    };
  }
  if (target === written) {
    return asWritten;
  }
  const resolved = await assessPathDurability({ ...opts, path: target });
  return resolved.durable
    ? resolved
    : {
        durable: false,
        reason: `it resolves to ${target}, and ${resolved.reason}`,
      };
}

/**
 * Each directory and its resolved path: a resolved program path (macOS
 * `/private/var/folders/...`) must still match a temp directory named
 * through a symlink (`/var/folders/...`, `/tmp`).
 */
async function withRealPaths(dirs: readonly string[]): Promise<string[]> {
  const out = new Set(dirs);
  for (const dir of dirs) {
    try {
      out.add(await realpath(dir));
    } catch {
      // A temp directory that does not exist matches nothing anyway.
    }
  }
  return [...out];
}

async function assessPathDurability(opts: {
  readonly path: string;
  readonly tempDirs?: readonly string[];
  readonly exists?: (path: string) => Promise<boolean>;
  readonly home?: string | null;
}): Promise<ExecutableDurability> {
  const exists = opts.exists ?? pathExists;
  const { path } = opts;
  const temps = await withRealPaths(
    [...TEMP_ROOTS, ...(opts.tempDirs ?? [process.env.TMPDIR ?? "", tmpdir()])]
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0 && isAbsolute(dir))
      .map((dir) => resolve(dir))
  );
  if (temps.some((dir) => path === dir || path.startsWith(`${dir}/`))) {
    return { durable: false, reason: "it is in a temporary directory" };
  }
  const segment = EPHEMERAL_SEGMENTS.find((name) => path.includes(`/${name}/`));
  if (segment) {
    return {
      durable: false,
      reason: `it is in a package cache or dependency directory (${segment})`,
    };
  }
  // A home directory kept in git (dotfiles) is not a source checkout: for a
  // path under `$HOME` the walk stops before `$HOME` itself.
  const home =
    opts.home === undefined ? normalizeHomeDir(process.env.HOME) : opts.home;
  const underHome = home !== null && path.startsWith(`${resolve(home)}/`);
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    if (underHome && home !== null && dir === resolve(home)) {
      break;
    }
    if (await exists(resolve(dir, ".git"))) {
      return {
        durable: false,
        reason: "it is inside a source checkout (build output)",
      };
    }
  }
  return { durable: true };
}

/**
 * Replaces only the program (first word) of `ExecStart=`, keeping every
 * other line of the unit, including a user's edits. Null when the unit has
 * no ExecStart or the program cannot be represented.
 */
export function retargetSystemdUnitProgram(opts: {
  readonly unitText: string;
  readonly hackBinPath: string;
}): string | null {
  const rendered = renderSystemdUnit({ hackBinPath: opts.hackBinPath });
  const renderedLine = rendered?.match(EXEC_START_PATTERN)?.[0];
  const current = opts.unitText.match(EXEC_START_PATTERN);
  if (
    !(renderedLine && current) ||
    parseSystemdExecProgram({ unitText: opts.unitText }).kind !== "path"
  ) {
    return null;
  }
  const line = current[1]?.trim() ?? "";
  let rest: string;
  if (line.startsWith('"')) {
    const close = line.indexOf('"', 1);
    rest = close < 0 ? "" : line.slice(close + 1);
  } else {
    const space = line.search(WHITESPACE);
    rest = space < 0 ? "" : line.slice(space);
  }
  const program = renderedLine
    .slice("ExecStart=".length)
    .match(QUOTED_PREFIX)?.[0];
  if (!program) {
    return null;
  }
  // A function replacement: `$` in the kept arguments (systemd's `$$`) must
  // not be read as a replacement pattern.
  return opts.unitText.replace(
    EXEC_START_PATTERN,
    () => `ExecStart=${program}${rest}`
  );
}

/** Doubles `%` so systemd does not expand it as a unit specifier. */
function escapeSpecifiers(value: string): string {
  return value.replace(/%/g, "%%");
}

/**
 * Characters a program path may not contain: control characters, and the
 * quote, backslash and `$` characters whose escaping differs between
 * `ExecStart=` and `Environment=`. Such paths are refused, not escaped.
 */
const UNREPRESENTABLE_PATH = /[\u0000-\u001f\u007f"\\$]/;

/**
 * Variables that make the dynamic loader or an interpreter run code before
 * (or instead of) the program Hack checked (HACK-2052): `LD_PRELOAD` and
 * the like for the `hack` binary, `BASH_ENV`, `NODE_OPTIONS`, `BUN_OPTIONS`
 * and the like for a `#!` launcher. Their contents cannot be vouched for:
 * the rendered unit unsets them all (`UnsetEnvironment=`, applied last, so
 * login starts are covered too), and a service that still sets one (a
 * drop-in overriding that) is refused, not inspected.
 */
const CODE_LOADING_ENV_KEYS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "GCONV_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
] as const;

/** The system directories on the PATH the rendered unit gives hackd. */
export const RENDERED_SYSTEM_PATH_DIRECTORIES = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
] as const;

/**
 * Renders the unit file. Returns null for a program path the unit cannot
 * represent safely (relative, a compiled Bun virtual path, or containing
 * control, quote, backslash or `$` characters).
 */
export function renderSystemdUnit(opts: {
  readonly hackBinPath: string;
}): string | null {
  const bin = opts.hackBinPath;
  if (
    !isAbsolute(bin) ||
    UNREPRESENTABLE_PATH.test(bin) ||
    isVirtualExecutablePath(bin)
  ) {
    return null;
  }
  const path = [
    escapeSpecifiers(dirname(bin)),
    ...RENDERED_SYSTEM_PATH_DIRECTORIES,
    "%h/.local/bin",
    "%h/.bun/bin",
    "%h/.hack/bin",
  ].join(":");
  return [
    "# Managed by hack: written by `hack daemon install`, removed by `hack daemon uninstall`.",
    "# Local changes are replaced on the next install; use `systemctl --user edit hackd` for overrides.",
    "[Unit]",
    "Description=hack local daemon (hackd)",
    // Bounds a crash loop (or a program that is gone at login) to five
    // starts a minute instead of one every RestartSec, forever.
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "KillMode=control-group",
    `ExecStart="${escapeSpecifiers(bin)}" daemon start --foreground`,
    "Restart=on-failure",
    "RestartSec=2",
    "WorkingDirectory=%h",
    `Environment="PATH=${path}"`,
    "Environment=HACK_NO_INTERACTIVE=1",
    "Environment=HACK_DAEMON_LOGIN_SERVICE=1",
    // Applied last by systemd, so it also strips what the user manager's
    // environment carries at each login start (HACK-2052).
    `UnsetEnvironment=${CODE_LOADING_ENV_KEYS.join(" ")}`,
    "StandardOutput=null",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const EXEC_START_PATTERN = /^ExecStart=(.*)$/m;
const WHITESPACE = /\s+/;
const NOT_BOOTED_WITH_SYSTEMD =
  /not been booted with systemd|not booted with systemd/i;
const NO_USER_BUS =
  /connect to (the )?bus|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i;
const UNIT_MISSING =
  /not loaded|does not exist|not found|could not be found|No such file/i;

/**
 * What a unit's `ExecStart=` runs, as far as this parser can tell.
 *
 * `path`: exactly one `ExecStart=` line whose program is a plain absolute
 * path (quoted or bare, `%%` the only specifier, no escapes).
 * `unknown`: anything else, for example an `-`, `@`, `:`, `+` or `!`
 * prefix, a specifier such as `%h`, an escape, a continuation line, or
 * several `ExecStart=` lines. Unknown is never evidence that the program is
 * missing: callers leave such a unit as it is (HACK-2052).
 */
export type SystemdExecProgram =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "none" };

const EXEC_START_LINE = /^\s*ExecStart\s*=(.*)$/gm;
const EXEC_PREFIX = /^[-@:+!|]/;

/** Reads the program (first word of `ExecStart=`) from unit text. */
export function parseSystemdExecProgram(opts: {
  readonly unitText: string;
}): SystemdExecProgram {
  const lines = [...opts.unitText.matchAll(EXEC_START_LINE)];
  if (lines.length === 0) {
    return { kind: "none" };
  }
  if (lines.length > 1) {
    return { kind: "unknown", reason: "several ExecStart= lines" };
  }
  const value = (lines[0]?.[1] ?? "").trim();
  if (value.length === 0) {
    return { kind: "none" };
  }
  if (value.endsWith("\\")) {
    return { kind: "unknown", reason: "a continued ExecStart= line" };
  }
  if (EXEC_PREFIX.test(value)) {
    return { kind: "unknown", reason: "an ExecStart= prefix" };
  }
  let word: string;
  if (value.startsWith('"')) {
    const close = value.indexOf('"', 1);
    if (close < 0) {
      return { kind: "unknown", reason: "an unterminated quote" };
    }
    word = value.slice(1, close);
  } else {
    word = value.split(WHITESPACE)[0] ?? "";
  }
  if (word.includes("\\") || word.includes("$") || word.includes("'")) {
    return { kind: "unknown", reason: "an escaped or expanded program" };
  }
  if (word.replace(/%%/g, "").includes("%")) {
    return { kind: "unknown", reason: "a specifier in the program path" };
  }
  const path = unescapeSystemdWord(word);
  if (!isAbsolute(path)) {
    return {
      kind: "unknown",
      reason: "a program that is not an absolute path",
    };
  }
  return { kind: "path", path };
}

/** The program path, or null when there is none or it is not understood. */
export function extractSystemdExecProgram(opts: {
  readonly unitText: string;
}): string | null {
  const parsed = parseSystemdExecProgram(opts);
  return parsed.kind === "path" ? parsed.path : null;
}

function unescapeSystemdWord(word: string): string {
  return word.replace(/%%/g, "%");
}

/**
 * The unit text this CLI would install now, or null when no installable
 * `hack` executable resolves (for example a source checkout with no `hack`
 * on PATH).
 */
export async function resolveExpectedSystemdUnit(): Promise<{
  readonly hackBinPath: string;
  readonly unitText: string;
} | null> {
  const invocation = await resolveHackInvocation();
  const hackBinPath = await resolveLaunchdHackBinPath({ invocation });
  if (!hackBinPath) {
    return null;
  }
  const unitText = renderSystemdUnit({ hackBinPath });
  return unitText ? { hackBinPath, unitText } : null;
}

export type SystemdUnavailableReason =
  | "no-systemctl"
  | "no-user-bus"
  | "not-systemd"
  | "error";

export type SystemdAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: SystemdUnavailableReason;
      readonly detail: string;
    };

/**
 * Probes the user service manager with a read-only `systemctl --user show
 * --property=Version`. Distinguishes a missing systemctl, a missing user bus
 * (SSH without a login session, containers) and a host not booted with
 * systemd (WSL without systemd, most containers).
 */
export async function probeSystemdUserManager(
  deps: SystemdDeps
): Promise<SystemdAvailability> {
  const result = await deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    "--property=Version",
  ]);
  if (result.exitCode === 0) {
    return { available: true };
  }
  const detail = firstLine(result.stderr) || `exit code ${result.exitCode}`;
  if (result.exitCode === 127) {
    return { available: false, reason: "no-systemctl", detail };
  }
  if (NOT_BOOTED_WITH_SYSTEMD.test(detail)) {
    return { available: false, reason: "not-systemd", detail };
  }
  if (NO_USER_BUS.test(result.stderr)) {
    return { available: false, reason: "no-user-bus", detail };
  }
  return { available: false, reason: "error", detail };
}

/** A short, user-facing explanation of why systemd cannot be used. */
export function describeSystemdUnavailable(opts: {
  readonly reason: SystemdUnavailableReason;
  readonly detail: string;
}): string {
  switch (opts.reason) {
    case "no-systemctl":
      return "systemctl was not found (no systemd on this host)";
    case "not-systemd":
      return "this system was not booted with systemd (common in containers and WSL without systemd)";
    case "no-user-bus":
      return `no systemd user session is reachable (${opts.detail}); log in through a normal session or enable linger`;
    default:
      return `systemctl --user failed: ${opts.detail}`;
  }
}

/**
 * `program-unknown`: the unit's ExecStart is not fully understood
 * ({@link parseSystemdExecProgram}); it is left as it is.
 */
export type SystemdUnitDrift =
  | "none"
  | "content"
  | "program-missing"
  | "program-unknown";

export interface SystemdServiceStatus {
  readonly unitPath: string;
  readonly availability: SystemdAvailability;
  /** The unit file exists at {@link unitPath}. */
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly activeState: string | null;
  readonly mainPid: number | null;
  /**
   * systemd's loaded copy of the unit is older than the file
   * (`NeedDaemonReload=yes`), for example after a rewrite whose
   * `daemon-reload` failed. A retry must reload before it starts.
   */
  readonly needsReload: boolean;
  readonly program: string | null;
  /** Only meaningful when installed; "none" otherwise. */
  readonly drift: SystemdUnitDrift;
  /** null when unknown (loginctl missing or failed). */
  readonly linger: boolean | null;
  /**
   * Why the unit's state could not be read (the unit-specific `systemctl
   * show` failed or timed out), else null. A unit systemd does not know is
   * not an error: `show` reports it as `not-found`/`inactive`. Callers must
   * not read a null `activeState` with an error here as "not running".
   */
  readonly stateError: string | null;
}

/**
 * Read-only status: the unit file, `systemctl --user show` and linger.
 *
 * Returns null when {@link resolveSystemdAccess} denies access; nothing is
 * read in that case.
 */
export async function readSystemdServiceStatus(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<SystemdServiceStatus | null> {
  if (!resolveSystemdAccess({ env: opts.deps.env }).allowed) {
    return null;
  }
  const exists = opts.exists ?? pathExists;
  const unitText = await readTextFile(opts.unitPath);
  const installed = unitText !== null;
  const parsed = unitText
    ? parseSystemdExecProgram({ unitText })
    : ({ kind: "none" } as const);
  const program = parsed.kind === "path" ? parsed.path : null;
  const drift = await computeDrift({ unitText, parsed, exists });

  const availability = await probeSystemdUserManager(opts.deps);
  const linger = await readLingerStatus(opts.deps);
  if (!availability.available) {
    return {
      unitPath: opts.unitPath,
      availability,
      installed,
      loaded: false,
      enabled: false,
      active: false,
      activeState: null,
      mainPid: null,
      needsReload: false,
      program,
      drift,
      linger,
      stateError: null,
    };
  }

  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=LoadState,ActiveState,UnitFileState,MainPID,NeedDaemonReload",
  ]);
  const props = show.exitCode === 0 ? parseSystemdProperties(show.stdout) : {};
  const stateError = describeStateError({ show, props });
  const mainPidRaw = Number.parseInt(props.MainPID ?? "", 10);
  return {
    unitPath: opts.unitPath,
    availability,
    installed,
    loaded: props.LoadState === "loaded",
    enabled: props.UnitFileState === "enabled",
    active: props.ActiveState === "active",
    activeState: props.ActiveState ?? null,
    mainPid: Number.isFinite(mainPidRaw) && mainPidRaw > 0 ? mainPidRaw : null,
    needsReload: props.NeedDaemonReload === "yes",
    program,
    drift,
    linger,
    stateError,
  };
}

/**
 * A failed unit query whose only diagnostic names hackd.service itself as
 * absent ("Unit hackd.service could not be found.", with an optional
 * "Failed to get properties:" prefix), and nothing else. Anything broader
 * (a missing bus socket, "No such file or directory", a runner's
 * "systemctl not found", a timeout) does not establish that the unit is
 * gone, so it is not matched (HACK-2142).
 */
const NAMED_UNIT_ABSENT =
  /^(?:Failed to get properties: )?Unit hackd\.service (?:could not be found|not found|not loaded)\.?$/;
/** Runner exits that mean the query never ran or never finished. */
const QUERY_NOT_RUN_EXIT_CODES = new Set([124, 126, 127]);

function isNamedUnitAbsent(show: ServiceCommandResult): boolean {
  if (QUERY_NOT_RUN_EXIT_CODES.has(show.exitCode)) {
    return false;
  }
  const lines = show.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length > 0 && lines.every((line) => NAMED_UNIT_ABSENT.test(line))
  );
}

/**
 * Why the unit-specific `systemctl show` did not report a state, or null.
 * systemd reports a unit it does not know as `not-found`/`inactive` with
 * exit 0; a failure whose only diagnostic names hackd.service as absent
 * ({@link isNamedUnitAbsent}) is no error either. Every other failure
 * (bus, tool discovery, timeout, anything else) is kept.
 */
function describeStateError(opts: {
  readonly show: ServiceCommandResult;
  readonly props: Readonly<Record<string, string>>;
}): string | null {
  const { show } = opts;
  if (show.exitCode !== 0) {
    return isNamedUnitAbsent(show)
      ? null
      : `systemctl --user show ${SYSTEMD_UNIT_NAME} failed: ${firstLine(show.stderr) || `exit code ${show.exitCode}`}`;
  }
  return opts.props.ActiveState === undefined
    ? `systemctl --user show ${SYSTEMD_UNIT_NAME} reported no ActiveState`
    : null;
}

/**
 * Drift is judged against the unit this version of hack renders for the
 * unit's own program, not for the `hack` on the caller's PATH. Two shells
 * whose PATHs resolve different (existing) `hack` binaries therefore agree
 * that the unit is current, instead of each reporting the other's unit as
 * drifted and rewriting it back and forth (with a restart each time).
 */
async function computeDrift(opts: {
  readonly unitText: string | null;
  readonly parsed: SystemdExecProgram;
  readonly exists: (path: string) => Promise<boolean>;
}): Promise<SystemdUnitDrift> {
  if (opts.unitText === null) {
    return "none";
  }
  if (opts.parsed.kind === "unknown") {
    return "program-unknown";
  }
  if (opts.parsed.kind === "none" || !(await opts.exists(opts.parsed.path))) {
    return "program-missing";
  }
  const rendered = renderSystemdUnit({ hackBinPath: opts.parsed.path });
  return rendered === opts.unitText ? "none" : "content";
}

const CGROUP_UNIT_SUFFIX = `/${SYSTEMD_UNIT_NAME}`;

/**
 * Whether `pid` runs in hackd.service's cgroup, read from
 * `/proc/<pid>/cgroup`. This holds for hackd even when `MainPID` is a
 * wrapper script that runs it as a child. Null when it cannot be read (not
 * Linux, process gone).
 */
export async function isPidInSystemdUnit(opts: {
  readonly pid: number;
  readonly readText?: (path: string) => Promise<string | null>;
}): Promise<boolean | null> {
  const text = await (opts.readText ?? readTextFile)(
    `/proc/${opts.pid}/cgroup`
  );
  if (text === null) {
    return null;
  }
  // A user unit lives under `.../user@<uid>.service/.../hackd.service`; a
  // system unit of the same name does not count.
  return text.split("\n").some((line) => {
    const trimmed = line.trimEnd();
    return trimmed.includes("/user@") && trimmed.endsWith(CGROUP_UNIT_SUFFIX);
  });
}

/** Parses `systemctl show` `Key=Value` lines. */
export function parseSystemdProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export type SystemdUnitHackHome =
  | { readonly kind: "home"; readonly path: string }
  | { readonly kind: "unknown"; readonly detail: string };

const ENV_WORD = /"([^"]*)"|(\S+)/g;

/** The variables Hack reads from the service environment. */
const SERVICE_ENV_KEYS = [
  "PATH",
  "HOME",
  "HACK_HOME",
  ...CODE_LOADING_ENV_KEYS,
] as const;
type ServiceEnvKey = (typeof SERVICE_ENV_KEYS)[number];

function isServiceEnvKey(name: string): name is ServiceEnvKey {
  return (SERVICE_ENV_KEYS as readonly string[]).includes(name);
}

/**
 * The values of PATH, HOME, HACK_HOME and the code-loading variables
 * ({@link CODE_LOADING_ENV_KEYS}) that hackd.service gets, built the
 * way systemd builds a user service's environment (HACK-2052): the user
 * manager's environment (`show-environment`, inherited by every service),
 * then the unit's `Environment=` (unit file and drop-ins, later wins), then
 * `UnsetEnvironment=` applied last (`NAME` removes it, `NAME=VALUE` removes
 * only that exact assignment). An absent key is not set in the service.
 *
 * Refused (an error) when the result cannot be established with certainty:
 * systemd cannot be asked, the unit reads an `EnvironmentFile=` (its
 * contents are not visible here), `PassEnvironment=` names one of these
 * keys (it copies from the manager's own process environment), or a value
 * for one of them uses quoting or escapes this parser does not decode.
 */
export async function readSystemdServiceEnvironment(opts: {
  readonly deps: SystemdDeps;
}): Promise<
  | { readonly env: Readonly<Partial<Record<ServiceEnvKey, string>>> }
  | { readonly error: string }
> {
  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=Environment,EnvironmentFiles,UnsetEnvironment,PassEnvironment,ExecSearchPath",
  ]);
  if (show.exitCode !== 0) {
    return {
      error: `systemd did not report the ${SYSTEMD_UNIT_NAME} environment (${firstLine(show.stderr) || `exit code ${show.exitCode}`})`,
    };
  }
  const props = parseSystemdProperties(show.stdout);
  if ((props.EnvironmentFiles ?? "").length > 0) {
    return {
      error: `${SYSTEMD_UNIT_NAME} reads an EnvironmentFile, whose variables (PATH, HOME, HACK_HOME, loader settings) cannot be checked; move what it sets into Environment= or remove the EnvironmentFile`,
    };
  }
  // ExecSearchPath= (systemd 250+) sets the service's PATH, between the
  // manager environment and Environment=; Hack writes none.
  if ((props.ExecSearchPath ?? "").length > 0) {
    return {
      error: `${SYSTEMD_UNIT_NAME} sets ExecSearchPath=, which Hack does not check; set PATH with Environment= instead`,
    };
  }
  // `systemctl show` escapes quotes, backslashes, `$` and backticks inside a
  // quoted value, which the word split here does not decode: an escape
  // anywhere could shift where a PATH or HACK_HOME word starts.
  for (const setting of ["Environment", "UnsetEnvironment"] as const) {
    if ((props[setting] ?? "").includes("\\")) {
      return {
        error: `${SYSTEMD_UNIT_NAME} has an ${setting}= value that systemd reports with an escape Hack does not read (the value contains a quote, backslash, $ or backtick); remove that character from the value or move the setting out of hackd.service`,
      };
    }
  }
  const passed = splitEnvironmentWords(props.PassEnvironment ?? "");
  const passedKey = SERVICE_ENV_KEYS.find((key) => passed.includes(key));
  if (passedKey !== undefined) {
    return {
      error: `${SYSTEMD_UNIT_NAME} sets PassEnvironment=${passedKey}, whose value cannot be read here; remove it`,
    };
  }
  const manager = await readManagerEnvironment({ deps: opts.deps });
  if ("error" in manager) {
    return { error: manager.error };
  }
  const env: Partial<Record<ServiceEnvKey, string>> = {};
  for (const key of SERVICE_ENV_KEYS) {
    if (manager.unreadable.has(key)) {
      return {
        error: `the user manager's ${key} uses quoting Hack does not read`,
      };
    }
    const value = manager.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  applyUnitEnvironment({ env, props });
  return { env };
}

/**
 * Applies the unit's `Environment=` and then its `UnsetEnvironment=` to
 * `env` for the keys Hack reads (escapes were refused before this).
 */
function applyUnitEnvironment(opts: {
  readonly env: Partial<Record<ServiceEnvKey, string>>;
  readonly props: Readonly<Record<string, string>>;
}): void {
  const { env, props } = opts;
  for (const word of splitEnvironmentWords(props.Environment ?? "")) {
    const eq = word.indexOf("=");
    const name = eq > 0 ? word.slice(0, eq) : "";
    if (isServiceEnvKey(name)) {
      env[name] = word.slice(eq + 1);
    }
  }
  for (const word of splitEnvironmentWords(props.UnsetEnvironment ?? "")) {
    const eq = word.indexOf("=");
    const name = eq < 0 ? word : word.slice(0, eq);
    if (!isServiceEnvKey(name)) {
      continue;
    }
    // `NAME=VALUE` removes only that exact assignment.
    if (eq < 0 || env[name] === word.slice(eq + 1)) {
      delete env[name];
    }
  }
}

/** The words of a `systemctl show` environment list (quotes removed). */
function splitEnvironmentWords(value: string): string[] {
  return [...value.matchAll(ENV_WORD)].map(
    (match) => match[1] ?? match[2] ?? ""
  );
}

/**
 * The Hack home the unit's hackd uses: `HACK_HOME` from the service's
 * effective environment ({@link readSystemdServiceEnvironment}), else
 * `$HOME/.hack` with the service's `HOME` (or, when it has none, the
 * account's home from the password database). Unknown when that environment cannot be established or the
 * value is relative: callers then refuse rather than guess.
 */
export async function readSystemdUnitHackHome(opts: {
  readonly deps: SystemdDeps;
}): Promise<SystemdUnitHackHome> {
  const read = await readSystemdServiceEnvironment({ deps: opts.deps });
  if ("error" in read) {
    return { kind: "unknown", detail: read.error };
  }
  const { env } = read;
  const override = (env.HACK_HOME ?? "").trim();
  if (override.length > 0) {
    return isAbsolute(override)
      ? { kind: "home", path: resolve(override) }
      : { kind: "unknown", detail: `HACK_HOME=${override} is relative` };
  }
  const serviceHome = (env.HOME ?? "").trim();
  if (serviceHome.length > 0 && !isAbsolute(serviceHome)) {
    // hackd rejects a relative HOME and has no Hack home to serve.
    return { kind: "unknown", detail: `HOME=${serviceHome} is relative` };
  }
  // With no HOME in the service (unset by UnsetEnvironment=, or never
  // set), hackd falls back to the account's home from the password
  // database, not to the invoking shell's HOME.
  const home =
    normalizeHomeDir(serviceHome) ??
    normalizeHomeDir((await readAccountHome({ deps: opts.deps })) ?? undefined);
  if (!home) {
    return {
      kind: "unknown",
      detail:
        "the service has no HOME and the account's home could not be read",
    };
  }
  return { kind: "home", path: resolve(home, GLOBAL_HACK_DIR_NAME) };
}

/**
 * The account's home from the password database (NSS included), or null:
 * `getent passwd <uid>`, field 6. Not `os.userInfo()`, which under Bun
 * returns `$HOME` when it is set.
 */
async function readAccountHome(opts: {
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  if (opts.deps.uid < 0) {
    return null;
  }
  const result = await opts.deps.run("getent", [
    "passwd",
    String(opts.deps.uid),
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const fields = (result.stdout.split("\n")[0] ?? "").split(":");
  return fields.length >= 7 ? (fields[5] ?? null) : null;
}

/**
 * `systemctl --user show-environment`: what every user service inherits.
 * `unreadable` names variables printed with escapes this does not decode.
 */
async function readManagerEnvironment(opts: {
  readonly deps: SystemdDeps;
}): Promise<
  | {
      readonly env: Readonly<Record<string, string>>;
      readonly unreadable: ReadonlySet<string>;
    }
  | { readonly error: string }
> {
  const result = await opts.deps.run("systemctl", [
    "--user",
    "show-environment",
  ]);
  if (result.exitCode !== 0) {
    return {
      error: `systemctl --user show-environment failed: ${firstLine(result.stderr) || `exit code ${result.exitCode}`}`,
    };
  }
  const env: Record<string, string> = {};
  const unreadable = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq);
    const value = unquoteShellValue(line.slice(eq + 1));
    if (value === null) {
      unreadable.add(key);
    } else {
      env[key] = value;
    }
  }
  return { env, unreadable };
}

/**
 * `systemctl show-environment` prints values in shell quoting when they
 * need it (`$'...'` or `"..."`); plain values are printed as is. Null for
 * a `$'...'` value with escapes, which is not decoded here.
 */
function unquoteShellValue(value: string): string | null {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (value.length >= 3 && value.startsWith("$'") && value.endsWith("'")) {
    const inner = value.slice(2, -1);
    return inner.includes("\\") ? null : inner;
  }
  return value;
}

/** Reads `Linger` for the current user; null when it cannot be determined. */
export async function readLingerStatus(
  deps: SystemdDeps
): Promise<boolean | null> {
  if (deps.uid < 0) {
    return null;
  }
  const result = await deps.run("loginctl", [
    "show-user",
    String(deps.uid),
    "--property=Linger",
    "--value",
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  if (value === "yes") {
    return true;
  }
  if (value === "no") {
    return false;
  }
  return null;
}

/**
 * The exact command the user runs to keep their user services running
 * without a login session. With no user argument loginctl applies it to the
 * calling user, so the hint needs no user name lookup.
 */
export const LINGER_ENABLE_COMMAND = "loginctl enable-linger";

export type SystemdInstallResult =
  | { readonly ok: true; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly error: string;
      readonly unavailable?: SystemdAvailability & {
        readonly available: false;
      };
    };

/**
 * Writes the unit (atomically, only when its text differs), reloads systemd
 * when it changed, and enables it for `default.target`. Starting is separate
 * ({@link systemdServiceAction}) so the caller can retire a directly started
 * hackd first.
 *
 * Refuses before writing anything when the user manager is unavailable.
 */
export async function installSystemdUnit(opts: {
  readonly unitPath: string;
  readonly unitText: string;
  readonly deps: SystemdDeps;
  /**
   * Run `systemctl --user enable` (default true). A start-time repair passes
   * the unit's current state, so a unit the user disabled stays disabled.
   */
  readonly enable?: boolean;
  /**
   * Reload even when the file is unchanged: systemd reported
   * `NeedDaemonReload=yes`, so an earlier reload after a write failed.
   */
  readonly forceReload?: boolean;
  /**
   * The installing CLI's Hack home: before enabling, the unit's effective
   * HACK_HOME (drop-ins included) must be this one. Unset for the start
   * repair, which does not enable.
   */
  readonly hackHome?: string;
}): Promise<SystemdInstallResult> {
  const access = resolveSystemdAccess({ env: opts.deps.env });
  if (!access.allowed) {
    return { ok: false, error: access.message };
  }
  const availability = await probeSystemdUserManager(opts.deps);
  if (!availability.available) {
    return {
      ok: false,
      error: describeSystemdUnavailable(availability),
      unavailable: availability,
    };
  }

  const unitDir = dirname(opts.unitPath);
  const secured = await ensureOwnerWritableOnlyDirectories({
    // `$XDG_CONFIG_HOME`, `systemd/` and `systemd/user/`.
    dirs: [dirname(dirname(unitDir)), dirname(unitDir), unitDir],
  });
  if (!secured.ok) {
    return { ok: false, error: secured.error };
  }
  // After Hack's own directories are secured: the config unit directory is
  // one of the load paths.
  const dropIns =
    (await checkSystemdUnitDirectoryChain({ unitPath: opts.unitPath })) ??
    (await checkSystemdUnitDropIns({ unitPath: opts.unitPath })) ??
    (await checkSystemdUnitLoadPaths({ deps: opts.deps }));
  if (dropIns !== null) {
    return { ok: false, error: dropIns };
  }
  // Install writes the whole file: an existing one that another account
  // could have written (or a link) is removed and written fresh, never
  // trusted for being unchanged.
  if (await isUnitFileReplaceable({ unitPath: opts.unitPath })) {
    await rm(opts.unitPath, { force: true });
  }
  const { changed } = await writeTextFileAtomicIfChanged(
    opts.unitPath,
    opts.unitText,
    { createMode: 0o644 }
  );
  // An unchanged file is not rewritten: it must already be this user's.
  const unitFile = await checkSystemdUnitFile({ unitPath: opts.unitPath });
  if (unitFile !== null) {
    return { ok: false, error: unitFile };
  }
  if (changed || opts.forceReload === true) {
    const reload = await opts.deps.run("systemctl", [
      "--user",
      "daemon-reload",
    ]);
    if (reload.exitCode !== 0) {
      return {
        ok: false,
        error: `systemctl --user daemon-reload failed: ${firstLine(reload.stderr) || `exit code ${reload.exitCode}`}`,
      };
    }
  }
  if (opts.enable === false) {
    return { ok: true, changed };
  }
  const beforeEnable = await checkBeforeEnable({
    deps: opts.deps,
    hackHome: opts.hackHome,
  });
  if (beforeEnable !== null) {
    return { ok: false, error: beforeEnable };
  }
  const enable = await opts.deps.run("systemctl", [
    "--user",
    "enable",
    SYSTEMD_UNIT_NAME,
  ]);
  if (enable.exitCode !== 0) {
    return {
      ok: false,
      error: `systemctl --user enable ${SYSTEMD_UNIT_NAME} failed: ${firstLine(enable.stderr) || `exit code ${enable.exitCode}`}`,
    };
  }
  return { ok: true, changed };
}

/**
 * Creates (top-down) and checks the directories that hold the unit. Each
 * must be a directory owned by this user and not writable by its group or
 * others: otherwise another account could replace `hackd.service`, and the
 * enabled unit would run its `ExecStart` as this user at the next login
 * (HACK-2052). New directories are created `0755` whatever the umask; an
 * existing one this user owns has group/other write removed; anything else
 * is refused before the unit is written. A symlinked directory is judged by
 * its real target.
 */
export async function ensureOwnerWritableOnlyDirectories(opts: {
  readonly dirs: readonly string[];
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  // Before creating or chmod-ing anything: what holds the first directory
  // must not be writable by others, or they could swap a just-created
  // directory for a link between mkdir and chmod (the chmod would follow
  // it). Nothing is repaired here.
  const first = opts.dirs[0];
  if (first !== undefined) {
    const parent = checkParentNotReplaceable({ dir: first, uid });
    if (parent !== null) {
      return { ok: false, error: parent };
    }
  }
  for (const dir of opts.dirs) {
    const created = await createDirectoryExactly(dir);
    const error =
      created ?? (await checkOwnerWritableOnlyDirectory({ dir, uid }));
    if (error !== null) {
      return { ok: false, error };
    }
  }
  return { ok: true };
}

/**
 * The chain to `dir`'s parent (or, when it is missing, its deepest
 * existing directory) must not be replaceable, and that directory must not
 * let others create entries. Null, or the refusal.
 */
function checkParentNotReplaceable(opts: {
  readonly dir: string;
  readonly uid: number;
}): string | null {
  const walk = walkReplaceableChain({
    path: dirname(resolve(opts.dir)),
    uid: opts.uid,
    hackHome: null,
    allowMissing: true,
  });
  if ("error" in walk) {
    return `${opts.dir} is not safe to create in: ${walk.error}`;
  }
  const creatable = lettingOthersCreate(walk.existing);
  return creatable === null
    ? null
    : `${walk.existing} is writable by other users (${creatable}), so ${opts.dir} cannot be created safely; run: chmod go-w ${walk.existing}`;
}

/** mkdir at `0755` whatever the umask; an existing directory is kept. */
async function createDirectoryExactly(dir: string): Promise<string | null> {
  try {
    await mkdir(dir, { mode: 0o755 });
    // Never chmod through a link: confirm what was created first.
    if (!lstatSync(dir).isDirectory()) {
      return `${dir} changed while it was created`;
    }
    // mkdir applies the umask, which can only remove bits; set it exactly.
    await chmod(dir, 0o755);
    return null;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    return `Could not create ${dir}: ${errorMessage(error)}`;
  }
}

/** Null when `dir` is this user's and not group/other-writable (fixed if possible). */
async function checkOwnerWritableOnlyDirectory(opts: {
  readonly dir: string;
  readonly uid: number;
}): Promise<string | null> {
  return await checkOwnerControlledPath({
    path: opts.dir,
    uid: opts.uid,
    directory: true,
  });
}

/**
 * Null when `path` (resolved) is owned by `uid` and not writable by group or
 * others; group/other write is removed when this user owns it. `directory`
 * says which kind it must be.
 */
async function checkOwnerControlledPath(opts: {
  readonly path: string;
  readonly uid: number;
  readonly directory: boolean;
  /** Also accept root-owned (system configuration such as /etc/systemd/user). */
  readonly allowRoot?: boolean;
}): Promise<string | null> {
  let real: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    real = await realpath(opts.path);
    info = await stat(real);
  } catch (error: unknown) {
    return `Could not inspect ${opts.path}: ${errorMessage(error)}`;
  }
  const shown = real === opts.path ? opts.path : `${opts.path} (${real})`;
  if (opts.directory ? !info.isDirectory() : !info.isFile()) {
    return `${shown} is not a ${opts.directory ? "directory" : "regular file"}`;
  }
  const rootOwned = opts.allowRoot === true && info.uid === 0;
  if (opts.uid >= 0 && info.uid !== opts.uid && !rootOwned) {
    return `${shown} is owned by another user (uid ${info.uid})`;
  }
  if ((info.mode & 0o022) === 0) {
    return null;
  }
  if (!opts.directory) {
    // Its contents may already be someone else's: a chmod would keep them.
    return `${shown} was writable by other users (mode ${(info.mode & 0o777).toString(8)}), so its contents cannot be trusted`;
  }
  try {
    await chmod(real, info.mode & 0o7755);
  } catch {
    // Checked below.
  }
  const after = (await stat(real)).mode & 0o777;
  return (after & 0o022) === 0
    ? null
    : `${shown} is writable by other users (mode ${after.toString(8)}); run: chmod go-w ${real}`;
}

/**
 * systemd applies drop-ins from `hackd.service.d/` and the `service.d/`
 * that covers every user service. One that another account wrote (for
 * example while the directory was group-writable) would replace
 * `ExecStart` and run as this user, so before the unit is written,
 * reloaded or started, each drop-in directory that exists and every entry
 * in it must be this user's and not writable by others (HACK-2052).
 * Returns null, or the reason it refuses.
 */
export async function checkSystemdUnitDropIns(opts: {
  readonly unitPath: string;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const unitDir = dirname(opts.unitPath);
  for (const name of [`${SYSTEMD_UNIT_NAME}.d`, "service.d"]) {
    const dir = resolve(unitDir, name);
    const dangling = await checkDanglingDropInDirectory({ dir, uid });
    if (dangling !== "present") {
      if (dangling === null) {
        continue;
      }
      return `Not using ${SYSTEMD_UNIT_NAME}: its drop-in ${dangling}`;
    }
    const error =
      (await checkOwnerWritableOnlyDirectory({ dir, uid })) ??
      (await checkDropInEntries({ dir, uid }));
    if (error !== null) {
      return `Not using ${SYSTEMD_UNIT_NAME}: its drop-in ${error}. Review and remove it, then run: hack daemon install`;
    }
  }
  return null;
}

/**
 * A drop-in directory entry that is absent, or a symlink whose target does
 * not exist (yet). `"present"` means the target exists and the caller runs
 * its full checks. For a dangling link the target is walked in filesystem
 * order (every link and directory on the way checked) and the deepest
 * existing directory must not let others create the rest: systemd follows
 * the link once someone creates the target (HACK-2052). Null when there is
 * nothing to check (no entry at all), else the refusal.
 */
async function checkDanglingDropInDirectory(opts: {
  readonly dir: string;
  readonly uid: number;
}): Promise<string | null | "present"> {
  if (await pathExists(opts.dir)) {
    return "present";
  }
  if (!entryExists(opts.dir)) {
    return null;
  }
  const walk = await walkReplaceableChain({
    path: opts.dir,
    uid: opts.uid,
    hackHome: null,
    allowMissing: true,
  });
  if ("error" in walk) {
    return walk.error;
  }
  const creatable = lettingOthersCreate(walk.existing);
  return creatable === null
    ? null
    : `directory ${opts.dir} is a link to a path that does not exist yet, and ${walk.existing} lets other users create it (${creatable}); run: chmod go-w ${walk.existing}, or remove the link`;
}

async function checkDropInEntries(opts: {
  readonly dir: string;
  readonly uid: number;
  readonly allowRoot?: boolean;
}): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch (error: unknown) {
    return `directory ${opts.dir} could not be read: ${errorMessage(error)}`;
  }
  // systemd loads only `*.conf` from a drop-in directory; backups and
  // subdirectories are ignored there, so they are here too (the directory
  // itself is still checked by the caller).
  for (const entry of entries.filter((name) => name.endsWith(".conf"))) {
    const error = await checkDropInFile({
      path: resolve(opts.dir, entry),
      uid: opts.uid,
      allowRoot: opts.allowRoot,
    });
    if (error !== null) {
      return error;
    }
  }
  return null;
}

/**
 * One drop-in: a regular file owned by this user (or root) that others
 * cannot write, with nothing replaceable on the way to it (a symlinked
 * drop-in can route through a directory others can replace). A link to
 * exactly `/dev/null` is systemd's way to mask a drop-in: the link and the
 * directories above it are checked, and `/dev/null` itself is not.
 */
async function checkDropInFile(opts: {
  readonly path: string;
  readonly uid: number;
  readonly allowRoot?: boolean;
}): Promise<string | null> {
  if (await isDevNullMask(opts.path)) {
    return await checkReplaceableChain({
      path: opts.path,
      uid: opts.uid,
      hackHome: null,
      stopAtLink: true,
    });
  }
  return (
    (await checkOwnerControlledPath({
      path: opts.path,
      uid: opts.uid,
      directory: false,
      allowRoot: opts.allowRoot,
    })) ??
    (await checkReplaceableChain({
      path: opts.path,
      uid: opts.uid,
      hackHome: null,
    }))
  );
}

async function isDevNullMask(path: string): Promise<boolean> {
  try {
    return (
      (await lstat(path)).isSymbolicLink() &&
      (await readlink(path)) === "/dev/null"
    );
  } catch {
    return false;
  }
}

/**
 * The unit file systemd will run, and the directories above it, must be
 * this user's and not writable by others: a shared-group member who could
 * plant or edit `hackd.service` would have its `ExecStart` run as this user
 * (HACK-2052). The unit must be a regular file, not a symlink (Hack writes
 * a regular file; anything else was put there by someone else). Write
 * access is removed from what this user owns; anything else is refused.
 * Drop-ins are checked by {@link checkSystemdUnitDropIns}.
 */
export async function checkSystemdUnitFile(opts: {
  readonly unitPath: string;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const unitDir = dirname(opts.unitPath);
  for (const dir of [dirname(dirname(unitDir)), dirname(unitDir), unitDir]) {
    const error = await checkOwnerWritableOnlyDirectory({ dir, uid });
    if (error !== null) {
      return `Not using ${SYSTEMD_UNIT_NAME}: ${error}`;
    }
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(opts.unitPath);
  } catch (error: unknown) {
    return `Not using ${SYSTEMD_UNIT_NAME}: could not inspect ${opts.unitPath}: ${errorMessage(error)}`;
  }
  if (!info.isFile()) {
    return `Not using ${SYSTEMD_UNIT_NAME}: ${opts.unitPath} is not a regular file (a symlink or other entry Hack did not write). Review and remove it, then run: hack daemon install`;
  }
  const error = await checkOwnerControlledPath({
    path: opts.unitPath,
    uid,
    directory: false,
  });
  if (error !== null) {
    return `Not using ${SYSTEMD_UNIT_NAME}: ${error}. Review and remove it, then run: hack daemon install`;
  }
  return await checkSystemdUnitDirectoryChain({
    unitPath: opts.unitPath,
    uid,
  });
}

/**
 * The directories above the unit, past `$XDG_CONFIG_HOME` up to `/` and
 * through every symlink hop, must not be replaceable by another account: a
 * writable home lets someone rename `.config` and plant their own unit.
 * Hack does not change those directories; it refuses with the `chmod` to
 * run.
 */
export async function checkSystemdUnitDirectoryChain(opts: {
  readonly unitPath: string;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const error = await checkReplaceableChain({
    path: dirname(opts.unitPath),
    uid: opts.uid ?? process.getuid?.() ?? -1,
    hackHome: null,
  });
  return error === null ? null : `Not using ${SYSTEMD_UNIT_NAME}: ${error}`;
}

/** {@link checkSystemdUnitFile}, then {@link checkSystemdUnitDropIns}. */
export async function checkSystemdUnitTrusted(opts: {
  readonly unitPath: string;
  readonly uid?: number;
}): Promise<string | null> {
  return (
    (await checkSystemdUnitFile(opts)) ?? (await checkSystemdUnitDropIns(opts))
  );
}

/**
 * What systemd will actually load for hackd.service, checked right before
 * a start or restart (HACK-2052). systemd merges drop-ins from every
 * user-unit load path (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, runtime and
 * system directories), so only the manager's own `FragmentPath` and
 * `DropInPaths` are complete. The fragment must be the unit Hack manages,
 * and every drop-in, and the directory holding it, must be owned by this
 * user or root and not writable by others. Unknown (systemctl fails) is
 * refused like an untrusted path.
 */
export async function checkSystemdLoadedUnitPaths(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const loadPaths = await checkSystemdUnitLoadPaths({ deps: opts.deps, uid });
  if (loadPaths !== null) {
    return loadPaths;
  }
  const servicePath = await readSystemdServicePathDirectories({
    deps: opts.deps,
  });
  const pathError =
    ("error" in servicePath
      ? servicePath.error
      : await checkServicePathDirectories({
          dirs: servicePath.dirs,
          uid,
        })) ?? (await checkSystemdServicePrograms({ deps: opts.deps }));
  if (pathError !== null) {
    return `Not starting ${SYSTEMD_UNIT_NAME}: ${pathError}`;
  }
  const files = await checkLoadedUnitFiles({
    unitPath: opts.unitPath,
    deps: opts.deps,
    uid,
  });
  return files === null ? null : `Not starting ${SYSTEMD_UNIT_NAME}: ${files}`;
}

/**
 * The files systemd has loaded for hackd.service (`FragmentPath`,
 * `DropInPaths`): the fragment must be the unit Hack manages, and every
 * drop-in, the directories above it and every symlink hop must belong to
 * this user or root and not be writable by others. Null, or why not.
 */
async function checkLoadedUnitFiles(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly uid: number;
}): Promise<string | null> {
  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=FragmentPath,DropInPaths",
  ]);
  if (show.exitCode !== 0) {
    return `systemd did not report which files it loads (${firstLine(show.stderr) || `exit code ${show.exitCode}`})`;
  }
  const props = parseSystemdProperties(show.stdout);
  const fragment = props.FragmentPath ?? "";
  if (resolve(fragment) !== resolve(opts.unitPath)) {
    return `systemd loads it from ${fragment || "an unknown file"}, not ${opts.unitPath}; review that file`;
  }
  const dropIns = await parseSystemdPathList(props.DropInPaths ?? "");
  if ("error" in dropIns) {
    return dropIns.error;
  }
  for (const path of dropIns.paths) {
    // The file, every directory above it up to `/`, and every symlink hop.
    const error = await checkDropInFile({
      path,
      uid: opts.uid,
      allowRoot: true,
    });
    if (error !== null) {
      return `its drop-in ${error}. Review and remove it, then run: systemctl --user daemon-reload`;
    }
  }
  return null;
}

/**
 * The program a login service runs must be replaceable only by this user
 * or root (HACK-2052): the binary, its resolved target, and every directory
 * above each of them up to `/`. Sticky world-writable directories such as
 * `/tmp` are allowed (others cannot replace entries they do not own). Group
 * or other write is removed inside `hackHome`, which Hack owns (an
 * installer under umask `0002` leaves `~/.hack/bin` at `0775`); anywhere
 * else Hack does not change your directories and refuses with the `chmod`
 * to run. Returns null, or the reason it refuses.
 */
export async function checkServiceExecutableTrusted(opts: {
  readonly path: string;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  try {
    await realpath(opts.path);
  } catch (error: unknown) {
    return `${opts.path} could not be resolved: ${errorMessage(error)}`;
  }
  const error = await checkReplaceableChain({
    path: opts.path,
    uid,
    // Nothing is repaired on the way to a program a login service runs:
    // whatever could be written may already have been.
    hackHome: null,
  });
  return error === null
    ? null
    : `${SYSTEMD_UNIT_NAME} would run ${opts.path}, but ${error}`;
}

/**
 * Every directory the user manager loads units from (`UnitPath`:
 * `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, runtime and system directories)
 * must not be writable by another account, now or later (HACK-2052): one
 * that can add `hackd.service.d/override.conf` to any of them replaces
 * `ExecStart` at the next login. For each directory, the nearest one that
 * exists (so nobody else can create a missing one) gets the chain check of
 * {@link checkReplaceableChain}, and drop-ins already in it must belong to
 * this user or root and not be writable by others. Unknown (systemctl
 * fails or reports no path) is refused.
 */
export async function checkSystemdUnitLoadPaths(opts: {
  readonly deps: SystemdDeps;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    "--property=UnitPath",
  ]);
  const parsed =
    show.exitCode === 0
      ? await parseSystemdPathList(
          parseSystemdProperties(show.stdout).UnitPath ?? ""
        )
      : { paths: [] };
  if ("error" in parsed) {
    return `Not using ${SYSTEMD_UNIT_NAME}: ${parsed.error}`;
  }
  const paths = parsed.paths;
  if (paths.length === 0) {
    return `Not using ${SYSTEMD_UNIT_NAME}: systemd did not report where it loads user units from (${firstLine(show.stderr) || `exit code ${show.exitCode}`})`;
  }
  for (const path of paths) {
    const error = await checkUnitLoadDirectory({ path, uid });
    if (error !== null) {
      return `Not using ${SYSTEMD_UNIT_NAME}: in user unit directory ${path}, ${error}`;
    }
  }
  return null;
}

async function checkUnitLoadDirectory(opts: {
  readonly path: string;
  readonly uid: number;
}): Promise<string | null> {
  // Walk in filesystem order: a load directory that is a dangling link
  // into a shared place is followed to where it points, and the walk stops
  // at the first component that does not exist.
  const walk = await walkReplaceableChain({
    path: opts.path,
    uid: opts.uid,
    hackHome: null,
    allowMissing: true,
  });
  if ("error" in walk) {
    return walk.error;
  }
  const existing = walk.existing;
  // The sticky bit stops others replacing existing entries, not creating
  // new ones: neither a missing load directory's parent, nor a load or
  // drop-in directory (where a new drop-in would be picked up), may be
  // writable by group or others.
  const creatable = lettingOthersCreate(existing);
  if (!walk.complete) {
    return creatable === null
      ? null
      : `${existing} lets other users create ${resolve(opts.path)} (${creatable}); run: chmod go-w ${existing}, or create ${resolve(opts.path)} yourself`;
  }
  if (creatable !== null) {
    return `${existing} lets other users add drop-ins (${creatable}); run: chmod go-w ${existing}`;
  }
  for (const name of [`${SYSTEMD_UNIT_NAME}.d`, "service.d"]) {
    const dir = resolve(existing, name);
    const dangling = await checkDanglingDropInDirectory({
      dir,
      uid: opts.uid,
    });
    if (dangling !== "present") {
      if (dangling === null) {
        continue;
      }
      return dangling;
    }
    const writable = lettingOthersCreate(dir);
    const error =
      (writable === null
        ? null
        : `${dir} lets other users add drop-ins (${writable}); run: chmod go-w ${dir}`) ??
      (await checkReplaceableChain({
        path: dir,
        uid: opts.uid,
        hackHome: null,
      })) ??
      (await checkDropInEntries({ dir, uid: opts.uid, allowRoot: true }));
    if (error !== null) {
      return error;
    }
  }
  return null;
}

/** True when an existing unit file is a link, another user's, or writable by others. */
async function isUnitFileReplaceable(opts: {
  readonly unitPath: string;
}): Promise<boolean> {
  try {
    const info = await lstat(opts.unitPath);
    const uid = process.getuid?.() ?? -1;
    return (
      !info.isFile() ||
      (uid >= 0 && info.uid !== uid) ||
      (info.mode & 0o022) !== 0
    );
  } catch {
    return false;
  }
}

/**
 * Splits a path list as `systemctl show` prints it: separated by spaces,
 * with no quoting, so a path that contains a space cannot be told apart
 * from two paths (HACK-2052). Rather than guess, the list is refused when
 * it is ambiguous: a piece that is not absolute (the tail of a split path),
 * or two neighbours that, joined by a space, name a path that exists.
 */
export async function parseSystemdPathList(
  value: string,
  exists: (path: string) => Promise<boolean> = pathExists
): Promise<{ readonly paths: readonly string[] } | { readonly error: string }> {
  const pieces = value.split(" ").filter((piece) => piece.length > 0);
  const ambiguous = (detail: string) => ({
    error: `systemd reported a path list that cannot be read unambiguously (${detail}); a path with a space is not supported`,
  });
  for (const [index, piece] of pieces.entries()) {
    if (!isAbsolute(piece)) {
      return ambiguous(`"${piece}" is not an absolute path`);
    }
    const next = pieces[index + 1];
    if (next !== undefined && (await exists(`${piece} ${next}`))) {
      return ambiguous(`"${piece} ${next}" exists`);
    }
  }
  return { paths: pieces };
}

/** The PATH directories the rendered unit gives hackd, `%h` expanded. */
export function renderedServicePathDirectories(opts: {
  readonly hackBinPath: string;
  readonly home: string;
  /**
   * Test seam: replaces {@link RENDERED_SYSTEM_PATH_DIRECTORIES} so tests
   * do not depend on the host's own system directories.
   */
  readonly systemDirectories?: readonly string[];
}): readonly string[] {
  return [
    dirname(opts.hackBinPath),
    ...(opts.systemDirectories ?? RENDERED_SYSTEM_PATH_DIRECTORIES),
    resolve(opts.home, ".local/bin"),
    resolve(opts.home, ".bun/bin"),
    resolve(opts.home, ".hack/bin"),
  ];
}

/**
 * Where programs are looked up when the service has no PATH at all:
 * systemd's default search path and the C library's fallback (`/bin`).
 */
export const UNSET_PATH_LOOKUP_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/bin",
];

/**
 * hackd runs helpers (`docker`, `git`, ...) through its PATH, so another
 * account that can add a program to any PATH directory, or create a missing
 * one, has it run as this user at the next start (HACK-2052). Each directory
 * is walked in filesystem order (every entry on the way checked), and the
 * directory, or for a missing one the deepest existing directory, must not
 * be writable by group or others, sticky or not.
 */
export async function checkServicePathDirectories(opts: {
  readonly dirs: readonly string[];
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const checked = new Set<string>();
  const scanned = new Set<string>();
  for (const dir of opts.dirs) {
    if (!isAbsolute(dir)) {
      return `the hackd.service PATH has a directory that is not absolute (${dir || "empty"})`;
    }
    const walk = await walkReplaceableChain({
      path: dir,
      uid,
      // Not repaired: programs may already have been planted.
      hackHome: null,
      allowMissing: true,
    });
    if ("error" in walk) {
      return `the hackd.service PATH directory ${dir} is not safe: ${walk.error}`;
    }
    const writable = lettingOthersCreate(walk.existing);
    if (writable !== null) {
      return `other users can ${walk.complete ? "add programs to" : "create"} the hackd.service PATH directory ${dir} (${walk.existing}, ${writable}); run: chmod go-w ${walk.existing}`;
    }
    // /bin is often a link to /usr/bin: scan each real directory once.
    if (walk.complete && !scanned.has(walk.existing)) {
      scanned.add(walk.existing);
      const program = await checkPathDirectoryPrograms({
        dir: walk.existing,
        uid,
        checked,
      });
      if (program !== null) {
        return `the hackd.service PATH directory ${dir} holds ${program}`;
      }
    }
  }
  return null;
}

/**
 * The programs already in a PATH directory: hackd runs helpers from it
 * (`docker events` at every start), so none may be writable by group or
 * others, and a symlink must reach its target through nothing others can
 * replace. In a directory this user owns (`~/.local/bin`) each program
 * must also be this user's or root's; in a root-owned system directory the
 * package manager sets owners (setuid tools owned by system accounts), so
 * only the mode is checked there. Never repaired. Directories inside it
 * are not programs and are skipped.
 */
async function checkPathDirectoryPrograms(opts: {
  readonly dir: string;
  readonly uid: number;
  readonly checked: Set<string>;
}): Promise<string | null> {
  let entries: string[];
  let systemDir: boolean;
  try {
    entries = readdirSync(opts.dir);
    const dirInfo = statSync(opts.dir);
    // Root-owned and writable by nobody else (never /tmp-like): the
    // package manager's directory.
    systemDir = dirInfo.uid === 0 && (dirInfo.mode & 0o022) === 0;
  } catch (error: unknown) {
    return `entries that could not be read (${errorMessage(error)})`;
  }
  for (const entry of entries) {
    const path = resolve(opts.dir, entry);
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      continue;
    }
    const error = info.isSymbolicLink()
      ? await checkPathLink({ path, uid: opts.uid, checked: opts.checked })
      : programFileProblem({ path, info, uid: opts.uid, systemDir });
    if (error !== null) {
      return error;
    }
  }
  return null;
}

/**
 * A symlinked PATH program: nothing on the way to its target may be
 * replaceable. A stale link whose target is gone (a removed tool) is fine
 * as long as nobody else can create that target: the walk stops at the
 * first missing component and the deepest existing directory must not be
 * writable by group or others.
 */
async function checkPathLink(opts: {
  readonly path: string;
  readonly uid: number;
  readonly checked: Set<string>;
}): Promise<string | null> {
  const walk = await walkReplaceableChain({
    path: opts.path,
    uid: opts.uid,
    hackHome: null,
    allowMissing: true,
    checked: opts.checked,
  });
  if ("error" in walk) {
    return walk.error;
  }
  if (walk.complete) {
    return null;
  }
  const creatable = lettingOthersCreate(walk.existing);
  return creatable === null
    ? null
    : `${opts.path}, a link to a missing target that other users could create in ${walk.existing} (${creatable})`;
}

/** Exported for tests of the system-directory rule. */
export function programFileProblem(opts: {
  readonly path: string;
  readonly info: Stats;
  readonly uid: number;
  readonly systemDir: boolean;
}): string | null {
  const { info } = opts;
  // Another regular user's file is never trusted (they can chmod and
  // rewrite it); a system account's file only in a protected root-owned
  // directory (the package manager's, such as `at` owned by `daemon`).
  if (
    opts.uid >= 0 &&
    info.uid !== opts.uid &&
    info.uid !== 0 &&
    !(opts.systemDir && isSystemAccount(info.uid))
  ) {
    return `${opts.path}, owned by another user (uid ${info.uid})`;
  }
  if ((Number(info.mode) & 0o022) !== 0) {
    return `${opts.path}, writable by other users (mode ${(Number(info.mode) & 0o777).toString(8)}); its contents cannot be trusted`;
  }
  return null;
}

/**
 * The PATH directories of hackd.service as systemd will start it: PATH
 * from the service's effective environment
 * ({@link readSystemdServiceEnvironment}: the user manager's environment,
 * the unit's `Environment=`, then `UnsetEnvironment=`). Only when none of
 * those sets it does hackd run without PATH; then the directories a
 * program lookup falls back to (systemd's default and the C library's) are
 * checked. Refused when that environment cannot be established.
 */
export async function readSystemdServicePathDirectories(opts: {
  readonly deps: SystemdDeps;
}): Promise<{ readonly dirs: readonly string[] } | { readonly error: string }> {
  const read = await readSystemdServiceEnvironment({ deps: opts.deps });
  if ("error" in read) {
    return { error: read.error };
  }
  const loader = CODE_LOADING_ENV_KEYS.find(
    (key) => (read.env[key] ?? "").length > 0
  );
  if (loader !== undefined) {
    return {
      error: `${SYSTEMD_UNIT_NAME} would run with ${loader} set (from the unit, a drop-in or the user manager's environment), which loads code Hack cannot check; remove it, or add UnsetEnvironment=${loader} with systemctl --user edit hackd`,
    };
  }
  const path = read.env.PATH;
  return {
    dirs: path === undefined ? UNSET_PATH_LOOKUP_DIRS : path.split(":"),
  };
}

/** Every property through which a unit (or a drop-in) runs a program. */
const EXEC_PROPERTIES = [
  "ExecCondition",
  "ExecStartPre",
  "ExecStart",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
] as const;

/** One `Exec*=` entry as systemd reports it. */
export interface SystemdExecEntry {
  readonly key: string;
  readonly path: string;
  /** The `argv[]=` text, space-joined as systemd prints it. */
  readonly argv: string;
}

const EXEC_ENTRY = /path=(.*?) ; argv\[\]=(.*?) ;/g;
const DAEMON_ARGV_SUFFIX = " daemon start --foreground";

/**
 * Every `Exec*=` entry systemd has loaded for hackd.service (unit file and
 * drop-ins). Refused when systemd cannot say or an entry cannot be read.
 */
export async function readSystemdServiceExecEntries(opts: {
  readonly deps: SystemdDeps;
}): Promise<
  { readonly entries: readonly SystemdExecEntry[] } | { readonly error: string }
> {
  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    `--property=${EXEC_PROPERTIES.join(",")}`,
  ]);
  if (show.exitCode !== 0) {
    return {
      error: `systemd did not report the programs hackd.service runs (${firstLine(show.stderr) || `exit code ${show.exitCode}`})`,
    };
  }
  const entries: SystemdExecEntry[] = [];
  for (const line of show.stdout.split("\n")) {
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    const value = eq > 0 ? line.slice(eq + 1).trim() : "";
    if (!(EXEC_PROPERTIES as readonly string[]).includes(key) || value === "") {
      continue;
    }
    const found = [...value.matchAll(EXEC_ENTRY)];
    if (found.length === 0 || found.length !== value.split("{").length - 1) {
      return { error: `systemd reported a ${key} entry Hack cannot read` };
    }
    for (const match of found) {
      entries.push({ key, path: match[1] ?? "", argv: match[2] ?? "" });
    }
  }
  return { entries };
}

/**
 * What systemd will run for hackd.service is an allowlist (HACK-2052):
 * exactly one `ExecStart` running `<program> daemon start --foreground`,
 * with that program trusted ({@link checkServiceExecutableTrusted}), and
 * no other `Exec*` entry. A hook (`ExecStartPre`, `ExecStop`, ...) or an
 * interpreter wrapper (`/bin/sh script`) runs code Hack cannot vouch for,
 * so a drop-in that adds one is refused rather than inspected.
 */
export async function checkSystemdServicePrograms(opts: {
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  const read = await readSystemdServiceExecEntries({ deps: opts.deps });
  if ("error" in read) {
    return read.error;
  }
  // The whole argument vector, not just its tail: `/bin/bash script daemon
  // start --foreground` ends the same way and runs the script.
  const extra = read.entries.find(
    (entry) =>
      entry.key !== "ExecStart" ||
      entry.argv !== `${entry.path}${DAEMON_ARGV_SUFFIX}`
  );
  if (extra) {
    return `hackd.service has ${extra.key}=${extra.argv}, which Hack does not run or vouch for; remove it from the unit or its drop-ins`;
  }
  const starts = read.entries.filter((entry) => entry.key === "ExecStart");
  if (starts.length !== 1) {
    return `hackd.service has ${starts.length} ExecStart entries; expected exactly one`;
  }
  const path = (starts[0] as SystemdExecEntry).path;
  return (
    (await checkSystemdServiceNamespace({ deps: opts.deps })) ??
    (await checkHackExecutableIdentity({ path })) ??
    (await checkServiceExecutableTrusted({ path }))
  );
}

/**
 * Settings that make systemd run the service in another file namespace: a
 * different root, images or bind mounts. The paths `systemctl show`
 * reports are then host paths that need not be what runs (HACK-2052), so
 * Hack, which writes none of them, refuses rather than maps them.
 */
const NAMESPACE_PROPERTIES = [
  "RootDirectory",
  "RootImage",
  "MountImages",
  "ExtensionImages",
  "ExtensionDirectories",
  "BindPaths",
  "BindReadOnlyPaths",
  "TemporaryFileSystem",
] as const;

/** Null, or why the unit's file namespace cannot be vouched for. */
async function checkSystemdServiceNamespace(opts: {
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    `--property=${NAMESPACE_PROPERTIES.join(",")}`,
  ]);
  if (show.exitCode !== 0) {
    return `systemd did not report the ${SYSTEMD_UNIT_NAME} file namespace (${firstLine(show.stderr) || `exit code ${show.exitCode}`})`;
  }
  const props = parseSystemdProperties(show.stdout);
  const set = NAMESPACE_PROPERTIES.find((key) => (props[key] ?? "").length > 0);
  return set === undefined
    ? null
    : `${SYSTEMD_UNIT_NAME} sets ${set}=${props[set]}, so the programs and PATH Hack checked on this host need not be what runs; remove it from the unit or its drop-ins`;
}

/** `hack` or `hack-<suffix>`, the names Hack installs its executable as. */
function isHackExecutableName(path: string): boolean {
  const base = basename(path).toLowerCase();
  return base === "hack" || base.startsWith("hack-");
}

/**
 * The `ExecStart` program must itself be a hack executable (HACK-2052).
 * Given `<interpreter> daemon start --foreground`, an interpreter (`bash`,
 * `python3`) runs a script named `daemon` from the working directory,
 * which no Hack installation or checkout ships and Hack never checks.
 *
 * Accepted: a program named `hack`/`hack-*` whose resolved file is either
 * a binary named the same way (a compiled binary, a Homebrew or
 * `dist/hack` link) or a `#!` launcher (the local-development shim, a
 * package manager's launcher) whose interpreter line Hack can vouch for
 * ({@link checkShebangInterpreter}). The resolved file's own chain is
 * checked by {@link checkServiceExecutableTrusted}. Anything else is
 * unknown: refused, and the unit is left as it is.
 */
export async function checkHackExecutableIdentity(opts: {
  readonly path: string;
}): Promise<string | null> {
  const unknown = (why: string) =>
    `${SYSTEMD_UNIT_NAME} runs ${opts.path}, which Hack does not recognize as a hack executable (${why}); leaving the unit as it is. Review it, then run: hack daemon install`;
  if (!isHackExecutableName(opts.path)) {
    return unknown(
      'an interpreter would run a script named "daemon" that Hack has not checked'
    );
  }
  let resolved: string;
  try {
    resolved = await realpath(opts.path);
  } catch (error: unknown) {
    return `${opts.path} could not be resolved: ${errorMessage(error)}`;
  }
  const line = await readShebangLine(resolved);
  if (line === null) {
    return isHackExecutableName(resolved)
      ? null
      : unknown(
          `it resolves to ${resolved}; an interpreter would run a script named "daemon" that Hack has not checked`
        );
  }
  const problem = await checkShebangInterpreter({ line });
  return problem === null ? null : unknown(`${resolved}: ${problem}`);
}

const SHEBANG_MAX_BYTES = 256;
const ENV_PROGRAM_NAME = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/;
const TRAILING_CR = /\r$/;

/**
 * The text after `#!` on the first line, or null when the file does not
 * start with `#!` (or cannot be read: the chain check reports that).
 */
async function readShebangLine(path: string): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const head = Buffer.alloc(SHEBANG_MAX_BYTES);
    const { bytesRead } = await handle.read(head, 0, SHEBANG_MAX_BYTES, 0);
    const text = head.subarray(0, bytesRead).toString("latin1");
    if (!text.startsWith("#!")) {
      return null;
    }
    const newline = text.indexOf("\n");
    // No newline within the bytes read: an interpreter line longer than
    // Hack reads is not vouched for.
    return newline < 0 ? "\u0000" : text.slice(2, newline);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Linux runs `<interpreter> [<one argument>] <launcher> daemon start
 * --foreground` for a `#!` launcher, the rest of the line passed as a
 * single argument. Hack vouches only for an absolute interpreter it trusts
 * ({@link checkServiceExecutableTrusted}) that is not itself a `#!` file,
 * with either no argument or, for `env`, one plain program name (looked up
 * through the service PATH, which is checked). Anything else (an extra
 * script, `env -S`, an option) is refused. Null, or why not.
 */
async function checkShebangInterpreter(opts: {
  readonly line: string;
}): Promise<string | null> {
  const trimmed = opts.line.replace(TRAILING_CR, "").trim();
  if (trimmed.includes("\u0000") || trimmed.length === 0) {
    return "its #! line cannot be read";
  }
  const space = trimmed.search(WHITESPACE);
  const interpreter = space < 0 ? trimmed : trimmed.slice(0, space);
  const argument = space < 0 ? "" : trimmed.slice(space).trim();
  if (!isAbsolute(interpreter)) {
    return `its #! interpreter ${interpreter} is not an absolute path`;
  }
  if (
    argument.length > 0 &&
    !(basename(interpreter) === "env" && ENV_PROGRAM_NAME.test(argument))
  ) {
    return `its #! line passes "${argument}" to ${interpreter}, which Hack does not vouch for`;
  }
  try {
    if ((await readShebangLine(await realpath(interpreter))) !== null) {
      return `its #! interpreter ${interpreter} is itself a script`;
    }
  } catch (error: unknown) {
    return `its #! interpreter ${interpreter} could not be resolved: ${errorMessage(error)}`;
  }
  return await checkServiceExecutableTrusted({ path: interpreter });
}

/**
 * What stopping the unit can run must be vouched for first (HACK-2052).
 * A stop runs `ExecStop`/`ExecStopPost` hooks (even after `systemctl
 * kill`), and the inactive transition starts units named by settings such
 * as `OnSuccess=`, which a drop-in another account planted could add. So
 * stop and uninstall check, as start does, every user-unit load directory
 * ({@link checkSystemdUnitLoadPaths}), the unit file itself
 * ({@link checkSystemdUnitTrusted}) and the files systemd has loaded
 * ({@link checkLoadedUnitFiles}), then refuse while any stop hook is
 * loaded (Hack writes none). A stop does not launch `ExecStart`, so a unit
 * whose program was removed can still be stopped. Null, or the refusal.
 */
export async function checkSystemdStopHooks(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  /** Defaults to this process's uid. */
  readonly uid?: number;
}): Promise<string | null> {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  // The unit file itself (owner, mode, not a link), as start checks it: an
  // account that could edit it could add OnSuccess= there too.
  const loadPaths =
    (await checkSystemdUnitTrusted({ unitPath: opts.unitPath, uid })) ??
    (await checkSystemdUnitLoadPaths({ deps: opts.deps, uid }));
  if (loadPaths !== null) {
    return loadPaths.replace(
      `Not using ${SYSTEMD_UNIT_NAME}:`,
      `Not stopping ${SYSTEMD_UNIT_NAME}:`
    );
  }
  const files = await checkLoadedUnitFiles({
    unitPath: opts.unitPath,
    deps: opts.deps,
    uid,
  });
  if (files !== null) {
    return `Not stopping ${SYSTEMD_UNIT_NAME}: ${files}`;
  }
  const read = await readSystemdServiceExecEntries({ deps: opts.deps });
  if ("error" in read) {
    return read.error;
  }
  const hook = read.entries.find(
    (entry) => entry.key === "ExecStop" || entry.key === "ExecStopPost"
  );
  return hook
    ? `Not stopping ${SYSTEMD_UNIT_NAME}: it has ${hook.key}=${hook.argv}, which Hack does not write or vouch for`
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What must hold, in what systemd has just loaded, before the unit is
 * enabled to start at login: it serves the installer's Hack home (a
 * drop-in can set HACK_HOME), its PATH directories and the programs it
 * runs are safe (a drop-in can set PATH or add Exec* entries).
 */
async function checkBeforeEnable(opts: {
  readonly deps: SystemdDeps;
  readonly hackHome: string | undefined;
}): Promise<string | null> {
  if (opts.hackHome !== undefined) {
    const unitHome = await readSystemdUnitHackHome({ deps: opts.deps });
    if (unitHome.kind === "unknown") {
      return `Not enabling ${SYSTEMD_UNIT_NAME}: its Hack home could not be read (${unitHome.detail})`;
    }
    if (unitHome.path !== resolve(opts.hackHome)) {
      return `Not enabling ${SYSTEMD_UNIT_NAME}: a drop-in makes it run hackd for ${unitHome.path}, not ${resolve(opts.hackHome)}; remove that override or install from that Hack home`;
    }
  }
  const servicePath = await readSystemdServicePathDirectories({
    deps: opts.deps,
  });
  const error =
    ("error" in servicePath
      ? servicePath.error
      : await checkServicePathDirectories({ dirs: servicePath.dirs })) ??
    (await checkSystemdServicePrograms({ deps: opts.deps }));
  return error === null ? null : `Not enabling ${SYSTEMD_UNIT_NAME}: ${error}`;
}

/**
 * Null when the unit's effective HACK_HOME (drop-ins included) is
 * `hackHome`; otherwise why not (another home, or it cannot be read).
 */
async function describeForeignHackHome(opts: {
  readonly deps: SystemdDeps;
  readonly hackHome: string;
}): Promise<string | null> {
  const unitHome = await readSystemdUnitHackHome({ deps: opts.deps });
  if (unitHome.kind === "unknown") {
    return `its Hack home could not be read (${unitHome.detail})`;
  }
  return unitHome.path === resolve(opts.hackHome)
    ? null
    : `it runs hackd for ${unitHome.path}, not ${resolve(opts.hackHome)}; uninstall it from that Hack home`;
}

/** Runs `systemctl --user daemon-reload`. */
export async function systemdDaemonReload(opts: {
  readonly deps: SystemdDeps;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const result = await opts.deps.run("systemctl", ["--user", "daemon-reload"]);
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    error: firstLine(result.stderr) || `exit code ${result.exitCode}`,
  };
}

/** Runs `systemctl --user <action> hackd.service`. */
export async function systemdServiceAction(opts: {
  readonly action: "start" | "restart" | "stop" | "reset-failed";
  readonly deps: SystemdDeps;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const result = await opts.deps.run("systemctl", [
    "--user",
    opts.action,
    SYSTEMD_UNIT_NAME,
  ]);
  if (result.exitCode === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    error: firstLine(result.stderr) || `exit code ${result.exitCode}`,
  };
}

/** systemd states in which the unit runs or will run hackd (a pending restart). */
export const MANAGER_STOPPABLE_STATES: ReadonlySet<string> = new Set([
  "active",
  "activating",
  "reloading",
  "deactivating",
]);

export type SystemdUninstallResult =
  | {
      readonly ok: true;
      readonly notInstalled: boolean;
      /** False when the unit file was removed but systemctl was unavailable. */
      readonly managerNotified: boolean;
      /**
       * The service was stopped and disabled and the file removed, but the
       * final `daemon-reload` failed: systemd still has the unit loaded.
       */
      readonly reloadError: string | null;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Stops and disables the unit, removes the file and reloads systemd. When
 * the user manager is unavailable the file is still removed, so the next
 * session does not start it, and `managerNotified` is false.
 */
export async function uninstallSystemdUnit(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  /**
   * The uninstalling CLI's Hack home: a unit that a drop-in points at
   * another home (or whose home cannot be read) is not stopped or removed.
   */
  readonly hackHome?: string;
}): Promise<SystemdUninstallResult> {
  const access = resolveSystemdAccess({ env: opts.deps.env });
  if (!access.allowed) {
    return { ok: false, error: access.message };
  }
  if (!(await pathExists(opts.unitPath))) {
    const loaded = await refuseLoadedUnitWithoutFile({
      unitPath: opts.unitPath,
      deps: opts.deps,
      hackHome: opts.hackHome,
    });
    return loaded === null
      ? {
          ok: true,
          notInstalled: true,
          managerNotified: false,
          reloadError: null,
        }
      : { ok: false, error: loaded };
  }
  const availability = await probeSystemdUserManager(opts.deps);
  if (availability.available && opts.hackHome !== undefined) {
    const foreign = await describeForeignHackHome({
      deps: opts.deps,
      hackHome: opts.hackHome,
    });
    if (foreign !== null) {
      return {
        ok: false,
        error: `Not uninstalling ${SYSTEMD_UNIT_NAME}: ${foreign}`,
      };
    }
  }
  if (availability.available) {
    const disabled = await disableUnitSafely({
      unitPath: opts.unitPath,
      deps: opts.deps,
    });
    if (disabled !== null) {
      return { ok: false, error: disabled };
    }
  }
  try {
    await rm(opts.unitPath, { force: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Failed to remove ${opts.unitPath}: ${message}`,
    };
  }
  let reloadError: string | null = null;
  if (availability.available) {
    const reload = await opts.deps.run("systemctl", [
      "--user",
      "daemon-reload",
    ]);
    if (reload.exitCode !== 0) {
      reloadError = firstLine(reload.stderr) || `exit code ${reload.exitCode}`;
    }
  }
  return {
    ok: true,
    notInstalled: false,
    managerNotified: availability.available,
    reloadError,
  };
}

/**
 * No unit file at the managed path does not prove nothing runs (HACK-2052):
 * the file may have been removed, or the unit loaded from another
 * directory, while systemd still runs it or waits to restart it. Such a
 * unit cannot be checked without its file, so uninstall refuses with the
 * commands to use by hand, unless it clearly serves another Hack home
 * (left to that home). Null when there is nothing to do here.
 */
async function refuseLoadedUnitWithoutFile(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hackHome: string | undefined;
}): Promise<string | null> {
  const status = await readSystemdServiceStatus({
    unitPath: opts.unitPath,
    deps: opts.deps,
  });
  if (!status?.availability.available) {
    return null;
  }
  // A failed read is not evidence that nothing runs (a pending restart
  // may remain): refuse it like a loaded unit (HACK-2052).
  if (status.stateError !== null) {
    return `Not uninstalling ${SYSTEMD_UNIT_NAME}: there is no unit file at ${opts.unitPath}, but systemd could not report whether it still runs or will restart (${status.stateError}). Check: systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it by hand, run: systemctl --user stop ${SYSTEMD_UNIT_NAME} (and, if its file still exists elsewhere: systemctl --user disable ${SYSTEMD_UNIT_NAME}, then systemctl --user daemon-reload)`;
  }
  if (
    status.activeState === null ||
    !MANAGER_STOPPABLE_STATES.has(status.activeState)
  ) {
    return null;
  }
  if (opts.hackHome !== undefined) {
    const home = await readSystemdUnitHackHome({ deps: opts.deps });
    if (home.kind === "home" && home.path !== resolve(opts.hackHome)) {
      return null;
    }
  }
  return `Not uninstalling ${SYSTEMD_UNIT_NAME}: systemd has it ${status.activeState}, but not from ${opts.unitPath}, the unit Hack manages (it was removed or is loaded from another directory), so it cannot be checked. Review it with systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it by hand, run: systemctl --user stop ${SYSTEMD_UNIT_NAME} (and, if its file still exists elsewhere: systemctl --user disable ${SYSTEMD_UNIT_NAME}, then systemctl --user daemon-reload)`;
}

/**
 * Disables and stops the unit (`disable --now`), which runs its ExecStop
 * and ExecStopPost hooks. systemd runs those whenever the service stops,
 * even after `systemctl kill`, so there is no hook-free way to stop it:
 * when what systemd has loaded cannot be vouched for
 * ({@link checkSystemdLoadedUnitPaths}) nothing is stopped, disabled or
 * removed, and the error says to remove the unsafe entry and reload first
 * (HACK-2052). Returns null, or the error.
 */
async function disableUnitSafely(opts: {
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  const untrusted = await checkSystemdStopHooks({
    unitPath: opts.unitPath,
    deps: opts.deps,
  });
  if (untrusted !== null) {
    return `${untrusted}. Stopping it could run what that configuration adds, so it was not stopped or removed: fix it, run systemctl --user daemon-reload, then run hack daemon uninstall again`;
  }
  const args = ["--user", "disable", "--now", SYSTEMD_UNIT_NAME];
  const result = await opts.deps.run("systemctl", args);
  if (result.exitCode !== 0 && !isUnitMissingError(result.stderr)) {
    return `systemctl ${args.join(" ")} failed: ${firstLine(result.stderr) || `exit code ${result.exitCode}`}`;
  }
  return null;
}

function isUnitMissingError(stderr: string): boolean {
  return UNIT_MISSING.test(stderr);
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
}
