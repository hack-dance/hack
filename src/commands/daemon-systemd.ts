import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { GLOBAL_DAEMON_DIR_NAME } from "../constants.ts";
import { DAEMON_CLI_VERSION } from "../daemon/client.ts";
import { resolveExecutingCliPath } from "../daemon/executing-cli.ts";
import { isSameExecutableFile } from "../daemon/launchd.ts";
import type { DaemonPaths } from "../daemon/paths.ts";
import {
  type DaemonProcessProbe,
  type DaemonProcessProof,
  type DaemonProcessRefusal,
  defaultDaemonIdentityExpectation,
  describeDaemonProcessRefusal,
  proveOwnedDaemonProcess,
} from "../daemon/process.ts";
import { readLinuxParentPid } from "../daemon/process-image.ts";
import {
  type DaemonCommandTrace,
  type DaemonReconcilePlan,
  planDaemonReconcile,
  recordReconcile,
  type ServiceUnitState,
} from "../daemon/reconcile.ts";
import {
  type DaemonServiceSummary,
  summarizeSystemdService,
} from "../daemon/service-summary.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import {
  assessExecutableDurability,
  checkServiceExecutableTrusted,
  checkServicePathDirectories,
  checkSystemdEffectivePath,
  checkSystemdEffectiveService,
  checkSystemdLoadedUnitPaths,
  checkSystemdStopHooks,
  checkSystemdUnitTrusted,
  checkSystemdUnitTrustedBeforeChange,
  defaultSystemdDeps,
  describeSystemdUnavailable,
  extractSystemdExecProgram,
  findDroppedHomeBinding,
  installSystemdUnit,
  isHackManagedUnit,
  isPidInSystemdUnit,
  isSystemdReadOnly,
  LINGER_ENABLE_COMMAND,
  MANAGER_STOPPABLE_STATES,
  probeSystemdUserManager,
  RENDERED_SYSTEM_PATH_DIRECTORIES,
  readInvokerInSystemdUnit,
  readLingerStatus,
  readSystemdLoadedProgram,
  readSystemdServiceStatus,
  readSystemdUnitHackHome,
  renderedServicePathDirectories,
  renderSystemdUnit,
  resolveExpectedSystemdUnit,
  resolveSystemdAccess,
  resolveSystemdUnitPath,
  retargetSystemdUnitProgram,
  SYSTEMD_UNIT_NAME,
  type SystemdDeps,
  type SystemdServiceStatus,
  type SystemdUnitDrift,
  systemdDaemonReload,
  systemdServiceAction,
  uninstallSystemdUnit,
} from "../daemon/systemd.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { normalizeHomeDir } from "../lib/home-dir.ts";
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
/** The stop refusals' own lead-in, dropped when a restart reuses them. */
const STOP_REFUSAL_PREFIX = /^Not stopping hackd\.service: /;

export interface SystemdCommandHooks {
  readonly paths: DaemonPaths;
  readonly deps?: SystemdDeps;
  /** Starts hackd directly in its own session (the non-service path). */
  readonly startDetached: () => Promise<number>;
  /**
   * Stops a directly started hackd that {@link proveDaemon} proved is this
   * HACK_HOME's daemon, and removes its pid/socket files if still stale.
   * False (already reported) when its exit was not confirmed.
   */
  readonly stopDirect: (
    proof: Extract<DaemonProcessProof, { kind: "owned" }>
  ) => Promise<boolean>;
  /** Defaults to {@link proveOwnedDaemonProcess}; tests pin the observations. */
  readonly proveDaemon?: (pid: number) => Promise<DaemonProcessProof>;
  /** Defaults to {@link assessExecutableDurability}. */
  readonly assessDurability?: typeof assessExecutableDurability;
  readonly waitForReady: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to {@link isPidInSystemdUnit}; tests pin cgroup membership. */
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
  /** Defaults to {@link resolveExpectedSystemdUnit}; tests pin the program. */
  readonly resolveExpected?: typeof resolveExpectedSystemdUnit;
  /**
   * The system directories install checks on the unit's PATH; defaults to
   * {@link RENDERED_SYSTEM_PATH_DIRECTORIES}. Tests point it at their own
   * directories so they do not depend on the host's.
   */
  readonly systemPathDirectories?: readonly string[];
  /**
   * Proves the unit's main process is a hackd holding a socket in
   * `daemonRoot` before an automatic restart; defaults to
   * {@link proveOwnedDaemonProcess}. Tests pin it.
   */
  readonly proveMainProcess?: (
    pid: number,
    daemonRoot: string
  ) => Promise<DaemonProcessProof>;
  /** Test seam for the default main-process proof's observations. */
  readonly probe?: DaemonProcessProbe;
  /** Test seam: a process's parent pid (defaults to /proc). */
  readonly parentPid?: (pid: number) => Promise<number | null>;
  /**
   * Called just before systemd is asked to start the unit, so the caller
   * can tell a refusal (nothing asked) from a failed start.
   */
  readonly onStartRequested?: () => void;
  /**
   * The executing CLI's executable ({@link resolveExecutingCliPath}): what
   * "this CLI" means for automatic restart and rewrite eligibility. Tests
   * pin it; null is a source invocation (never eligible).
   */
  readonly executingProgram?: () => Promise<string | null>;
  /** Defaults to reading `/proc/self/cgroup`; tests pin it. */
  readonly readSelfCgroup?: () => Promise<string | null>;
  /** Records what the command decided, for `--json` (HACK-2216). */
  readonly trace?: DaemonCommandTrace;
  /** Defaults to this CLI's version; tests pin it. */
  readonly cliVersion?: string;
  /**
   * The uid the unit trust checks compare owners to; defaults to this
   * process's. Tests model a file another account owns with another uid.
   */
  readonly trustUid?: number;
}

/**
 * The last check before an automatic restart (HACK-2216): the ownership
 * proof and loaded-program read before it take time, so the program is
 * checked again ({@link checkServiceExecutableTrusted}) and a pathname
 * replaced meanwhile is not what the restart starts. Both the main file's
 * program and the exact pathname systemd will run are checked: the single
 * loaded `ExecStart` ({@link readSystemdLoadedProgram}), which a retained
 * drop-in can point at another path to the same file, with its symlinks
 * and every directory above it. The effective service PATH
 * ({@link checkSystemdEffectivePath}) is checked again too. Exit code 1
 * (reported) or null to restart: `blocked: "unproven-owner"` when the
 * loaded program cannot be read or is not exactly one entry,
 * `rewrite-refused` when a program or PATH directory fails the checks.
 * The stopped start's last check before `systemctl start` is
 * {@link checkSystemdLoadedUnitPaths}, which covers the same program and
 * PATH checks.
 */
