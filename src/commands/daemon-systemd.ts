import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DaemonPaths } from "../daemon/paths.ts";
import {
  type DaemonProcessProof,
  type DaemonProcessRefusal,
  describeDaemonProcessRefusal,
  proveOwnedDaemonProcess,
} from "../daemon/process.ts";
import {
  type DaemonServiceSummary,
  summarizeSystemdService,
} from "../daemon/service-summary.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import {
  assessExecutableDurability,
  defaultSystemdDeps,
  describeSystemdUnavailable,
  installSystemdUnit,
  isPidInSystemdUnit,
  isSystemdReadOnly,
  LINGER_ENABLE_COMMAND,
  probeSystemdUserManager,
  readLingerStatus,
  readSystemdServiceStatus,
  resolveExpectedSystemdUnit,
  resolveSystemdAccess,
  resolveSystemdUnitPath,
  retargetSystemdUnitProgram,
  SYSTEMD_UNIT_NAME,
  type SystemdDeps,
  type SystemdServiceStatus,
  systemdDaemonReload,
  systemdServiceAction,
  uninstallSystemdUnit,
} from "../daemon/systemd.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { ensureDir, pathExists, readTextFile } from "../lib/fs.ts";
import { logger } from "../ui/logger.ts";

/**
 * Linux `hack daemon` effects through the systemd user manager. Decisions
 * live in `src/daemon/systemd.ts` and `src/daemon/service-summary.ts`; this
 * file sequences them and prints. `deps` is injectable so tests drive it with
 * a fake `systemctl`.
 */

const RESTART_PENDING_FILE = "hackd.service.restart-pending";
const JOURNAL_HINT = `journalctl --user -u ${SYSTEMD_UNIT_NAME} -n 50`;
const READY_TIMEOUT_MS = 8000;

export interface SystemdCommandHooks {
  readonly paths: DaemonPaths;
  readonly deps?: SystemdDeps;
  /** Starts hackd directly in its own session (the non-service path). */
  readonly startDetached: () => Promise<number>;
  /**
   * Stops a directly started hackd that {@link proveDaemon} proved is this
   * HACK_HOME's daemon, and removes its pid/socket files if still stale.
   */
  readonly stopDirect: (
    proof: Extract<DaemonProcessProof, { kind: "owned" }>
  ) => Promise<void>;
  /** Defaults to {@link proveOwnedDaemonProcess}; tests pin the observations. */
  readonly proveDaemon?: (pid: number) => Promise<DaemonProcessProof>;
  /** Defaults to {@link assessExecutableDurability}. */
  readonly assessDurability?: typeof assessExecutableDurability;
  readonly waitForReady: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to {@link isPidInSystemdUnit}; tests pin cgroup membership. */
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
  /** Defaults to {@link resolveExpectedSystemdUnit}; tests pin the program. */
  readonly resolveExpected?: typeof resolveExpectedSystemdUnit;
}

/** Status for `daemon status` and doctor; null off Linux or when access is denied. */
export async function resolveSystemdStatus(
  opts: {
    readonly deps?: SystemdDeps;
    readonly platform?: NodeJS.Platform;
  } = {}
): Promise<{
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
} | null> {
  if ((opts.platform ?? process.platform) !== "linux") {
    return null;
  }
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const status = await readSystemdServiceStatus({
    unitPath: resolveSystemdUnitPath({ env: deps.env }),
    deps,
  });
  return status ? { status, deps } : null;
}

/** The shared summary for status output and doctor. */
export async function resolveSystemdSummary(opts: {
  readonly paths: DaemonPaths;
  readonly deps?: SystemdDeps;
  readonly platform?: NodeJS.Platform;
}): Promise<DaemonServiceSummary | null> {
  const resolved = await resolveSystemdStatus(opts);
  if (!resolved) {
    return null;
  }
  const daemon = await readDaemonStatus({ paths: opts.paths });
  return summarizeSystemdService({
    status: resolved.status,
    daemonPid: daemon.pid,
    daemonRunning: daemon.running,
    daemonInUnit:
      daemon.running && daemon.pid !== null
        ? await isPidInSystemdUnit({ pid: daemon.pid })
        : null,
  });
}

/**
 * `hack daemon start` when hackd.service is installed: start through systemd
 * so one manager owns the socket and pid file. Returns null when the unit is
 * not installed or systemd is unavailable; the caller then starts hackd
 * directly. See {@link prepareSystemdUnitForStart} for what start may change
 * in the unit (almost nothing).
 */
