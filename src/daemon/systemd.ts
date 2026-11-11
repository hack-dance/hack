import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { GLOBAL_HACK_DIR_NAME } from "../constants.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileAtomicIfChanged,
} from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";
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
 * - The default `KillMode=control-group` is kept on purpose: stopping or
 *   restarting the service also stops processes hackd started (supervisor
 *   jobs, shells), so none outlive the service that owns them.
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

/** The single boundary for `systemctl` and `loginctl`. */
export type ServiceCommandRunner = (
  command: "systemctl" | "loginctl",
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
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...opts.env, SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 127, stdout: "", stderr: message };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
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
          ? `${command} timed out after ${COMMAND_TIMEOUT_MS}ms`
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
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
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
    `ExecStart="${escapeSpecifiers(bin)}" daemon start --foreground`,
    "Restart=on-failure",
    "RestartSec=2",
    "WorkingDirectory=%h",
    `Environment="PATH=${path}"`,
    "Environment=HACK_NO_INTERACTIVE=1",
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
const UNIT_MISSING = /not loaded|does not exist|not found|No such file/i;

/** Reads the program (first word of `ExecStart=`) from unit text. */
export function extractSystemdExecProgram(opts: {
  readonly unitText: string;
}): string | null {
  const line = opts.unitText.match(EXEC_START_PATTERN)?.[1]?.trim();
  if (!line) {
    return null;
  }
  if (!line.startsWith('"')) {
    const word = line.split(WHITESPACE)[0] ?? "";
    return word.length > 0 ? unescapeSystemdWord(word) : null;
  }
  let out = "";
  for (let i = 1; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      out += line[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') {
      return unescapeSystemdWord(out);
    }
    out += ch;
  }
  return null;
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

export type SystemdUnitDrift = "none" | "content" | "program-missing";

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
  readonly program: string | null;
  /** Only meaningful when installed; "none" otherwise. */
  readonly drift: SystemdUnitDrift;
  /** null when unknown (loginctl missing or failed). */
  readonly linger: boolean | null;
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
  const program = unitText ? extractSystemdExecProgram({ unitText }) : null;
  const drift = await computeDrift({
    unitText,
    program,
    exists,
  });

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
      program,
      drift,
      linger,
    };
  }

  const show = await opts.deps.run("systemctl", [
    "--user",
    "--no-pager",
    "show",
    SYSTEMD_UNIT_NAME,
    "--property=LoadState,ActiveState,UnitFileState,MainPID",
  ]);
  const props = show.exitCode === 0 ? parseSystemdProperties(show.stdout) : {};
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
    program,
    drift,
    linger,
  };
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
  readonly program: string | null;
  readonly exists: (path: string) => Promise<boolean>;
}): Promise<SystemdUnitDrift> {
  if (opts.unitText === null) {
    return "none";
  }
  if (opts.program === null || !(await opts.exists(opts.program))) {
    return "program-missing";
  }
  const rendered = renderSystemdUnit({ hackBinPath: opts.program });
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

  await ensureDir(dirname(opts.unitPath));
  const { changed } = await writeTextFileAtomicIfChanged(
    opts.unitPath,
    opts.unitText,
    { createMode: 0o644 }
  );
  if (changed) {
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

export type SystemdUninstallResult =
  | {
      readonly ok: true;
      readonly notInstalled: boolean;
      /** False when the unit file was removed but systemctl was unavailable. */
      readonly managerNotified: boolean;
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
}): Promise<SystemdUninstallResult> {
  const access = resolveSystemdAccess({ env: opts.deps.env });
  if (!access.allowed) {
    return { ok: false, error: access.message };
  }
  if (!(await pathExists(opts.unitPath))) {
    return { ok: true, notInstalled: true, managerNotified: false };
  }
  const availability = await probeSystemdUserManager(opts.deps);
  if (availability.available) {
    const disable = await opts.deps.run("systemctl", [
      "--user",
      "disable",
      "--now",
      SYSTEMD_UNIT_NAME,
    ]);
    if (disable.exitCode !== 0 && !isUnitMissingError(disable.stderr)) {
      return {
        ok: false,
        error: `systemctl --user disable --now ${SYSTEMD_UNIT_NAME} failed: ${firstLine(disable.stderr) || `exit code ${disable.exitCode}`}`,
      };
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
  if (availability.available) {
    await opts.deps.run("systemctl", ["--user", "daemon-reload"]);
  }
  return {
    ok: true,
    notInstalled: false,
    managerNotified: availability.available,
  };
}

function isUnitMissingError(stderr: string): boolean {
  return UNIT_MISSING.test(stderr);
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
}