async function refuseUntrustedProgramLast(opts: {
  readonly hooks: Pick<SystemdCommandHooks, "trace">;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<number | null> {
  const loaded = await readSystemdLoadedProgram({ deps: opts.deps });
  if (loaded.kind === "unknown") {
    return refuseLastCheck({
      hooks: opts.hooks,
      blocked: "unproven-owner",
      message: `Not restarting ${SYSTEMD_UNIT_NAME}: the program systemd would run could not be read again just before the restart (${loaded.reason})`,
    });
  }
  // The effective PATH too: hackd runs helpers such as `docker` by bare
  // name, and a PATH directory may have become writable meanwhile.
  const untrusted =
    (await checkServiceExecutableTrusted({ path: loaded.path })) ??
    (await checkUnitProgramTrusted({ unitPath: opts.unitPath })) ??
    (await checkSystemdEffectivePath({ deps: opts.deps }));
  return untrusted === null
    ? null
    : refuseLastCheck({
        hooks: opts.hooks,
        blocked: "rewrite-refused",
        message: untrusted,
      });
}

/** Records and reports a refusal of {@link refuseUntrustedProgramLast}. */
function refuseLastCheck(opts: {
  readonly hooks: Pick<SystemdCommandHooks, "trace">;
  readonly blocked: "unproven-owner" | "rewrite-refused";
  readonly message: string;
}): number {
  if (opts.hooks.trace) {
    opts.hooks.trace.action = "none";
    opts.hooks.trace.blocked = opts.blocked;
  }
  logger.error({ message: withInstallStep(opts.message) });
  return 1;
}

/** A refusal that ends with the `hack daemon install` step. */
function withInstallStep(message: string): string {
  return message.includes("hack daemon install")
    ? message
    : `${message} | Run: hack daemon install`;
}

/**
 * Records an untrusted-unit refusal for `--json`: the systemd service was
 * found, nothing changed, `blocked: "untrusted-unit"`.
 */
function recordUntrustedUnit(trace: DaemonCommandTrace | undefined): void {
  if (trace) {
    trace.manager = "systemd";
    trace.action = "none";
    trace.blocked = "untrusted-unit";
  }
}

/**
 * {@link checkSystemdUnitTrustedBeforeChange} for a command: null, or the
 * refusal after recording `blocked: "untrusted-unit"` (nothing changed).
 */
async function refuseUntrustedUnit(opts: {
  readonly hooks: Pick<SystemdCommandHooks, "trace" | "trustUid">;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  const untrusted = await checkSystemdUnitTrustedBeforeChange({
    unitPath: opts.unitPath,
    deps: opts.deps,
    uid: opts.hooks.trustUid,
  });
  if (untrusted !== null) {
    recordUntrustedUnit(opts.hooks.trace);
  }
  return untrusted;
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
/**
 * Before `start` stops this home's incompatible, directly started hackd to
 * replace it (HACK-2216): whether the start that follows would be refused
 * by {@link startViaSystemdIfInstalled}, so the refusal comes first and the
 * running daemon is left alone. Checks what refuses there regardless of
 * the daemon: an untrusted unit, a unit whose Hack home cannot be read, a
 * missing program that read-only mode may not repair, and loaded files or
 * a program Hack cannot vouch for. Null when the start may go on (or does
 * not go through systemd at all, which starts hackd directly).
 * `onManagedStart` observes selection of the service route before its trust checks.
 */
export async function refuseSystemdStartBeforeReplacing(
  hooks: Pick<
    SystemdCommandHooks,
    | "paths"
    | "deps"
    | "resolveExpected"
    | "assessDurability"
    | "systemPathDirectories"
    | "cliVersion"
    | "trustUid"
  > & { readonly onManagedStart?: () => void }
): Promise<{
  readonly message: string;
  readonly blocked:
    | "unproven-owner"
    | "read-only"
    | "rewrite-refused"
    | "untrusted-unit";
} | null> {
  const deps = hooks.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return null;
  }
  const status = await readSystemdServiceStatus({ unitPath, deps });
  if (!status?.availability.available) {
    return null;
  }
  const untrusted = await checkSystemdUnitTrusted({
    unitPath,
    uid: hooks.trustUid,
  });
  if (untrusted !== null) {
    return { message: withInstallStep(untrusted), blocked: "untrusted-unit" };
  }
  const unitHome = await checkUnitServesHome({
    hackHome: dirname(hooks.paths.root),
    deps,
    action: "starting",
  });
  if (unitHome.kind === "foreign") {
    // Start leaves that unit alone and starts this home's hackd directly.
    return null;
  }
  if (unitHome.kind === "unknown") {
    return { message: unitHome.message, blocked: "unproven-owner" };
  }
  hooks.onManagedStart?.();
  // What the start would check before it reads the unit to rewrite or
  // retarget it, or reloads it (HACK-2216): never stop the running daemon
  // for a unit another account could have written.
  const beforeChange = await checkSystemdUnitTrustedBeforeChange({
    unitPath,
    deps,
    uid: hooks.trustUid,
  });
  if (beforeChange !== null) {
    return { message: beforeChange, blocked: "untrusted-unit" };
  }
  // The same plan and rewrite computation the start itself runs after the
  // stop (planStoppedStart, computeUnitRewrite), without writing anything.
  const { plan, expected } = await planStoppedStart({
    status,
    unitPath,
    deps,
    hooks,
  });
  if (plan.service === "refuse") {
    return {
      message: `${describeMissingProgram(status)}; not changing the service here | Run: hack daemon install`,
      blocked: "read-only",
    };
  }
  if (plan.rewrite !== "none") {
    const rewrite = await computeUnitRewrite({
      plan,
      status,
      unitPath,
      deps,
      hooks,
      expected,
    });
    if ("error" in rewrite) {
      return { message: rewrite.error, blocked: "rewrite-refused" };
    }
    // The rewrite replaces only the main file: drop-ins survive it, and
    // the start checks the effective configuration (drop-ins included)
    // after writing. Check what survives now, as that start will. This
    // reads the configuration systemd has loaded, so an unsafe setting the
    // rewrite itself would remove can also refuse here: that only keeps
    // the running daemon, and `hack daemon install` resolves it. A program
    // retarget replaces the (missing) program the loaded copy names, so
    // only the effective PATH is checked then.
    const retained =
      plan.rewrite === "program"
        ? await checkSystemdEffectivePath({ deps })
        : ((await checkSystemdLoadedUnitPaths({ unitPath, deps })) ??
          (await checkSystemdEffectiveService({ deps })));
    return retained === null
      ? null
      : { message: retained, blocked: "rewrite-refused" };
  }
  const loaded =
    (await checkSystemdLoadedUnitPaths({ unitPath, deps })) ??
    (await checkUnitProgramTrusted({ unitPath }));
  return loaded === null
    ? null
    : { message: loaded, blocked: "unproven-owner" };
}

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
  // Never start a unit (or drop-in) another account could have written.
  const untrusted = await checkSystemdUnitTrusted({
    unitPath,
    uid: hooks.trustUid,
  });
  if (untrusted !== null) {
    recordUntrustedUnit(hooks.trace);
    logger.error({ message: withInstallStep(untrusted) });
    return 1;
  }
  const hackHome = dirname(hooks.paths.root);
  const before = await startOnlyForThisHome({ hackHome, deps });
  if (before !== "ours") {
    return before;
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
  // Preparation may have completed a pending reload (or a repair), which
  // loads what is on disk now: check the home systemd will start again.
  const after = await startOnlyForThisHome({ hackHome, deps });
  if (after !== "ours") {
    return after;
  }
  // After a crash loop systemd refuses `start` ("start request repeated too
  // quickly") until the failed state is cleared. Clearing is harmless when
  // the unit is not failed.
  if (status.activeState === "failed") {
    await systemdServiceAction({ action: "reset-failed", deps });
  }
  const loaded =
    (await checkSystemdLoadedUnitPaths({ unitPath, deps })) ??
    (await checkUnitProgramTrusted({ unitPath }));
  if (loaded !== null) {
    logger.error({ message: loaded });
    return 1;
  }
  hooks.onStartRequested?.();
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
 * `hack daemon start` found this home's hackd running (HACK-2216). When
 * hackd.service runs it, brings the service up to this CLI with
 * {@link planDaemonReconcile}: rewrite a stale unit (as
 * {@link prepareSystemdUnitForStart} does) and `systemctl --user restart` it
 * when the unit changed or the daemon reports another version. A version
 * mismatch that a restart cannot fix (the unit runs another existing
 * `hack`, or an ExecStart hack does not read) is refused with the
 * `hack daemon install` step.
 *
 * Returns null when this does not apply (no usable unit, systemd does not
 * run `pid`, the unit serves another Hack home) or nothing needs to change;
 * the caller then goes on as before. Otherwise the exit code.
 */
export async function reconcileRunningSystemdDaemon(
  hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect"> & {
    readonly pid: number;
    /** What the daemon's API reported; null when it did not answer. */
    readonly version: string | null;
  }
): Promise<number | null> {
  const deps = hooks.deps ?? defaultSystemdDeps();
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
    status.stateError !== null ||
    !(await systemdRunsPid({
      status,
      pid: hooks.pid,
      isPidInUnit: hooks.isPidInUnit,
    }))
  ) {
    return null;
  }
  const unitHome = await checkUnitServesHome({
    hackHome: dirname(hooks.paths.root),
    deps,
    action: "starting",
  });
  if (unitHome.kind !== "ours") {
    return null;
  }
  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();
  const marker = resolve(hooks.paths.root, RESTART_PENDING_FILE);
  // A job hackd started (a supervisor job running `hack daemon start`)
  // runs in the unit's cgroup: restarting the unit would stop the caller.
  // Unknown counts as inside.
  const invoker = await readInvokerInSystemdUnit({
    deps,
    readSelfCgroup: hooks.readSelfCgroup,
  });
  // A restart runs what systemd has loaded, drop-ins included, not only
  // the main file: both must be this CLI's executable. While a reload is
  // pending for a unit file that runs this CLI (an earlier repair wrote it
  // but its daemon-reload failed), what is loaded is stale by definition:
  // the restart path reloads first, and the check just before the restart
  // (refuseUnexpectedLoadedProgram) judges the newly loaded program.
  // "This CLI" is the executing binary, not the PATH-selected `hack`
  // (`expected`, the install and retarget target).
  const executing = await resolveExecutingProgram(hooks);
  const fileIsOurs = await unitRunsExpected({ status, executing });
  const reloadPending =
    status.needsReload && !isSystemdReadOnly(deps.env) && fileIsOurs;
  const loaded = reloadPending
    ? ("ours" as const)
    : await loadedProgramIsExpected({ deps, executing });
  const planned = planDaemonReconcile({
    unit: serviceUnitState(status.drift),
    programIsOurs: loaded === "ours" && fileIsOurs,
    readOnly: isSystemdReadOnly(deps.env),
    running: { version: hooks.version },
    restartPending: await pathExists(marker),
    contentBlock: await readContentBlock({ status, unitPath }),
    invokerInsideService: invoker !== "outside",
    cliVersion: hooks.cliVersion ?? DAEMON_CLI_VERSION,
  });
  const plan = gateRestartOnLoadedProgram({
    plan:
      loaded === "unknown" && planned.blocked !== null
        ? { ...planned, blocked: "unproven-owner" as const }
        : planned,
    loaded,
  });
  recordReconcile({ trace: hooks.trace, manager: "systemd", plan });
  if (plan.service === "keep") {
    noteKeptStaleUnit({ plan });
    if (plan.blocked === "read-only") {
      logger.warn({
        message: `${SYSTEMD_UNIT_NAME} has changes that are not loaded yet (a pending reload or restart); not reloading or restarting it here, and hackd already runs this version | Run: hack daemon install (or hack daemon start outside hack doctor --fix)`,
      });
    }
    return null;
  }
  if (plan.service === "refuse") {
    logger.warn({
      message: describeRunningRefusal({
        plan,
        status,
        expected,
        pid: hooks.pid,
      }),
    });
    return 1;
  }
  // Trust comes first in every changing path (HACK-2216): before the unit
  // is read to keep its directives, rewritten, retargeted or reloaded, and
  // before the restart. A rewrite replaces the file as this user, so the
  // check after it would pass for directives another account planted.
  const untrusted = await refuseUntrustedUnit({ hooks, unitPath, deps });
  if (untrusted !== null) {
    logger.error({ message: untrusted });
    return 1;
  }
  // A restart stops the unit's main process and everything in its cgroup:
  // prove first, as `stop` does, that it is this home's hackd (HACK-2216).
  const unproven = await refuseUnprovenRestart({ hooks, status, deps });
  if (unproven !== null) {
    return unproven;
  }
  return await restartReconciledUnit({
    hooks,
    plan,
    status,
    unitPath,
    deps,
    marker,
    homePid: hooks.pid,
  });
}

/**
 * Finishes a daemon-reload that an earlier write left pending
 * (`NeedDaemonReload=yes`) before an automatic restart, then checks again
 * which home the reloaded unit serves. The restart-pending marker is
 * written (or kept) so a failure here is retried as a restart. Under
 * {@link isSystemdReadOnly} nothing is reloaded ("read-only"): the restart
 * goes on with the loaded copy and the marker stays.
 */
async function completeReloadBeforeRestart(opts: {
  readonly hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect">;
  readonly deps: SystemdDeps;
}): Promise<"reloaded" | "read-only" | "failed"> {
  const { hooks, deps } = opts;
  await writeRestartMarker({ paths: hooks.paths });
  if (isSystemdReadOnly(deps.env)) {
    logger.warn({
      message: `systemd has an older copy of ${SYSTEMD_UNIT_NAME} loaded; not reloading it here, so the restart uses that copy | Run: hack daemon install`,
    });
    return "read-only";
  }
  const reload = await systemdDaemonReload({ deps });
  if (!reload.ok) {
    logger.error({
      message: `systemctl --user daemon-reload failed: ${reload.error}; ${SYSTEMD_UNIT_NAME} was not restarted (a later hack daemon start retries) | Check: ${JOURNAL_HINT}`,
    });
    return "failed";
  }
  const unitHome = await checkUnitServesHome({
    hackHome: dirname(hooks.paths.root),
    deps,
    action: "starting",
  });
  if (unitHome.kind !== "ours") {
    logger.error({
      message: `${unitHome.message}; not restarting it after the reload | Run: hack daemon install`,
    });
    return "failed";
  }
  return "reloaded";
}

/**
 * The automatic restart stops the unit's main process and its cgroup, so
 * it needs the same proof as `stop` ({@link checkMainProcessServesHome},
 * {@link decideUnitStop}): the live main process is this home's hackd (or
 * none runs and the configuration names this home). Cgroup membership of
 * this home's pid alone is not enough: this home's hackd may have been
 * started by a job of another home's daemon, or a reload may have pointed
 * the configuration at this home while the running daemon serves another.
 * Returns 1 (reported, nothing changed, `blocked: "unproven-owner"`) or
 * null to go on.
 */
async function refuseUnprovenRestart(opts: {
  readonly hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect"> & {
    readonly pid: number;
  };
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
}): Promise<number | null> {
  const { hooks, status, deps } = opts;
  const decided = await decideUnitStop({
    mainProcess: await checkMainProcessServesHome({
      status,
      daemonRoot: hooks.paths.root,
      prove: hooks.proveMainProcess,
      probe: hooks.probe,
      homePid: hooks.pid,
      isPidInUnit: hooks.isPidInUnit,
      parentPid: hooks.parentPid,
    }),
    unitHome: () =>
      checkUnitServesHome({
        hackHome: dirname(hooks.paths.root),
        deps,
        action: "stopping",
      }),
  });
  if (decided.kind === "stop") {
    return null;
  }
  if (hooks.trace) {
    hooks.trace.action = "none";
    hooks.trace.blocked = "unproven-owner";
  }
  logger.warn({
    message: `Not restarting ${SYSTEMD_UNIT_NAME} to update it: ${decided.message.replace(STOP_REFUSAL_PREFIX, "")}`,
  });
  return 1;
}

/**
 * The reload may have changed what the unit is configured for: prove
 * ownership again just before the restart lands, from a fresh state read
 * only. A failed read reports no main process, which is not evidence that
 * none runs, so it is refused ({@link refuseUnobservedRestart}), never
 * replaced by an earlier snapshot. Returns 1 (reported) or null.
 */
async function proveOwnershipBeforeRestart(opts: {
  readonly hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect">;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly homePid: number;
}): Promise<number | null> {
  const { hooks, deps } = opts;
  const fresh = await readSystemdServiceStatus({
    unitPath: opts.unitPath,
    deps,
  });
  if (fresh === null) {
    return refuseUnobservedRestart({
      hooks,
      detail: "systemd could not be asked",
    });
  }
  if (!fresh.availability.available) {
    return refuseUnobservedRestart({
      hooks,
      detail: describeSystemdUnavailable(fresh.availability),
    });
  }
  if (fresh.stateError !== null) {
    return refuseUnobservedRestart({ hooks, detail: fresh.stateError });
  }
  return await refuseUnprovenRestart({
    hooks: { ...hooks, pid: opts.homePid },
    status: fresh,
    deps,
  });
}

/**
 * The final ownership proof could not observe the unit's state: refused
 * like an unproven owner (`blocked: "unproven-owner"`, no restart).
 */
function refuseUnobservedRestart(opts: {
  readonly hooks: Pick<SystemdCommandHooks, "trace">;
  readonly detail: string;
}): number {
  if (opts.hooks.trace) {
    opts.hooks.trace.action = "none";
    opts.hooks.trace.blocked = "unproven-owner";
  }
  logger.warn({
    message: `Not restarting ${SYSTEMD_UNIT_NAME} to update it: its state could not be read again just before the restart (${opts.detail}), so whose daemon it runs cannot be proven | Run hack daemon start again; check: systemctl --user status ${SYSTEMD_UNIT_NAME}`,
  });
  return 1;
}

/** The refusal for a running hackd whose version a restart cannot fix. */
function describeRunningRefusal(opts: {
  readonly plan: DaemonReconcilePlan;
  readonly status: SystemdServiceStatus;
  readonly expected: { readonly hackBinPath: string } | null;
  readonly pid: number;
}): string {
  const { plan, status, expected } = opts;
  if (plan.blocked === "inside-service") {
    return `hackd (pid ${opts.pid}) is incompatible with this CLI, but this command runs inside ${SYSTEMD_UNIT_NAME} (a job hackd started), so restarting it would stop this command too; nothing was changed | Run hack daemon start from a shell outside the service`;
  }
  if (plan.blocked === "read-only") {
    return `${describeMissingProgram(status)}; not changing the service here | Run: hack daemon install`;
  }
  if (plan.blocked === "unproven-owner") {
    return `hackd (pid ${opts.pid}) is incompatible with this CLI, but the program systemd has loaded for ${SYSTEMD_UNIT_NAME} cannot be read, so a restart is not known to run this version | Check: systemctl --user cat ${SYSTEMD_UNIT_NAME}; then run: hack daemon install`;
  }
  if (plan.blocked === "unknown-program" || status.program === null) {
    return `hackd (pid ${opts.pid}) is incompatible with this CLI, and ${SYSTEMD_UNIT_NAME} has an ExecStart hack does not read, so a restart is not known to run this version | Check: systemctl --user cat ${SYSTEMD_UNIT_NAME}; to switch it to this hack, run: hack daemon install`;
  }
  const target = expected
    ? ` (switches the service to ${expected.hackBinPath})`
    : "";
  return `hackd (pid ${opts.pid}) is incompatible with this CLI, and ${SYSTEMD_UNIT_NAME} runs ${status.program}, so restarting it would start the same version again | Run: hack daemon install${target}`;
}

/**
 * Rewrites the unit when the plan says so, then restarts it through
 * systemd. A restart runs the unit's stop hooks and stops what hackd
 * started, so the same checks as `stop` and `start` run first. The
 * restart-pending marker (shared with install) is written before the unit
 * changes and removed only after the restart, so a failure in between is
 * retried as a restart.
 */
async function restartReconciledUnit(opts: {
  readonly hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect">;
  readonly plan: DaemonReconcilePlan;
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly marker: string;
  /** This home's hackd per its pid file. */
  readonly homePid: number;
}): Promise<number> {
  const { hooks, plan, status, unitPath, deps } = opts;
  let reloadStillPending = false;
  if (plan.rewrite === "none" && status.needsReload) {
    // An earlier repair wrote the unit but its daemon-reload failed: the
    // file is current, systemd's loaded copy is not. Restarting now would
    // run the old configuration and clear the marker, so finish the reload
    // first (keeping the marker until the restart completes).
    const reloaded = await completeReloadBeforeRestart({ hooks, deps });
    if (reloaded === "failed") {
      return 1;
    }
    reloadStillPending = reloaded === "read-only";
  }
  if (plan.rewrite !== "none") {
    await writeRestartMarker({ paths: hooks.paths });
    const rewritten = await rewriteUnitForPlan({
      plan,
      status,
      unitPath,
      deps,
      hooks,
      expected: await (hooks.resolveExpected ?? resolveExpectedSystemdUnit)(),
    });
    if (rewritten !== null) {
      return rewritten;
    }
    // The rewrite reloaded systemd: check again which home the unit now
    // serves before restarting it, as start does after its own repair.
    const unitHome = await checkUnitServesHome({
      hackHome: dirname(hooks.paths.root),
      deps,
      action: "starting",
    });
    if (unitHome.kind !== "ours") {
      logger.error({
        message: `${unitHome.message}; not restarting it after the rewrite | Run: hack daemon install`,
      });
      return 1;
    }
  }
  const blocked =
    (await checkSystemdUnitTrusted({ unitPath, uid: hooks.trustUid })) ??
    (await checkSystemdLoadedUnitPaths({ unitPath, deps })) ??
    (await checkUnitProgramTrusted({ unitPath })) ??
    (await checkSystemdStopHooks({ unitPath, deps }));
  if (blocked !== null) {
    logger.error({ message: blocked });
    return 1;
  }
  // After any rewrite and reload: what systemd will run must be this CLI.
  const unexpected = await refuseUnexpectedLoadedProgram({ hooks, deps });
  if (unexpected !== null) {
    return unexpected;
  }
  const unproven = await proveOwnershipBeforeRestart({
    hooks,
    unitPath,
    deps,
    homePid: opts.homePid,
  });
  if (unproven !== null) {
    return unproven;
  }
  const replaced = await refuseUntrustedProgramLast({ hooks, unitPath, deps });
  if (replaced !== null) {
    return replaced;
  }
  const why = plan.reasons.includes("version-mismatch")
    ? "it runs another hack version"
    : "its unit changed";
  logger.info({ message: `Restarting ${SYSTEMD_UNIT_NAME}: ${why}` });
  const restarted = await systemdServiceAction({ action: "restart", deps });
  if (!restarted.ok) {
    logger.error({
      message: `systemctl --user restart ${SYSTEMD_UNIT_NAME} failed: ${restarted.error} | Check: ${JOURNAL_HINT}`,
    });
    return 1;
  }
  if (!reloadStillPending) {
    await rm(opts.marker, { force: true });
  }
  if (await hooks.waitForReady(READY_TIMEOUT_MS)) {
    logger.success({ message: "hackd restarted (systemd)" });
    return 0;
  }
  logger.warn({
    message: `systemd restarted hackd but it did not report ready yet | Check: hack daemon logs --tail 200 and ${JOURNAL_HINT}`,
  });
  return 1;
}

/**
 * The unit is a per-user singleton: starting (or repairing) it from a
 * shell with another Hack home would start someone else's daemon, and this
 * shell's would never become ready (HACK-2052). "ours" to go on; null when
 * the unit serves another home, which is left alone while this home's hackd
 * is started directly (its socket, pid file and lock live in this home's
 * daemon directory); 1 when the home cannot be read (refused).
 */
async function startOnlyForThisHome(opts: {
  readonly hackHome: string;
  readonly deps: SystemdDeps;
}): Promise<"ours" | null | 1> {
  const unitHome = await checkUnitServesHome({
    hackHome: opts.hackHome,
    deps: opts.deps,
    action: "starting",
  });
  if (unitHome.kind === "foreign") {
    logger.info({ message: `${unitHome.message}; starting hackd directly` });
    return null;
  }
  if (unitHome.kind === "unknown") {
    logger.error({ message: unitHome.message });
    return 1;
  }
  return "ours";
}

/**
 * Whether the unit's effective Hack home ({@link readSystemdUnitHackHome})
 * is `hackHome`. `foreign`: it clearly serves another home, which this
 * shell leaves alone (its own hackd is handled directly). `unknown`: it
 * cannot be read with certainty, which is refused with how to go on.
 */
async function checkUnitServesHome(opts: {
  readonly hackHome: string;
  readonly deps: SystemdDeps;
  readonly action: "starting" | "stopping";
}): Promise<
  | { readonly kind: "ours" }
  | {
      readonly kind: "foreign";
      readonly message: string;
      /** The Hack home the unit's configuration names. */
      readonly path: string;
    }
  | { readonly kind: "unknown"; readonly message: string }
> {
  const unitHome = await readSystemdUnitHackHome({ deps: opts.deps });
  const ours = resolve(opts.hackHome);
  if (unitHome.kind === "home") {
    return unitHome.path === ours
      ? { kind: "ours" }
      : {
          kind: "foreign",
          path: unitHome.path,
          message: `${SYSTEMD_UNIT_NAME} runs hackd for ${unitHome.path}, not ${ours}; not ${opts.action} it from here`,
        };
  }
  const manual =
    opts.action === "starting"
      ? `Check it with systemctl --user cat ${SYSTEMD_UNIT_NAME}, or start it by hand: systemctl --user start ${SYSTEMD_UNIT_NAME}`
      : `To stop it anyway, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`;
  return {
    kind: "unknown",
    message: `Not ${opts.action} ${SYSTEMD_UNIT_NAME}: its Hack home could not be read (${unitHome.detail}). ${manual}`,
  };
}

/**
 * What `hack daemon start` (and autostart, which runs it) may do to an
 * installed unit before starting it. Returns an exit code to stop with, or
 * null to go on and start.
 *
 * The decision is {@link planDaemonReconcile} (HACK-2216):
 * - a unit that runs this CLI's executable (the same path, or one that
 *   resolves to the same file), starts with {@link SYSTEMD_MANAGED_HEADER}
 *   and sets no Hack home a rewrite would drop, but differs from what this
 *   CLI renders for that program is rewritten whole, as install would, keeping
 *   its program path (a stable symlink stays a symlink) and whether it is
 *   enabled;
 * - a unit whose program is gone is retargeted to this CLI, only to a
 *   durable location ({@link assessExecutableDurability}), replacing just
 *   the ExecStart program so every other line is kept;
 * - a unit that runs another existing `hack` is never rewritten (HACK-2052:
 *   the user may have chosen it); start reports the difference and
 *   `hack daemon install` switches it.
 * Under {@link isSystemdReadOnly} (`hack doctor --fix` without a TTY) it
 * neither writes nor reloads. A pending reload (`NeedDaemonReload=yes`, left
 * by a failed reload after a write) is completed first, so a retry recovers.
 */
async function prepareSystemdUnitForStart(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    | "resolveExpected"
    | "assessDurability"
    | "trace"
    | "cliVersion"
    | "systemPathDirectories"
    | "trustUid"
  >;
}): Promise<number | null> {
  const { status, unitPath, deps, hooks } = opts;
  const readOnly = isSystemdReadOnly(deps.env);
  if (status.drift === "program-unknown") {
    // Never evidence that the program is missing: leave the unit as it is.
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} has an ExecStart hack does not read (a prefix, specifier or escape); starting it unchanged`,
    });
  }
  const { plan, expected } = await planStoppedStart({
    status,
    unitPath,
    deps,
    hooks,
  });
  recordReconcile({ trace: hooks.trace, manager: "systemd", plan });
  if (plan.service === "refuse") {
    logger.error({
      message: `${describeMissingProgram(status)}; not changing the service here | Run: hack daemon install`,
    });
    return 1;
  }
  if (plan.rewrite !== "none" || (status.needsReload && !readOnly)) {
    // Trust before the unit is read to keep its directives, rewritten or
    // reloaded: the rewrite replaces the file as this user, so a later
    // check would pass for text another account planted.
    const untrusted = await refuseUntrustedUnit({ hooks, unitPath, deps });
    if (untrusted !== null) {
      logger.error({ message: untrusted });
      return 1;
    }
  }
  if (plan.rewrite !== "none") {
    return await rewriteUnitForPlan({
      plan,
      status,
      unitPath,
      deps,
      hooks,
      expected,
    });
  }
  return await completePendingReload({
    status,
    deps,
    expected,
    readOnly,
    plan,
  });
}

/**
 * The plan for starting the unit with no hackd running: what
 * {@link prepareSystemdUnitForStart} does, and what
 * {@link refuseSystemdStartBeforeReplacing} checks before it stops a
 * running daemon. Reads only; records nothing.
 */
async function planStoppedStart(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "resolveExpected" | "cliVersion" | "executingProgram"
  >;
}): Promise<{
  readonly plan: DaemonReconcilePlan;
  readonly expected: { readonly hackBinPath: string } | null;
}> {
  const { status, unitPath, deps, hooks } = opts;
  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();
  const plan = planDaemonReconcile({
    unit: serviceUnitState(status.drift),
    programIsOurs: await unitRunsExpected({
      status,
      executing: await resolveExecutingProgram(hooks),
    }),
    readOnly: isSystemdReadOnly(deps.env),
    running: null,
    contentBlock: await readContentBlock({ status, unitPath }),
    cliVersion: hooks.cliVersion ?? DAEMON_CLI_VERSION,
  });
  return { plan, expected };
}

/** {@link ServiceUnitState} for a unit's {@link SystemdUnitDrift}. */
function serviceUnitState(drift: SystemdUnitDrift): ServiceUnitState {
  return drift === "none" ? "current" : drift;
}

/**
 * Whether the unit runs the executing CLI's executable
 * ({@link resolveExecutingProgram}, not the PATH-selected install target):
 * the same path, or a path that resolves to the same file (a stable
 * symlink to it). False when the executing CLI has no executable a unit
 * could name (a source invocation).
 */
async function unitRunsExpected(opts: {
  readonly status: SystemdServiceStatus;
  readonly executing: string | null;
}): Promise<boolean> {
  const { status, executing } = opts;
  if (status.program === null || executing === null) {
    return false;
  }
  return await isSameExecutableFile(status.program, executing);
}

/**
 * The executing CLI's executable for eligibility decisions
 * ({@link resolveExecutingCliPath}); tests pin it with `executingProgram`.
 */
async function resolveExecutingProgram(
  hooks: Pick<SystemdCommandHooks, "executingProgram">
): Promise<string | null> {
  return hooks.executingProgram
    ? await hooks.executingProgram()
    : resolveExecutingCliPath();
}

/**
 * The loaded-executable gate in front of every automatic restart
 * (HACK-2216), whatever led to it (a version mismatch, a pending-restart
 * marker, a rewrite): the program systemd has loaded must be this CLI's.
 * `other` keeps the daemon (`other-program`), `unknown` too
 * (`unproven-owner`); a version mismatch is then refused instead. The
 * restart-pending marker is left in place. A program retarget is the one
 * exception here, since the loaded copy still names the missing program;
 * its result is checked after the reload instead
 * ({@link refuseUnexpectedLoadedProgram}), as every restart is.
 */
function gateRestartOnLoadedProgram(opts: {
  readonly plan: DaemonReconcilePlan;
  readonly loaded: "ours" | "other" | "unknown";
}): DaemonReconcilePlan {
  const { plan, loaded } = opts;
  if (
    plan.service !== "restart" ||
    plan.rewrite === "program" ||
    loaded === "ours"
  ) {
    return plan;
  }
  return {
    rewrite: "none",
    service: plan.reasons.includes("version-mismatch") ? "refuse" : "keep",
    reasons: plan.reasons,
    blocked: loaded === "unknown" ? "unproven-owner" : "other-program",
  };
}

/**
 * Just before an automatic restart, after any rewrite and reload: the
 * program systemd has loaded now must be this CLI's executable, or the
 * restart would run another one (a retained drop-in can override the
 * rewritten ExecStart). Returns 1 (reported, marker kept, nothing
 * restarted) or null to go on.
 */
async function refuseUnexpectedLoadedProgram(opts: {
  readonly hooks: Pick<SystemdCommandHooks, "trace" | "executingProgram">;
  readonly deps: SystemdDeps;
}): Promise<number | null> {
  const loaded = await loadedProgramIsExpected({
    deps: opts.deps,
    executing: await resolveExecutingProgram(opts.hooks),
  });
  if (loaded === "ours") {
    return null;
  }
  const blocked = loaded === "unknown" ? "unproven-owner" : "other-program";
  if (opts.hooks.trace) {
    opts.hooks.trace.action = "none";
    opts.hooks.trace.blocked = blocked;
  }
  logger.warn({
    message: `Not restarting ${SYSTEMD_UNIT_NAME}: the program systemd has loaded for it ${loaded === "unknown" ? "cannot be read" : "is not this hack (a drop-in overrides ExecStart)"}, so a restart would not run this version | Check: systemctl --user cat ${SYSTEMD_UNIT_NAME}; then run: hack daemon install`,
  });
  return 1;
}

/**
 * Whether the program systemd has loaded for the unit (its single
 * ExecStart, drop-ins included: {@link readSystemdLoadedProgram}) is this
 * CLI's executable by file identity ({@link isSameExecutableFile}).
 * `unknown` when it cannot be read; `other` for any other program.
 */
async function loadedProgramIsExpected(opts: {
  readonly deps: SystemdDeps;
  /** The executing CLI ({@link resolveExecutingProgram}); null: unknown. */
  readonly executing: string | null;
}): Promise<"ours" | "other" | "unknown"> {
  const loaded = await readSystemdLoadedProgram({ deps: opts.deps });
  if (loaded.kind === "unknown" || opts.executing === null) {
    return "unknown";
  }
  return (await isSameExecutableFile(loaded.path, opts.executing))
    ? "ours"
    : "other";
}

/**
 * Why a content-stale unit must not be rewritten automatically (HACK-2216):
 * `unmanaged` when its main file does not start with
 * {@link SYSTEMD_MANAGED_HEADER} (owner decision: hand-written units keep the
 * HACK-2052 behaviour), `home-binding` when it binds the service to a Hack
 * home that the rendered unit would drop ({@link findDroppedHomeBinding}).
 */
async function readContentBlock(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
}): Promise<"unmanaged" | "home-binding" | null> {
  const { status } = opts;
  if (status.drift !== "content" || status.program === null) {
    return null;
  }
  const unitText = await readTextFile(opts.unitPath);
  if (unitText === null || !isHackManagedUnit({ unitText })) {
    return "unmanaged";
  }
  const rendered = renderSystemdUnit({ hackBinPath: status.program });
  return rendered === null || findDroppedHomeBinding({ unitText, rendered })
    ? "home-binding"
    : null;
}

/** Says why a stale unit was left as it is, when it was. */
function noteKeptStaleUnit(opts: { readonly plan: DaemonReconcilePlan }): void {
  const { blocked } = opts.plan;
  if (blocked === "unmanaged") {
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} differs from what this hack writes, but it was not written by hack (no managed header), so it is left as it is | To replace it, run: hack daemon install`,
    });
  } else if (blocked === "home-binding") {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} differs from what this hack writes, but it sets the service's Hack home (HACK_HOME, HOME or an EnvironmentFile) in its main file, which a rewrite would drop; it is left as it is | Move that setting into a drop-in (systemctl --user edit hackd), then run: hack daemon install`,
    });
  } else if (blocked === "inside-service") {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} is stale, but this command runs inside it (a job hackd started), so it was not rewritten or restarted | Run hack daemon start from a shell outside the service`,
    });
  }
}

function describeMissingProgram(status: SystemdServiceStatus): string {
  return `${SYSTEMD_UNIT_NAME} runs a program that no longer exists (${status.program ?? "unreadable ExecStart"})`;
}

type UnitRewrite =
  | {
      readonly unitText: string;
      readonly done: string;
      /** Reported, not refused (as install reports it). */
      readonly warning?: string;
    }
  | { readonly error: string };

/**
 * Carries out a plan's unit rewrite (`content` or `program`) with the
 * checks `hack daemon install` uses: the program and the PATH it gives
 * hackd must be safe from other accounts, and {@link installSystemdUnit}
 * checks the unit directories. An enabled unit stays enabled and a
 * disabled one stays disabled. Returns 1 (reported) on failure, else null.
 */
async function rewriteUnitForPlan(opts: {
  readonly plan: DaemonReconcilePlan;
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "assessDurability" | "systemPathDirectories" | "trace"
  >;
  readonly expected: { readonly hackBinPath: string } | null;
}): Promise<number | null> {
  const { status, unitPath, deps } = opts;
  const rewritten = await computeUnitRewrite(opts);
  if ("error" in rewritten) {
    logger.error({ message: rewritten.error });
    return 1;
  }
  if (rewritten.warning) {
    logger.warn({ message: rewritten.warning });
  }
  // An automatic rewrite never repairs (no `repair`): a directory or unit
  // file that became writable after the earlier checks is refused, with
  // its mode unchanged, and nothing is written, reloaded or restarted.
  const repaired = await installSystemdUnit({
    unitPath,
    unitText: rewritten.unitText,
    deps,
    // Keep the user's choice: a disabled unit is repaired, not re-enabled.
    enable: status.enabled,
    forceReload: status.needsReload,
  });
  if (!repaired.ok) {
    if (repaired.untrusted && opts.hooks.trace) {
      opts.hooks.trace.action = "none";
      opts.hooks.trace.blocked = "untrusted-unit";
    }
    logger.error({
      message: `Failed to repair ${SYSTEMD_UNIT_NAME}: ${repaired.error}`,
    });
    return 1;
  }
  logger.warn({ message: rewritten.done });
  return null;
}

/**
 * The non-mutating half of a plan's rewrite: the new unit text, or why it
 * cannot be written (an unresolvable or non-durable replacement program,
 * an unrenderable program, or a program or service PATH that fails
 * install's checks). Shared by the real rewrite and by the check that runs
 * before a running daemon is stopped ({@link refuseSystemdStartBeforeReplacing}),
 * so the two cannot disagree. It reads the file system as it is now: a
 * change between the check and the write, or a write or reload failing,
 * is outside what it can promise.
 */
async function computeUnitRewrite(opts: {
  readonly plan: DaemonReconcilePlan;
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "assessDurability" | "systemPathDirectories"
  >;
  readonly expected: { readonly hackBinPath: string } | null;
}): Promise<UnitRewrite> {
  const { plan, status, unitPath, deps, hooks, expected } = opts;
  return plan.rewrite === "program"
    ? await retargetMissingProgram({ status, unitPath, deps, hooks, expected })
    : await renderCurrentUnit({ status, deps, hooks });
}

/** The unit text for a `program` rewrite: only ExecStart is replaced. */
async function retargetMissingProgram(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "assessDurability" | "systemPathDirectories"
  >;
  readonly expected: { readonly hackBinPath: string } | null;
}): Promise<UnitRewrite> {
  const { expected } = opts;
  const missing = describeMissingProgram(opts.status);
  if (!expected) {
    return {
      error: `${missing} and no installed hack was found to replace it | Put hack on PATH, then run: hack daemon install`,
    };
  }
  const durability = await (
    opts.hooks.assessDurability ?? assessExecutableDurability
  )({ path: expected.hackBinPath });
  if (!durability.durable) {
    return {
      error: `${missing}. This CLI (${expected.hackBinPath}) is not a stable location for a login service: ${durability.reason} | Install hack to a stable location, then run: hack daemon install`,
    };
  }
  // The new program and the PATH it gives hackd pass install's checks.
  const unsafe = await checkInstallPrograms({
    hackBinPath: expected.hackBinPath,
    deps: opts.deps,
    systemPathDirectories: opts.hooks.systemPathDirectories,
  });
  if (unsafe !== null) {
    return { error: `${missing}. ${unsafe}` };
  }
  const unitText = await readTextFile(opts.unitPath);
  const retargeted =
    unitText === null
      ? null
      : retargetSystemdUnitProgram({
          unitText,
          hackBinPath: expected.hackBinPath,
        });
  if (retargeted === null) {
    return {
      error: `${missing} and its ExecStart could not be updated | Run: hack daemon install`,
    };
  }
  return {
    unitText: retargeted,
    done: `Repaired ${SYSTEMD_UNIT_NAME}: its program no longer existed; it now runs ${expected.hackBinPath} (other lines kept)`,
  };
}

/**
 * The unit text for a `content` rewrite: what this CLI renders for the
 * unit's own program, after the program and PATH checks install runs.
 * Durability is only reported, as install does: the program is unchanged.
 */
async function renderCurrentUnit(opts: {
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
  readonly hooks: Pick<
    SystemdCommandHooks,
    "assessDurability" | "systemPathDirectories"
  >;
}): Promise<UnitRewrite> {
  const program = opts.status.program;
  const unitText =
    program === null ? null : renderSystemdUnit({ hackBinPath: program });
  if (program === null || unitText === null) {
    return {
      error: `${SYSTEMD_UNIT_NAME} differs from what this hack writes, but its program cannot be written into a new unit | Run: hack daemon install`,
    };
  }
  const unsafe = await checkInstallPrograms({
    hackBinPath: program,
    deps: opts.deps,
    systemPathDirectories: opts.hooks.systemPathDirectories,
  });
  if (unsafe !== null) {
    return { error: unsafe };
  }
  const durability = await (
    opts.hooks.assessDurability ?? assessExecutableDurability
  )({ path: program });
  return {
    unitText,
    done: `Updated ${SYSTEMD_UNIT_NAME}: it differed from what this hack writes for ${program} (local changes belong in a drop-in: systemctl --user edit hackd)`,
    ...(durability.durable
      ? {}
      : {
          warning: `The service runs ${program}, which may not last: ${durability.reason}. Install hack to a stable location and run \`hack daemon install\` from there.`,
        }),
  };
}