export async function startViaSystemdIfInstalled(
  hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect">
): Promise<number | null> {
  const deps = hooks.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return null;
  }
  const status = await readSystemdServiceStatus({
    unitPath,
    deps,
  });
  if (!status) {
    return null;
  }
  if (!status.availability.available) {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} is installed but ${describeSystemdUnavailable(status.availability)}; starting hackd directly`,
    });
    return null;
  }
  const prepared = await prepareSystemdUnitForStart({
    status,
    unitPath,
    deps,
    hooks,
  });
  if (prepared !== null) {
    return prepared;
  }
  // After a crash loop systemd refuses `start` ("start request repeated too
  // quickly") until the failed state is cleared. Clearing is harmless when
  // the unit is not failed.
  if (status.activeState === "failed") {
    await systemdServiceAction({ action: "reset-failed", deps });
  }
  const started = await systemdServiceAction({ action: "start", deps });
  if (!started.ok) {
    logger.error({
      message: `systemctl --user start ${SYSTEMD_UNIT_NAME} failed: ${started.error} | Check: ${JOURNAL_HINT}`,
    });
    return 1;
  }
  if (await hooks.waitForReady(READY_TIMEOUT_MS)) {
    logger.success({ message: "hackd started (systemd)" });
    return 0;
  }
  logger.warn({
    message: `systemd started hackd but it did not report ready yet | Check: hack daemon logs --tail 200 and ${JOURNAL_HINT}`,
  });
  return 1;
}

/**
 * What `hack daemon start` (and autostart, which runs it) may do to an
 * installed unit before starting it. Returns an exit code to stop with, or
 * null to go on and start.
 *
 * Owner decision (HACK-2052): start never rewrites a unit whose program
 * still exists, even when this CLI resolves a different `hack`; it reports
 * the difference and `hack daemon install` switches it. That keeps a user's
 * whole-file edits and never points a login service at a temporary binary.
 * Only when the program is gone may start retarget it, and only to a
 * durable location ({@link assessExecutableDurability}), replacing just the
 * ExecStart program so every other line is kept. Under
 * {@link isSystemdReadOnly} (`hack doctor --fix` without a TTY) it neither
 * writes nor reloads. A pending reload (`NeedDaemonReload=yes`, left by a
 * failed reload after a write) is completed first, so a retry recovers.
 */
async function prepareSystemdUnitForStart(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "resolveExpected" | "assessDurability"
  >;
}): Promise<number | null> {
  const { status, unitPath, deps, hooks } = opts;
  const readOnly = isSystemdReadOnly(deps.env);
  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();

  if (status.drift !== "program-missing") {
    return await completePendingReload({ status, deps, expected, readOnly });
  }

  const missing = `${SYSTEMD_UNIT_NAME} runs a program that no longer exists (${status.program ?? "unreadable ExecStart"})`;
  if (readOnly) {
    logger.error({
      message: `${missing}; not changing the service here | Run: hack daemon install`,
    });
    return 1;
  }
  if (!expected) {
    logger.error({
      message: `${missing} and no installed hack was found to replace it | Put hack on PATH, then run: hack daemon install`,
    });
    return 1;
  }
  const durability = await (
    hooks.assessDurability ?? assessExecutableDurability
  )({ path: expected.hackBinPath });
  if (!durability.durable) {
    logger.error({
      message: `${missing}. This CLI (${expected.hackBinPath}) is not a stable location for a login service: ${durability.reason} | Install hack to a stable location, then run: hack daemon install`,
    });
    return 1;
  }
  const unitText = await readTextFile(unitPath);
  const retargeted =
    unitText === null
      ? null
      : retargetSystemdUnitProgram({
          unitText,
          hackBinPath: expected.hackBinPath,
        });
  if (retargeted === null) {
    logger.error({
      message: `${missing} and its ExecStart could not be updated | Run: hack daemon install`,
    });
    return 1;
  }
  const repaired = await installSystemdUnit({
    unitPath,
    unitText: retargeted,
    deps,
    // Keep the user's choice: a disabled unit is repaired, not re-enabled.
    enable: status.enabled,
    forceReload: status.needsReload,
  });
  if (!repaired.ok) {
    logger.error({
      message: `Failed to repair ${SYSTEMD_UNIT_NAME}: ${repaired.error}`,
    });
    return 1;
  }
  logger.warn({
    message: `Repaired ${SYSTEMD_UNIT_NAME}: its program no longer existed; it now runs ${expected.hackBinPath} (other lines kept)`,
  });
  return null;
}

/**
 * Start with an existing program: never rewrite the unit, only note a
 * different `hack` and finish a reload that an earlier write left pending.
 */
async function completePendingReload(opts: {
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
  readonly expected: { readonly hackBinPath: string } | null;
  readonly readOnly: boolean;
}): Promise<number | null> {
  const { status, expected } = opts;
  if (expected && status.program && expected.hackBinPath !== status.program) {
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} runs ${status.program}; this CLI is ${expected.hackBinPath}. To switch the service to it, run: hack daemon install`,
    });
  }
  if (!status.needsReload) {
    return null;
  }
  if (opts.readOnly) {
    logger.warn({
      message: `systemd has an older copy of ${SYSTEMD_UNIT_NAME} loaded; not reloading it here | Run: hack daemon install`,
    });
    return null;
  }
  const reload = await systemdDaemonReload({ deps: opts.deps });
  if (!reload.ok) {
    logger.error({
      message: `systemctl --user daemon-reload failed: ${reload.error}`,
    });
    return 1;
  }
  return null;
}