/**
 * Start without a rewrite: note a unit left stale (it runs another `hack`,
 * or writes are not allowed here) and finish a reload that an earlier
 * write left pending.
 */
async function completePendingReload(opts: {
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
  readonly expected: { readonly hackBinPath: string } | null;
  readonly readOnly: boolean;
  readonly plan: DaemonReconcilePlan;
}): Promise<number | null> {
  const { status, expected, plan } = opts;
  if (
    expected &&
    status.program &&
    expected.hackBinPath !== status.program &&
    !(await isSameExecutableFile(status.program, expected.hackBinPath))
  ) {
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} runs ${status.program}; this CLI is ${expected.hackBinPath}. To switch the service to it, run: hack daemon install`,
    });
  }
  if (plan.blocked === "read-only") {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} differs from what this hack writes; not changing it here | Run: hack daemon install`,
    });
  }
  noteKeptStaleUnit({ plan });
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

/**
 * The program the unit file runs right now (after any repair), checked by
 * {@link checkServiceExecutableTrusted}. An ExecStart the parser does not
 * read (a prefix or specifier) has no path to check; the unit file itself
 * was already checked to be this user's.
 */
async function checkUnitProgramTrusted(opts: {
  readonly unitPath: string;
}): Promise<string | null> {
  const unitText = await readTextFile(opts.unitPath);
  const program = unitText ? extractSystemdExecProgram({ unitText }) : null;
  return program === null
    ? null
    : await checkServiceExecutableTrusted({ path: program });
}

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
  /** The invoking CLI's Hack home (the parent of its daemon root). */
  readonly hackHome: string;
  readonly deps?: SystemdDeps;
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
  /**
   * Proves the unit's main process is this home's hackd; defaults to
   * {@link proveOwnedDaemonProcess} on `<hackHome>/daemon`. Tests pin it.
   */
  readonly proveDaemon?: (
    pid: number,
    daemonRoot: string
  ) => Promise<DaemonProcessProof>;
  /** Test seam for the default proof's observations. */
  readonly probe?: DaemonProcessProbe;
  /** Test seam: a process's parent pid (defaults to /proc). */
  readonly parentPid?: (pid: number) => Promise<number | null>;
}): Promise<{
  readonly handled: boolean;
  readonly ownedPid: boolean;
  /** systemctl stop failed: the manager may still (re)start hackd. */
  readonly failed: string | null;
  /**
   * Not stopped: the unit belongs to another Hack home, or its Hack home
   * could not be read. The message says how to stop it by hand.
   */
  readonly refused: string | null;
}> {
  const none = { handled: false, ownedPid: false, failed: null, refused: null };
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return none;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  // Ask the manager even without a file at this path: a unit whose file was
  // removed, or one loaded from another directory, can still be running or
  // waiting to restart (HACK-2052).
  const status = await readSystemdServiceStatus({ unitPath, deps });
  if (!status?.availability.available) {
    return none;
  }
  const checkMainProcess = () =>
    checkMainProcessServesHome({
      status,
      daemonRoot: resolve(opts.hackHome, GLOBAL_DAEMON_DIR_NAME),
      prove: opts.proveDaemon,
      probe: opts.probe,
      homePid: opts.pid,
      isPidInUnit: opts.isPidInUnit,
      parentPid: opts.parentPid,
    });
  if (!status.installed) {
    return await stopWithoutUnitFile({
      status,
      unitPath,
      hackHome: opts.hackHome,
      deps,
      checkMainProcess,
    });
  }
  // A failed state read reports no main process, which is not evidence
  // that none runs: one serving another home could be stopped on the
  // configuration alone. Refused with the manual steps (HACK-2052).
  if (status.stateError !== null) {
    return {
      ...none,
      refused: `Not stopping ${SYSTEMD_UNIT_NAME}: systemd could not report its state or main process (${status.stateError}), so whose daemon it runs cannot be checked. Check: systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it anyway, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`,
    };
  }
  if (
    status.activeState !== null &&
    !MANAGER_STOPPABLE_STATES.has(status.activeState)
  ) {
    return none;
  }
  // The unit is a per-user singleton: stopping it from a shell with another
  // Hack home would stop someone else's daemon (HACK-2052). With a live main
  // process, what it serves is proven from the process itself (its socket
  // in this home's daemon directory), not from the loaded configuration,
  // which a reload without a restart can change under a running daemon.
  const decided = await decideUnitStop({
    mainProcess: await checkMainProcess(),
    unitHome: () =>
      checkUnitServesHome({
        hackHome: opts.hackHome,
        deps,
        action: "stopping",
      }),
  });
  if (decided.kind === "leave") {
    logger.info({ message: decided.message });
    return none;
  }
  if (decided.kind === "refuse") {
    return { ...none, refused: decided.message };
  }
  const ownedPid =
    opts.pid !== null &&
    (await systemdRunsPid({
      status,
      pid: opts.pid,
      isPidInUnit: opts.isPidInUnit,
    }));
  // `stop` runs the unit's ExecStop hooks and OnSuccess= units: check what
  // systemd has loaded first, and never run what Hack cannot vouch for.
  const hooksError = await checkSystemdStopHooks({ unitPath, deps });
  if (hooksError !== null) {
    return {
      ...none,
      // systemd runs stop hooks and OnSuccess= units whenever the service
      // stops (even after `systemctl kill`): the unsafe entry goes first.
      refused: `${hooksError}. Stopping it could run what that configuration adds: fix it, run systemctl --user daemon-reload, then run hack daemon stop again`,
    };
  }
  // The checks above judged the main process systemd reported then; the
  // stop acts on whatever runs when it lands. Read it again just before: a
  // different main pid (a crash and restart meanwhile), or a read that
  // fails (the manager unavailable, or the unit's state not reported), is
  // refused, also when no main process was seen (a pending restart). This narrows the gap without closing it: a change
  // after this read, or the same pid reused in between, is not detected.
  const latest = await readSystemdServiceStatus({ unitPath, deps });
  if (
    latest === null ||
    !latest.availability.available ||
    latest.stateError !== null ||
    latest.mainPid !== status.mainPid
  ) {
    return {
      ...none,
      refused: `Not stopping ${SYSTEMD_UNIT_NAME}: its main process changed while it was being checked, or could not be read again (pid ${status.mainPid ?? "none"}, now ${latest === null || !latest.availability.available || latest.stateError !== null ? "unknown" : (latest.mainPid ?? "none")}). Run hack daemon stop again; to stop it anyway, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`,
    };
  }
  const stopped = await systemdServiceAction({ action: "stop", deps });
  if (!stopped.ok) {
    return { handled: false, ownedPid, failed: stopped.error, refused: null };
  }
  return { handled: true, ownedPid, failed: null, refused: null };
}

/**
 * Whether `stop` may stop the installed unit, from its main process and,
 * where that does not decide, its loaded configuration (HACK-2052):
 * - this home's proven hackd: stop;
 * - an unidentifiable process: refuse;
 * - a hackd without this home's socket: left alone (the caller still stops
 *   this home's own hackd) only with positive evidence that it is another
 *   home's: the configuration names that home and the process is proven
 *   to hold a socket in that home's daemon directory (or it exited
 *   meanwhile). Otherwise refused: it may still be starting, its sockets
 *   may be unreadable, or a reload changed the configuration under it;
 * - no live process (a pending restart): the configuration decides.
 */
async function decideUnitStop(opts: {
  readonly mainProcess: MainProcessCheck;
  readonly unitHome: () => ReturnType<typeof checkUnitServesHome>;
}): Promise<
  | { readonly kind: "stop" }
  | { readonly kind: "leave" | "refuse"; readonly message: string }
> {
  const { mainProcess } = opts;
  if (mainProcess.kind === "ours") {
    return { kind: "stop" };
  }
  if (mainProcess.kind === "refused") {
    return { kind: "refuse", message: mainProcess.message };
  }
  const unitHome = await opts.unitHome();
  if (unitHome.kind === "unknown") {
    return { kind: "refuse", message: unitHome.message };
  }
  if (mainProcess.kind === "none") {
    return unitHome.kind === "foreign"
      ? { kind: "leave", message: unitHome.message }
      : { kind: "stop" };
  }
  if (unitHome.kind === "ours") {
    return { kind: "refuse", message: mainProcess.message };
  }
  return (await foreignHomeProven({ mainProcess, home: unitHome.path }))
    ? { kind: "leave", message: unitHome.message }
    : {
        kind: "refuse",
        message: mainProcess.unprovenMessage(unitHome.path),
      };
}