/** systemd states in which the unit runs or will run hackd (a pending restart). */
const MANAGER_STOPPABLE_STATES = new Set([
  "active",
  "activating",
  "reloading",
  "deactivating",
]);

/**
 * `hack daemon stop` when hackd.service is installed: stop through systemctl
 * whenever the unit is running or about to run hackd, even with a dead or
 * missing pid file. That cancels a pending `Restart=on-failure` restart
 * (`activating`/`auto-restart`), which signalling a pid cannot.
 *
 * `handled` says systemctl stop ran; `ownedPid` says systemd ran `pid`
 * (otherwise the caller still stops a directly started hackd itself).
 */
export async function stopViaSystemdIfInstalled(opts: {
  readonly pid: number | null;
  readonly deps?: SystemdDeps;
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
}): Promise<{
  readonly handled: boolean;
  readonly ownedPid: boolean;
  /** systemctl stop failed: the manager may still (re)start hackd. */
  readonly failed: string | null;
}> {
  const none = { handled: false, ownedPid: false, failed: null };
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return none;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return none;
  }
  const status = await readSystemdServiceStatus({ unitPath, deps });
  if (!status?.availability.available) {
    return none;
  }
  // An unknown state (the unit-specific `systemctl show` failed) does not
  // prove the unit is stopped: stop it anyway, which is harmless when it is
  // already inactive.
  if (
    status.activeState !== null &&
    !MANAGER_STOPPABLE_STATES.has(status.activeState)
  ) {
    return none;
  }
  const ownedPid =
    opts.pid !== null &&
    (await systemdRunsPid({
      status,
      pid: opts.pid,
      isPidInUnit: opts.isPidInUnit,
    }));
  const stopped = await systemdServiceAction({ action: "stop", deps });
  if (!stopped.ok) {
    return { handled: false, ownedPid, failed: stopped.error };
  }
  return { handled: true, ownedPid, failed: null };
}

/**
 * When systemd runs an incompatible hackd from a unit that points at a
 * different, still existing `hack`, replacing the daemon would only make
 * systemd start the same old binary again (start does not rewrite such a
 * unit). Returns the message to show instead, or null when this does not
 * apply and the caller may replace the daemon.
 */
export async function describeSystemdIncompatibleOwner(opts: {
  readonly pid: number;
  readonly deps?: SystemdDeps;
  readonly resolveExpected?: typeof resolveExpectedSystemdUnit;
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
}): Promise<string | null> {
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return null;
  }
  const status = await readSystemdServiceStatus({ unitPath, deps });
  if (
    !status?.availability.available ||
    status.drift === "program-missing" ||
    status.program === null ||
    !(await systemdRunsPid({
      status,
      pid: opts.pid,
      isPidInUnit: opts.isPidInUnit,
    }))
  ) {
    return null;
  }
  const expected = await (opts.resolveExpected ?? resolveExpectedSystemdUnit)();
  if (!expected || expected.hackBinPath === status.program) {
    return null;
  }
  return `hackd (pid ${opts.pid}) is incompatible with this CLI, and ${SYSTEMD_UNIT_NAME} runs ${status.program}, so restarting it would start the same version again | Run: hack daemon install (switches the service to ${expected.hackBinPath})`;
}