/**
 * Positive evidence that a hackd without this home's socket is `home`'s
 * daemon: proven ({@link proveOwnedDaemonProcess}, identity stable) to hold
 * a socket in that home's daemon directory, or gone meanwhile (then
 * nothing runs, and the configuration decides, as for a pending restart).
 */
async function foreignHomeProven(opts: {
  readonly mainProcess: Extract<MainProcessCheck, { kind: "foreign" }>;
  readonly home: string;
}): Promise<boolean> {
  const proof = await opts.mainProcess.proveIn(
    resolve(opts.home, GLOBAL_DAEMON_DIR_NAME)
  );
  return proof.kind === "owned" || proof.reason === "not-running";
}

/**
 * `stop` when no unit file is at the managed path (HACK-2052): see the
 * comments below. Never runs `systemctl stop`; it reports nothing to do or
 * refuses with the manual steps.
 */
async function stopWithoutUnitFile(opts: {
  readonly status: SystemdServiceStatus;
  readonly unitPath: string;
  readonly hackHome: string;
  readonly deps: SystemdDeps;
  readonly checkMainProcess: () => Promise<MainProcessCheck>;
}): Promise<{
  readonly handled: false;
  readonly ownedPid: false;
  readonly failed: null;
  readonly refused: string | null;
}> {
  const { status, unitPath, deps } = opts;
  const none = {
    handled: false,
    ownedPid: false,
    failed: null,
    refused: null,
  } as const;
  // A failed read is not evidence that nothing runs: a pending
  // Restart=on-failure may remain, so it is refused, not reported as
  // stopped (HACK-2052). An observed inactive or not-found unit is
  // nothing to do.
  if (status.stateError !== null) {
    return {
      ...none,
      refused: `Not stopping ${SYSTEMD_UNIT_NAME}: there is no unit file at ${unitPath}, but systemd could not report whether it still runs or will restart (${status.stateError}). Check: systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it by hand, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`,
    };
  }
  if (
    status.activeState === null ||
    !MANAGER_STOPPABLE_STATES.has(status.activeState)
  ) {
    return none;
  }
  // Another home's unit, loaded from its own directory (for example a
  // shell whose HOME points elsewhere): not this shell's to stop or refuse
  // over, when nothing runs (a pending restart, or its main process exited
  // while checked) or what runs is proven to hold a socket in that home's
  // daemon directory. Anything else is refused below: without the unit
  // file it cannot be checked (HACK-2052).
  const loadedHome = await readSystemdUnitHackHome({ deps });
  if (
    loadedHome.kind === "home" &&
    loadedHome.path !== resolve(opts.hackHome)
  ) {
    const mainProcess =
      status.mainPid === null ? null : await opts.checkMainProcess();
    if (
      mainProcess === null ||
      mainProcess.kind === "none" ||
      (mainProcess.kind === "foreign" &&
        (await foreignHomeProven({ mainProcess, home: loadedHome.path })))
    ) {
      return none;
    }
  }
  return {
    ...none,
    refused: `Not stopping ${SYSTEMD_UNIT_NAME}: systemd has it ${status.activeState}, but not from ${unitPath}, the unit Hack manages (it was removed or is loaded from another directory), so it cannot be checked. Review it with systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it anyway, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`,
  };
}