/**
 * For an incompatible hackd that systemd runs from another, still existing
 * `hack`, the fix is `hack daemon install` (switch the service), not
 * `hack daemon restart` (which starts the same version again). Shared by
 * `hack daemon status` and doctor so they agree.
 */
export async function withSystemdIncompatibleNextStep<
  T extends {
    readonly status: string;
    readonly pid: number | null;
    readonly nextStep: string | null;
  },
>(opts: {
  readonly report: T;
  readonly deps?: SystemdDeps;
  readonly resolveExpected?: typeof resolveExpectedSystemdUnit;
}): Promise<T> {
  const { report } = opts;
  if (
    process.platform !== "linux" ||
    report.status !== "incompatible" ||
    report.pid === null
  ) {
    return report;
  }
  const owner = await describeSystemdIncompatibleOwner({
    pid: report.pid,
    deps: opts.deps,
    resolveExpected: opts.resolveExpected,
  });
  return owner === null
    ? report
    : { ...report, nextStep: "hack daemon install" };
}

/**
 * The single "does systemd run this hackd" rule for stop and install: the
 * unit is active and the pid is its `MainPID`, or (for a `hack` wrapper that
 * keeps hackd as a child) the pid runs in the unit's cgroup.
 */
async function systemdRunsPid(opts: {
  readonly status: SystemdServiceStatus;
  readonly pid: number;
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
}): Promise<boolean> {
  if (!opts.status.active) {
    return false;
  }
  if (opts.status.mainPid === opts.pid) {
    return true;
  }
  const inUnit = await (
    opts.isPidInUnit ?? ((pid: number) => isPidInSystemdUnit({ pid }))
  )(opts.pid);
  return inUnit === true;
}

function assertSystemdAccess(deps: SystemdDeps): void {
  const access = resolveSystemdAccess({ env: deps.env });
  if (!access.allowed) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message: access.message,
      detail: { reason: access.reason },
    });
  }
}

/**
 * `hack daemon install` on Linux: write and enable hackd.service, hand a
 * directly started hackd over to systemd, start it, and report linger.
 *
 * Without a usable user manager (no systemctl, no user bus, a container or
 * WSL without systemd) nothing is written: it explains why, starts hackd
 * directly in its own session instead, and exits 1 because the service was
 * not installed.
 */
export async function installDaemonSystemdService(
  hooks: SystemdCommandHooks & { readonly ignoredOptions: readonly string[] }
): Promise<number> {
  const deps = hooks.deps ?? defaultSystemdDeps();
  assertSystemdAccess(deps);
  if (hooks.ignoredOptions.length > 0) {
    logger.info({
      message: `Ignoring macOS launchd options on Linux: ${hooks.ignoredOptions.join(", ")}`,
    });
  }

  const availability = await probeSystemdUserManager(deps);
  if (!availability.available) {
    logger.warn({
      message: `Cannot install the hackd systemd user service: ${describeSystemdUnavailable(availability)}`,
    });
    logger.info({
      message:
        "Starting hackd directly instead. It keeps running after this shell exits, but not across logout or reboot.",
    });
    await hooks.startDetached();
    return 1;
  }

  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();
  if (!expected) {
    logger.error({
      message:
        "Could not resolve an installed hack executable for the systemd unit | Install hack so `hack` is on PATH, then run: hack daemon install",
    });
    return 1;
  }

  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  const before = await readSystemdServiceStatus({
    unitPath,
    deps,
  });
  const restartMarker = await noteRestartIfActiveUnitChanges({
    hooks,
    before,
    unitPath,
    unitText: expected.unitText,
  });
  const installed = await installSystemdUnit({
    unitPath,
    unitText: expected.unitText,
    deps,
    forceReload: before?.needsReload === true,
  });
  if (!installed.ok) {
    logger.error({
      message: `Failed to install the hackd systemd user service: ${installed.error}`,
    });
    return 1;
  }
  if (installed.changed) {
    logger.success({
      message: before?.installed
        ? `Updated ${SYSTEMD_UNIT_NAME} (the unit had drifted)`
        : `Installed ${SYSTEMD_UNIT_NAME}`,
    });
  } else {
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} already installed (unit unchanged)`,
    });
  }
  logger.info({ message: `  Unit: ${unitPath}` });
  logger.info({
    message: `  Runs: ${expected.hackBinPath} daemon start --foreground`,
  });
  const durability = await (
    hooks.assessDurability ?? assessExecutableDurability
  )({ path: expected.hackBinPath });
  if (!durability.durable) {
    logger.warn({
      message: `The service runs ${expected.hackBinPath}, which may not last: ${durability.reason}. Install hack to a stable location and run \`hack daemon install\` from there.`,
    });
  }

  await handOverDirectDaemon({ hooks, before });

  // A running service must be restarted when its loaded config changed:
  // this install wrote a new unit, it completed a reload that an earlier
  // write left pending (`NeedDaemonReload=yes`), or an earlier install
  // changed the unit and failed before its restart (the recorded marker).
  const configChanged =
    installed.changed ||
    before?.needsReload === true ||
    (await pathExists(restartMarker));
  const action =
    configChanged && before?.active ? ("restart" as const) : ("start" as const);
  if (before?.activeState === "failed") {
    await systemdServiceAction({ action: "reset-failed", deps });
  }
  const started = await systemdServiceAction({ action, deps });
  if (!started.ok) {
    logger.error({
      message: `systemctl --user ${action} ${SYSTEMD_UNIT_NAME} failed: ${started.error} | Check: ${JOURNAL_HINT}`,
    });
    return 1;
  }
  // The running service now has the new config (restarted, or started
  // fresh from it).
  await rm(restartMarker, { force: true });
  const ready = await reportInstalledDaemonReady({ hooks, unitPath, deps });
  reportLinger({
    linger: await readLingerStatus(deps),
  });
  return ready ? 0 : 1;
}