/**
 * Whether the unit's live main process is this home's hackd, from evidence
 * tied to that process ({@link proveOwnedDaemonProcess}: a hackd image
 * holding a socket in `daemonRoot`), never from configuration (HACK-2052).
 * `none`: no live main process (none reported, or it exited meanwhile).
 * `foreign`: a live hackd that does not hold this home's socket. That is
 * not yet evidence of another home (it may still be starting, or its
 * sockets may be unreadable): the caller proves it against the home the
 * configuration names with `proveIn`. `message` is the refusal when the
 * configuration names this home; `unprovenMessage` when it names another
 * home the process is not proven to serve.
 * `refused`: a live process that cannot be identified (unreadable, not a
 * hackd, or changed while checked), with the manual status and stop steps.
 */
type MainProcessCheck =
  | { readonly kind: "ours" }
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "foreign";
      readonly message: string;
      readonly unprovenMessage: (home: string) => string;
      readonly proveIn: (daemonRoot: string) => Promise<DaemonProcessProof>;
    };

async function checkMainProcessServesHome(opts: {
  readonly status: SystemdServiceStatus;
  readonly daemonRoot: string;
  /** Proves `pid` is a hackd holding a socket in `daemonRoot`; tests pin it. */
  readonly prove?: (
    pid: number,
    daemonRoot: string
  ) => Promise<DaemonProcessProof>;
  readonly probe?: DaemonProcessProbe;
  /** This home's hackd per its pid file, if one is running. */
  readonly homePid: number | null;
  readonly isPidInUnit?: (pid: number) => Promise<boolean | null>;
  /** Defaults to {@link readLinuxParentPid}; tests pin it. */
  readonly parentPid?: (pid: number) => Promise<number | null>;
}): Promise<MainProcessCheck> {
  const pid = opts.status.mainPid;
  if (pid === null) {
    return { kind: "none" };
  }
  // systemd names this process; it may run another install or checkout
  // than this CLI, so any foreground daemon start counts as hackd, and the
  // socket in this home's daemon directory proves the home.
  const expectation = {
    ...(await defaultDaemonIdentityExpectation()),
    anyBunEntry: true,
  };
  const proveAt = (candidate: number, daemonRoot: string) =>
    opts.prove
      ? opts.prove(candidate, daemonRoot)
      : proveOwnedDaemonProcess({
          pid: candidate,
          daemonRoot,
          expectation,
          probe: opts.probe,
        });
  const prove = (candidate: number) => proveAt(candidate, opts.daemonRoot);
  const proof = await prove(pid);
  if (proof.kind === "owned") {
    return { kind: "ours" };
  }
  if (proof.reason === "not-running") {
    return { kind: "none" };
  }
  // A `#!` launcher that runs hackd as a child (no `exec`) is the main
  // process itself: then the hackd named by this home's pid file must be
  // proven this home's, be in the unit (its cgroup) and be the launcher's
  // direct child. The cgroup alone also holds whatever the unit's processes
  // started, such as this home's hackd started detached from a job of
  // another home's daemon; still process evidence, not configuration.
  if (
    proof.reason === "not-hackd" &&
    opts.homePid !== null &&
    opts.homePid !== pid &&
    (await prove(opts.homePid)).kind === "owned" &&
    (await (
      opts.isPidInUnit ??
      ((child: number) => isPidInSystemdUnit({ pid: child }))
    )(opts.homePid)) === true &&
    (await (opts.parentPid ?? readLinuxParentPid)(opts.homePid)) === pid
  ) {
    return { kind: "ours" };
  }
  const manual = `Check: systemctl --user status ${SYSTEMD_UNIT_NAME}; to stop it anyway, run: systemctl --user stop ${SYSTEMD_UNIT_NAME}`;
  if (proof.reason === "foreign-socket") {
    // A hackd without this home's socket: another home's, or one that has
    // not bound its socket yet (just started, even if systemd already
    // reports it active), or whose sockets cannot be read. The caller
    // proves it against the home the configuration names.
    return {
      kind: "foreign",
      proveIn: (daemonRoot) => proveAt(pid, daemonRoot),
      unprovenMessage: (home) =>
        `Not stopping ${SYSTEMD_UNIT_NAME}: its main process (pid ${pid}) is a hackd that is not proven to hold a socket of this Hack home (${opts.daemonRoot}) or of the one its configuration names (${resolve(home, GLOBAL_DAEMON_DIR_NAME)}). It may still be starting: run hack daemon stop again in a moment. Otherwise its sockets could not be read. ${manual}`,
      message: `Not stopping ${SYSTEMD_UNIT_NAME}: its main process (pid ${pid}) is a hackd that does not hold this Hack home's daemon socket (${opts.daemonRoot}), while the unit's configuration names this home. It may still be starting: run hack daemon stop again in a moment. Otherwise it serves another Hack home (a reload changes the unit's configuration, not the running process). ${manual}`,
    };
  }
  // Still starting: its socket may not be bound yet, which is not evidence
  // of another home.
  const why =
    opts.status.activeState === "activating"
      ? "systemd reports it still starting, so it may not have bound its socket yet; run hack daemon stop again in a moment"
      : "it may serve another Hack home (a reload changes the unit's configuration, not the running process)";
  return {
    kind: "refused",
    message: `Not stopping ${SYSTEMD_UNIT_NAME}: its main process (pid ${pid}) is not proven to be the hackd of this Hack home (${opts.daemonRoot}): ${describeDaemonProcessRefusal(proof.reason)}. ${why}. ${manual}`,
  };
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
  readonly executingProgram?: () => Promise<string | null>;
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
  // The executing binary, not the PATH-selected `hack`: the same
  // executable under another path (a stable symlink to it) is not "another
  // hack", and a unit for an older `hack` first on PATH is (HACK-2216).
  const executing = await resolveExecutingProgram(opts);
  if (await unitRunsExpected({ status, executing })) {
    return null;
  }
  const expected = await (opts.resolveExpected ?? resolveExpectedSystemdUnit)();
  const target = expected
    ? ` (switches the service to ${expected.hackBinPath})`
    : "";
  return `hackd (pid ${opts.pid}) is incompatible with this CLI, and ${SYSTEMD_UNIT_NAME} runs ${status.program}, which is not this CLI, so restarting it would not run this version | Run: hack daemon install${target}`;
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
  readonly executingProgram?: () => Promise<string | null>;
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
    executingProgram: opts.executingProgram,
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
  const start = await readInstallStartingPoint({
    hackBinPath: expected.hackBinPath,
    unitPath,
    hackHome: dirname(hooks.paths.root),
    deps,
    systemPathDirectories: hooks.systemPathDirectories,
  });
  if ("error" in start) {
    logger.error({ message: start.error });
    return 1;
  }
  const { before } = start;
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
    hackHome: dirname(hooks.paths.root),
    // Explicit `hack daemon install`: the only caller that repairs Hack's
    // own directories and replaces an untrusted unit file (HACK-2216).
    repair: true,
  });
  if (!installed.ok) {
    logger.error({
      message: `Failed to install the hackd systemd user service: ${installed.error}`,
    });
    return 1;
  }
  recordInstall({ trace: hooks.trace, before, changed: installed.changed });
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

  if (!(await handOverDirectDaemon({ hooks, before }))) {
    // The directly started hackd may still hold the socket: starting the
    // unit now would only make its copy exit. Stop here.
    return 1;
  }

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
  if (!(await runInstalledUnit({ action, unitPath, deps }))) {
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

/** Records what install changed, for `--json`. */
function recordInstall(opts: {
  readonly trace: DaemonCommandTrace | undefined;
  readonly before: SystemdServiceStatus | null;
  readonly changed: boolean;
}): void {
  const { trace, before } = opts;
  if (!trace) {
    return;
  }
  trace.manager = "systemd";
  if (!opts.changed) {
    trace.action = "none";
    return;
  }
  trace.action = before?.installed ? "reinstalled" : "installed";
  if (before?.installed && before.drift === "content") {
    trace.stale.add("content");
  }
  if (before?.installed && before.drift === "program-missing") {
    trace.stale.add("program-missing");
  }
}

/**
 * What install checks before it writes anything: the programs and PATH the
 * new unit uses ({@link checkInstallPrograms}), then the unit as systemd
 * has it now, which must not be another home's running unit
 * ({@link refuseForeignRunningUnit}).
 */
async function readInstallStartingPoint(opts: {
  readonly hackBinPath: string;
  readonly unitPath: string;
  readonly hackHome: string;
  readonly deps: SystemdDeps;
  readonly systemPathDirectories?: readonly string[];
}): Promise<
  { readonly before: SystemdServiceStatus | null } | { readonly error: string }
> {
  const program = await checkInstallPrograms({
    hackBinPath: opts.hackBinPath,
    deps: opts.deps,
    systemPathDirectories: opts.systemPathDirectories,
  });
  if (program !== null) {
    return { error: program };
  }
  const before = await readSystemdServiceStatus({
    unitPath: opts.unitPath,
    deps: opts.deps,
  });
  const foreign = await refuseForeignRunningUnit({
    before,
    hackHome: opts.hackHome,
    deps: opts.deps,
  });
  return foreign === null ? { before } : { error: foreign };
}

/**
 * Before install rewrites or reloads anything: a unit that systemd runs (or
 * is about to run), wherever it was loaded from, must serve this Hack home,
 * read from the config systemd has loaded now (HACK-2052). Rewriting first
 * would drop another home's `HACK_HOME` (or shadow a unit loaded from
 * another directory), pass the later check, and restart (stop) that home's
 * daemon. An unreadable home, or a state systemd could not report, is
 * refused too. Null, or the refusal with how to go on.
 */
async function refuseForeignRunningUnit(opts: {
  readonly before: SystemdServiceStatus | null;
  readonly hackHome: string;
  readonly deps: SystemdDeps;
}): Promise<string | null> {
  const { before } = opts;
  if (!before?.availability.available) {
    return null;
  }
  if (before.activeState === null) {
    return `Not replacing ${SYSTEMD_UNIT_NAME}: systemd could not report its state, so whether it runs hackd for another Hack home is unknown. Check: systemctl --user status ${SYSTEMD_UNIT_NAME}, then run hack daemon install again`;
  }
  if (!MANAGER_STOPPABLE_STATES.has(before.activeState)) {
    return null;
  }
  const unitHome = await readSystemdUnitHackHome({ deps: opts.deps });
  const ours = resolve(opts.hackHome);
  if (unitHome.kind === "home" && unitHome.path === ours) {
    return null;
  }
  const whose =
    unitHome.kind === "home"
      ? `it runs hackd for ${unitHome.path}, not ${ours}`
      : `its Hack home could not be read (${unitHome.detail})`;
  return `Not replacing the running ${SYSTEMD_UNIT_NAME}: ${whose}. Uninstall it from that Hack home, or stop it by hand (systemctl --user stop ${SYSTEMD_UNIT_NAME}), then run: hack daemon install`;
}

/**
 * Before install writes or enables anything: the program the unit will run
 * and every directory on the PATH it gives hackd must be safe from other
 * accounts ({@link checkServiceExecutableTrusted},
 * {@link checkServicePathDirectories}).
 */
async function checkInstallPrograms(opts: {
  readonly hackBinPath: string;
  readonly deps: SystemdDeps;
  readonly systemPathDirectories?: readonly string[];
}): Promise<string | null> {
  return (
    (await checkServiceExecutableTrusted({ path: opts.hackBinPath })) ??
    (await checkServicePathDirectories({
      dirs: renderedServicePathDirectories({
        hackBinPath: opts.hackBinPath,
        home: normalizeHomeDir(opts.deps.env.HOME) ?? homedir(),
        systemDirectories: opts.systemPathDirectories,
      }),
    }))
  );
}

/**
 * Starts or restarts the installed unit once the files systemd loads for it
 * pass {@link checkSystemdLoadedUnitPaths}. False (reported) otherwise.
 */
async function runInstalledUnit(opts: {
  readonly action: "start" | "restart";
  readonly unitPath: string;
  readonly deps: SystemdDeps;
}): Promise<boolean> {
  const loaded = await checkSystemdLoadedUnitPaths({
    unitPath: opts.unitPath,
    deps: opts.deps,
  });
  if (loaded !== null) {
    logger.error({ message: loaded });
    return false;
  }
  const started = await systemdServiceAction({
    action: opts.action,
    deps: opts.deps,
  });
  if (!started.ok) {
    logger.error({
      message: `systemctl --user ${opts.action} ${SYSTEMD_UNIT_NAME} failed: ${started.error} | Check: ${JOURNAL_HINT}`,
    });
    return false;
  }
  return true;
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
  if (
    opts.before?.active &&
    (await readTextFile(opts.unitPath)) !== opts.unitText
  ) {
    return await writeRestartMarker({ paths: opts.hooks.paths });
  }
  return resolve(opts.hooks.paths.root, RESTART_PENDING_FILE);
}

/** Writes the restart-pending marker; returns its path. */
async function writeRestartMarker(opts: {
  readonly paths: DaemonPaths;
}): Promise<string> {
  const marker = resolve(opts.paths.root, RESTART_PENDING_FILE);
  // Owner-only whatever the umask: a shared ~/.hack would fail the
  // service PATH check (and hackd's own state-directory check).
  await mkdir(opts.paths.root, { recursive: true, mode: 0o700 });
  await writeFile(marker, "restart hackd.service to load its new unit\n");
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
 * running and reported. False when a proven hackd's exit was not confirmed.
 */
async function handOverDirectDaemon(opts: {
  readonly hooks: SystemdCommandHooks;
  readonly before: SystemdServiceStatus | null;
}): Promise<boolean> {
  const { hooks, before } = opts;
  const daemon = await readDaemonStatus({ paths: hooks.paths });
  if (
    !(daemon.running && daemon.pid !== null) ||
    (before &&
      (await systemdRunsPid({
        status: before,
        pid: daemon.pid,
        isPidInUnit: hooks.isPidInUnit,
      })))
  ) {
    return true;
  }
  const proof = await (
    hooks.proveDaemon ??
    ((pid: number) =>
      proveOwnedDaemonProcess({ pid, daemonRoot: hooks.paths.root }))
  )(daemon.pid);
  if (proof.kind !== "owned") {
    logger.warn({
      message: `Left pid ${daemon.pid} from the hackd pid file running: ${describeDaemonProcessRefusal(proof.reason)}. ${handoverRefusalAdvice(proof.reason)}`,
    });
    return true;
  }
  logger.info({
    message: `Stopping directly started hackd (pid ${proof.pid}) so systemd can manage it`,
  });
  return await hooks.stopDirect(proof);
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
  const result = await uninstallSystemdUnit({
    unitPath,
    deps,
    // The Hack home whose daemon this CLI manages (daemonRoot's parent).
    hackHome: opts.daemonRoot ? dirname(opts.daemonRoot) : undefined,
  });
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