/**
 * Waits for hackd and checks that systemd runs it. A ready socket is not
 * proof: a directly started hackd that was left running (its identity could
 * not be proven) also answers, and the unit's own copy then exits at once.
 * Returns true only when systemd runs the ready hackd.
 */
async function reportInstalledDaemonReady(opts: {
  readonly hooks: SystemdCommandHooks;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<boolean> {
  if (!(await opts.hooks.waitForReady(READY_TIMEOUT_MS))) {
    logger.warn({
      message: `hackd did not report ready yet | Check: hack daemon status, ${JOURNAL_HINT}`,
    });
    return false;
  }
  const owner = await readRunningDaemonOwner(opts);
  if (owner.bySystemd) {
    logger.success({ message: "hackd running under systemd" });
    return true;
  }
  logger.warn({
    message: `${SYSTEMD_UNIT_NAME} is installed and enabled, but the running hackd${owner.pid ? ` (pid ${owner.pid})` : ""} was not started by systemd and stops at logout | Run: hack daemon restart`,
  });
  return false;
}

/** Who runs the hackd in the pid file now: systemd's unit, or not. */
async function readRunningDaemonOwner(opts: {
  readonly hooks: SystemdCommandHooks;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<{ readonly pid: number | null; readonly bySystemd: boolean }> {
  const daemon = await readDaemonStatus({ paths: opts.hooks.paths });
  if (!(daemon.running && daemon.pid !== null)) {
    return { pid: null, bySystemd: false };
  }
  const status = await readSystemdServiceStatus({
    unitPath: opts.unitPath,
    deps: opts.deps,
  });
  const bySystemd =
    status !== null &&
    (await systemdRunsPid({
      status,
      pid: daemon.pid,
      isPidInUnit: opts.hooks.isPidInUnit,
    }));
  return { pid: daemon.pid, bySystemd };
}

/**
 * Records, before the unit file changes, that the running service must be
 * restarted to pick it up. Install clears it only after a successful
 * restart, so a failure in between (reload, enable, restart) is retried as
 * a restart, not a no-op `start`. Lives in hackd's own state directory.
 * Returns the marker path.
 */
async function noteRestartIfActiveUnitChanges(opts: {
  readonly hooks: SystemdCommandHooks;
  readonly before: SystemdServiceStatus | null;
  readonly unitPath: string;
  readonly unitText: string;
}): Promise<string> {
  const marker = resolve(opts.hooks.paths.root, RESTART_PENDING_FILE);
  if (
    opts.before?.active &&
    (await readTextFile(opts.unitPath)) !== opts.unitText
  ) {
    await ensureDir(opts.hooks.paths.root);
    await writeFile(marker, "restart hackd.service to load its new unit\n");
  }
  return marker;
}

/** What to do after install could not hand a pid over to systemd. */
function handoverRefusalAdvice(reason: DaemonProcessRefusal): string {
  switch (reason) {
    case "foreign-socket":
      return "It may be the daemon of another HACK_HOME; check HACK_HOME and `hack daemon status` there.";
    case "not-hackd":
    case "not-running":
    case "invalid-pid":
      return "The pid file is stale; `hack daemon restart` replaces it and starts hackd under systemd.";
    default:
      return "Check `hack daemon status` and `hack daemon logs`.";
  }
}

/**
 * A directly started hackd holds the socket and pid file, so systemd's copy
 * would exit at once: stop it so the service owns the daemon. Only a pid
 * proven to be this HACK_HOME's hackd is signalled; anything else is left
 * running and reported.
 */
async function handOverDirectDaemon(opts: {
  readonly hooks: SystemdCommandHooks;
  readonly before: SystemdServiceStatus | null;
}): Promise<void> {
  // A directly started hackd holds the socket and pid file; systemd's copy
  // would exit at once. Stop it so the service owns the daemon.
  const { hooks, before } = opts;
  const daemon = await readDaemonStatus({ paths: hooks.paths });
  if (
    daemon.running &&
    daemon.pid !== null &&
    !(
      before &&
      (await systemdRunsPid({
        status: before,
        pid: daemon.pid,
        isPidInUnit: hooks.isPidInUnit,
      }))
    )
  ) {
    const proof = await (
      hooks.proveDaemon ??
      ((pid: number) =>
        proveOwnedDaemonProcess({ pid, daemonRoot: hooks.paths.root }))
    )(daemon.pid);
    if (proof.kind === "owned") {
      logger.info({
        message: `Stopping directly started hackd (pid ${proof.pid}) so systemd can manage it`,
      });
      await hooks.stopDirect(proof);
    } else {
      logger.warn({
        message: `Left pid ${daemon.pid} from the hackd pid file running: ${describeDaemonProcessRefusal(proof.reason)}. ${handoverRefusalAdvice(proof.reason)}`,
      });
    }
  }
}

function reportLinger(opts: { readonly linger: boolean | null }): void {
  const command = LINGER_ENABLE_COMMAND;
  if (opts.linger === true) {
    logger.info({
      message:
        "  Linger: on (hackd starts at boot and keeps running after logout)",
    });
    return;
  }
  if (opts.linger === false) {
    logger.warn({
      message: `Linger is off: hackd starts at login and stops when your last session ends. To keep it running without a login session, run: ${command}`,
    });
    return;
  }
  logger.info({
    message: `  Linger: unknown. If hackd must run without a login session, run: ${command}`,
  });
}

/** `hack daemon uninstall` on Linux. */
export async function uninstallDaemonSystemdService(opts: {
  readonly deps?: SystemdDeps;
  /** hackd's state directory, for the install restart-pending marker. */
  readonly daemonRoot?: string;
}): Promise<number> {
  const deps = opts.deps ?? defaultSystemdDeps();
  assertSystemdAccess(deps);
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  const result = await uninstallSystemdUnit({ unitPath, deps });
  if (result.ok && opts.daemonRoot) {
    // Without a unit there is nothing left to restart.
    await rm(resolve(opts.daemonRoot, RESTART_PENDING_FILE), { force: true });
  }
  if (!result.ok) {
    logger.error({
      message: `Failed to uninstall the hackd systemd user service: ${result.error}`,
    });
    return 1;
  }
  if (result.notInstalled) {
    logger.info({ message: `${SYSTEMD_UNIT_NAME} was not installed` });
    return 0;
  }
  if (!result.managerNotified) {
    logger.warn({
      message: `Removed ${unitPath}, but systemctl --user is unavailable, so a running service was not stopped`,
    });
    return 0;
  }
  if (result.reloadError !== null) {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} was stopped and disabled and ${unitPath} was removed, but systemctl --user daemon-reload failed (${result.reloadError}), so systemd still has the unit loaded | Run: systemctl --user daemon-reload`,
    });
    return 1;
  }
  logger.success({
    message: `${SYSTEMD_UNIT_NAME} stopped, disabled and removed`,
  });
  return 0;
}
