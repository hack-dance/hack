import { resolveExecutingCliPath } from "../daemon/executing-cli.ts";
import {
  checkLaunchdJobBeforeStart,
  checkLaunchdPlistTrusted,
  checkLaunchdRetargetTarget,
  checkLaunchdServicePath,
  getLaunchdServiceStatus,
  kickstartLaunchdService,
  type LaunchdProgramRepairResult,
  type LaunchdProgramState,
  type LaunchdServiceStatus,
  type LaunchdStartRefusal,
  launchdJobMayBeRunning,
  plistKeepsThisHome,
  proveLaunchdJobOwnership,
  readLaunchdLoadedJob,
  readLaunchdProgramState,
  readLaunchdRefreshTarget,
  refuseRunningRewrite,
  repairLaunchdProgramIfInvalid,
  verifyLaunchdJobBeforeKickstart,
} from "../daemon/launchd.ts";
import type { LaunchdLoadedJob } from "../daemon/launchd-print.ts";
import type { DaemonPaths } from "../daemon/paths.ts";
import { hasAncestorProcess } from "../daemon/process-ancestry.ts";
import type { DaemonCommandTrace } from "../daemon/reconcile.ts";
import { readTextFile } from "../lib/fs.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import { logger } from "../ui/logger.ts";

/**
 * macOS `hack daemon start` and `restart` through a loaded launchd agent
 * (HACK-2216). launchd effects are injectable so the decisions can be
 * driven without launchd.
 */

export interface LaunchdStartHooks {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
  readonly waitForReady: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to the real launchd status. */
  readonly readStatus?: () => Promise<LaunchdServiceStatus | null>;
  /** Defaults to {@link hasAncestorProcess} for this process. */
  readonly isAncestor?: (pid: number) => Promise<boolean | null>;
  /** Defaults to {@link readLaunchdProgramState}. */
  readonly readProgram?: () => Promise<LaunchdProgramState>;
  /** Defaults to {@link repairLaunchdProgramIfInvalid}. */
  readonly repair?: () => Promise<LaunchdProgramRepairResult>;
  /** Defaults to reading the plist; tests pin it. */
  readonly readPlist?: () => Promise<string | null>;
  /** Defaults to {@link proveLaunchdJobOwnership}; tests pin it. */
  readonly proveJob?: () => Promise<boolean>;
  /**
   * The executing CLI ({@link resolveExecutingCliPath}); null: a source
   * invocation. Tests pin it.
   */
  readonly executing?: string | null;
  /** Defaults to {@link checkLaunchdRetargetTarget}; tests pin it. */
  readonly validateRetarget?: (path: string) => Promise<string | null>;
  /**
   * Test seam for {@link checkLaunchdServicePath}: replaces the system
   * directories of the rendered PATH.
   */
  readonly systemPathDirectories?: readonly string[];
  /** Defaults to {@link readLaunchdLoadedJob}; tests pin it. */
  readonly readLoaded?: () => Promise<LaunchdLoadedJob>;
  /** Defaults to bootout plus bootstrap of the plist; tests pin it. */
  /**
   * The uid the plist file and directory checks compare owners to; defaults
   * to this process's. Tests model another account's file with another uid.
   */
  readonly trustUid?: number;
  readonly reloadJob?: () => Promise<{
    readonly ok: boolean;
    readonly error?: string;
  }>;
  /**
   * Called before launchd may be asked to start hackd (a reload or a
   * kickstart), so the caller can tell a refusal from a failed start.
   */
  readonly onStartRequested?: () => void;
  /** Defaults to {@link kickstartLaunchdService}. */
  readonly kickstart?: () => Promise<{
    readonly ok: boolean;
    readonly error?: string;
  }>;
}

async function readStatus(
  hooks: LaunchdStartHooks
): Promise<LaunchdServiceStatus | null> {
  if (hooks.readStatus) {
    return await hooks.readStatus();
  }
  return process.platform === "darwin"
    ? await getLaunchdServiceStatus({ paths: hooks.paths })
    : null;
}

function readProgram(hooks: LaunchdStartHooks): Promise<LaunchdProgramState> {
  return hooks.readProgram
    ? hooks.readProgram()
    : readLaunchdProgramState({
        paths: hooks.paths,
        executing: hooks.executing,
      });
}

/**
 * Whether this process may run under the launchd job: the job's pid is an
 * ancestor of this process (a job hackd started runs `hack daemon start`),
 * so restarting the job would stop the caller. Fails closed: a missing or
 * implausible job pid, or an unreadable ancestry, counts as inside. Only
 * called while this home's hackd runs, so a loaded job without a pid is
 * not evidence that nothing runs under it.
 */
async function runsInsideJob(opts: {
  readonly hooks: LaunchdStartHooks;
  readonly status: LaunchdServiceStatus;
}): Promise<boolean> {
  const jobPid = opts.status.pid;
  if (jobPid === null || !Number.isInteger(jobPid) || jobPid <= 1) {
    return true;
  }
  const isAncestor =
    opts.hooks.isAncestor ??
    ((pid: number) => hasAncestorProcess({ ancestor: pid }));
  return (await isAncestor(jobPid)) !== false;
}

/**
 * Refuses when the loaded plist runs another existing executable, or one
 * that cannot be read: (re)starting it would run a program this CLI does
 * not own. Returns the exit code (reported) or null to go on. Used before
 * `restart` stops anything and before `start` kickstarts a stopped
 * service.
 */
export async function refuseForeignLaunchdProgram(
  hooks: LaunchdStartHooks & { readonly verb: "restart" | "start" }
): Promise<number | null> {
  const status = await readStatus(hooks);
  if (!status?.loaded) {
    return null;
  }
  hooks.trace.manager = "launchd";
  const program = await readProgram(hooks);
  if (program.kind !== "other" && program.kind !== "unknown") {
    return null;
  }
  hooks.trace.blocked =
    program.kind === "other" ? "other-program" : "unknown-program";
  const what =
    program.kind === "other"
      ? `runs ${program.program ?? "another hack"}, not this hack`
      : "has a program this hack cannot read";
  logger.error({
    message: `Not ${hooks.verb === "restart" ? "restarting" : "starting"} hackd through launchd: the launchd service ${what}; nothing was changed | Run: hack daemon install`,
  });
  return 1;
}

/**
 * `start` found this home's hackd running and launchd has the agent
 * loaded. Returns an exit code when start is done, or null to go on as
 * before (already running, or replace an incompatible daemon):
 * - from inside the job nothing is rewritten or restarted: a compatible
 *   daemon is kept, an incompatible one refused;
 * - an incompatible daemon under a plist that runs another existing or
 *   unreadable program is refused with `hack daemon install` (kickstart
 *   would run it again);
 * - a compatible daemon under a stale plist is refreshed and restarted.
 */
export async function checkRunningLaunchdDaemon(
  hooks: LaunchdStartHooks & {
    readonly pid: number;
    readonly compatible: boolean;
  }
): Promise<number | null> {
  const status = await readStatus(hooks);
  if (!status?.loaded) {
    return null;
  }
  const { trace } = hooks;
  trace.manager = "launchd";
  if (await runsInsideJob({ hooks, status })) {
    trace.blocked = "inside-service";
    if (hooks.compatible) {
      return null;
    }
    trace.stale.add("version-mismatch");
    logger.warn({
      message: `hackd (pid ${hooks.pid}) is incompatible with this CLI, but this command may run inside the launchd job (a job hackd started), so restarting it could stop this command too; nothing was changed | Run hack daemon start from a shell outside the service`,
    });
    return 1;
  }
  if (hooks.compatible) {
    return await startViaLaunchdIfLoaded({ ...hooks, onlyIfStale: true });
  }
  const program = await readProgram(hooks);
  if (program.kind === "other" || program.kind === "unknown") {
    trace.stale.add("version-mismatch");
    trace.blocked =
      program.kind === "other" ? "other-program" : "unknown-program";
    logger.warn({
      message: `hackd (pid ${hooks.pid}) is incompatible with this CLI, and the launchd service ${program.kind === "other" ? `runs ${program.program ?? "another hack"}` : "has a program this hack cannot read"}, so restarting it would not run this version | Run: hack daemon install`,
    });
    return 1;
  }
  // The caller is about to stop this daemon and start through launchd:
  // refuse now, with the daemon left running, when launchd would refuse
  // the start (launchdJobBlocksReplacement).
  const blocked = await launchdJobBlocksReplacement({ hooks, status });
  if (blocked !== null) {
    trace.stale.add("version-mismatch");
    trace.blocked = blockedReason(blocked);
    logger.warn({
      message: `hackd (pid ${hooks.pid}) is incompatible with this CLI, but ${describeReplacementBlock(blocked)}, so it was not replaced: hackd keeps running | Check: hack daemon status; then run: hack daemon install`,
    });
    return 1;
  }
  return null;
}

type ReplacementBlock =
  | "home-binding"
  | "unproven-owner"
  | "other-program"
  | "retarget-refused"
  | "refresh-refused"
  | "start-refused"
  | "untrusted-plist";

/** The `--json` blocked reason for a {@link ReplacementBlock}. */
function blockedReason(
  block: ReplacementBlock
):
  | "home-binding"
  | "unproven-owner"
  | "other-program"
  | "rewrite-refused"
  | "untrusted-unit" {
  if (block === "untrusted-plist") {
    return "untrusted-unit";
  }
  return block === "retarget-refused" ||
    block === "refresh-refused" ||
    block === "start-refused"
    ? "rewrite-refused"
    : block;
}

function describeReplacementBlock(block: ReplacementBlock): string {
  switch (block) {
    case "home-binding":
      return "the loaded launchd job binds another Hack home";
    case "unproven-owner":
      return "the loaded launchd job is not proven to be this Hack home's, or this CLI cannot be shown to be what it would run (a source checkout)";
    case "other-program":
      return "the launchd job would be retargeted to a hack that is not this CLI";
    case "refresh-refused":
      return "the launchd plist is stale and the program a refresh would keep, or the PATH it would give hackd, is not fit for a login service (a source file, a temporary location, or a program or PATH directory others can change)";
    case "start-refused":
      return "the program the launchd service runs, or a directory of the PATH it gives hackd, is not safe from other accounts, or the configuration launchd has loaded cannot be read, so launchd would not be asked to start it";
    case "untrusted-plist":
      return "the launchd plist, or a directory above it, could have been written by another account";
    default:
      return "the launchd job's program is gone and the hack it would be retargeted to is not fit for a login service";
  }
}

/**
 * Whether replacing this home's running hackd through the loaded launchd
 * job would be refused (HACK-2216), checked before anything is stopped, so
 * `start` and `restart` refuse up front instead of leaving hackd stopped:
 * - `home-binding`: the plist binds another home (or cannot be read);
 * - `unproven-owner`: the job runs a process not proven to be this home's
 *   hackd (`pid`, a launchd-run hackd of this home, counts as proven);
 * - when the plist's program is missing or virtual, the start after the
 *   stop would retarget it, which {@link repairLaunchdProgramIfInvalid}
 *   allows for a just-stopped daemon only on the same terms as a running
 *   one: the target must pass {@link checkLaunchdRetargetTarget}
 *   (`retarget-refused`) and the executing CLI must be a compiled binary
 *   that is that target ({@link refuseRunningRewrite}: `unproven-owner`
 *   from source, `other-program` for another binary).
 * Null when the replacement may go on.
 */
async function launchdJobBlocksReplacement(opts: {
  readonly hooks: LaunchdStartHooks;
  readonly status: LaunchdServiceStatus;
}): Promise<ReplacementBlock | null> {
  const { hooks, status } = opts;
  // Nothing is stopped for a plist another account could have written: the
  // start after the stop would refuse it before anything else.
  if (
    (await checkLaunchdPlistTrusted({
      plistPath: hooks.paths.launchdPlistPath,
      uid: hooks.trustUid,
    })) !== null
  ) {
    return "untrusted-plist";
  }
  const plistText = await (
    hooks.readPlist ?? (() => readTextFile(hooks.paths.launchdPlistPath))
  )();
  if (plistText === null || !plistKeepsThisHome({ plistText })) {
    return "home-binding";
  }
  const proven = await (
    hooks.proveJob ??
    (() => proveLaunchdJobOwnership({ paths: hooks.paths, status }))
  )();
  if (!proven) {
    return "unproven-owner";
  }
  const program = await readProgram(hooks);
  if (program.kind !== "missing") {
    return await startBlocksReplacement({ hooks, plistText });
  }
  if (program.resolved === null) {
    return "retarget-refused";
  }
  if (!(await rewriteTargetIsFit({ hooks, target: program.resolved }))) {
    return "retarget-refused";
  }
  return await refuseRunningRewrite({
    target: program.resolved,
    executing:
      hooks.executing === undefined
        ? resolveExecutingCliPath()
        : hooks.executing,
  });
}

/**
 * What a rewrite checks just before it writes, predicted before a running
 * daemon is stopped: the program the plist will run
 * ({@link checkLaunchdRetargetTarget}) and the PATH it gives hackd
 * ({@link checkLaunchdServicePath}). True when both pass.
 */
async function rewriteTargetIsFit(opts: {
  readonly hooks: LaunchdStartHooks;
  readonly target: string;
}): Promise<boolean> {
  const { hooks } = opts;
  const unfit =
    (await (hooks.validateRetarget ?? checkLaunchdRetargetTarget)(
      opts.target
    )) ??
    (await checkLaunchdServicePath({
      home: resolveUserHomeDir(),
      systemDirectories: hooks.systemPathDirectories,
    }));
  return unfit === null;
}

/**
 * The start after the stop, predicted for a plist whose program exists:
 * - when it would refresh a stale plist, the program the refresh keeps and
 *   the PATH the refreshed plist gives hackd must pass the checks the
 *   refresh makes just before it writes ({@link rewriteTargetIsFit}), or
 *   nothing is stopped (`refresh-refused`);
 * - otherwise launchd starts the plist as it is, so its program and PATH
 *   must pass {@link checkLaunchdJobBeforeStart}, the check before the
 *   kickstart, or nothing is stopped (`start-refused`).
 * Null when the start may go on.
 */
async function startBlocksReplacement(opts: {
  readonly hooks: LaunchdStartHooks;
  readonly plistText: string;
}): Promise<ReplacementBlock | null> {
  const { hooks } = opts;
  const target = await readLaunchdRefreshTarget({
    paths: hooks.paths,
    plistText: opts.plistText,
    executing: hooks.executing,
  });
  if (target !== null) {
    return (await rewriteTargetIsFit({ hooks, target }))
      ? null
      : "refresh-refused";
  }
  const unsafe = await checkLaunchdJobBeforeStart({
    plistText: opts.plistText,
    systemDirectories: hooks.systemPathDirectories,
  });
  if (unsafe !== null) {
    return "start-refused";
  }
  // The kickstart after the stop runs launchd's loaded configuration. One
  // that differs is reloaded from the checked plist then (the job is no
  // longer running); one that cannot be read at all is refused now, so
  // hackd is not stopped for a start that may be refused.
  const loaded = await (hooks.readLoaded ?? readLaunchdLoadedJob)();
  return loaded.kind === "unknown" ? "start-refused" : null;
}

/**
 * `restart` is about to stop this home's running hackd and start it again
 * through the loaded launchd job (HACK-2216): refuses first, with nothing
 * stopped, when that start would be refused
 * ({@link launchdJobBlocksReplacement}). Exit code (reported) or null to
 * go on; null too when no job is loaded.
 */
export async function refuseLaunchdBeforeReplacing(
  hooks: LaunchdStartHooks & { readonly onManagedStart?: () => void }
): Promise<number | null> {
  const status = await readStatus(hooks);
  if (!status?.loaded) {
    return null;
  }
  hooks.onManagedStart?.();
  const blocked = await launchdJobBlocksReplacement({ hooks, status });
  if (blocked === null) {
    return null;
  }
  hooks.trace.manager = "launchd";
  hooks.trace.blocked = blockedReason(blocked);
  logger.warn({
    message: `Not restarting hackd: ${describeReplacementBlock(blocked)}, so it could not start hackd for this home again; nothing was stopped | Check: hack daemon status; then run: hack daemon install`,
  });
  return 1;
}

/**
 * When launchd manages the daemon, start through launchd. Returns null when
 * no launchd service is loaded, or with `onlyIfStale` when nothing was
 * rewritten. See {@link repairLaunchdProgramIfInvalid} for what is
 * rewritten; `kickstart -k` then (re)starts hackd. A failed rewrite is an
 * error (the unload may already have stopped hackd), never "already
 * running"; a stopped service whose program is another existing or
 * unreadable executable is not kickstarted.
 */
export async function startViaLaunchdIfLoaded(
  hooks: LaunchdStartHooks & { readonly onlyIfStale?: boolean }
): Promise<number | null> {
  const { paths, trace } = hooks;
  // When launchd manages the daemon, start through launchd — spawning a
  // bare process next to a loaded agent means two process managers fight
  // over one socket and pid file.
  const status = await readStatus(hooks);
  if (!status?.loaded) {
    return null;
  }
  trace.manager = "launchd";
  // A repair may reload (bootstrap) the job, which can start it: from here
  // on launchd may have been asked to start hackd.
  hooks.onStartRequested?.();
  // With onlyIfStale, start found this home's hackd running and compatible:
  // a rewrite would unload and restart it, so the repair requires an
  // eligible executing CLI (HACK-2216).
  const repair = await (
    hooks.repair ??
    (() =>
      repairLaunchdProgramIfInvalid({
        paths,
        daemonRunning: hooks.onlyIfStale === true,
        systemPathDirectories: hooks.systemPathDirectories,
      }))
  )();
  if (repair === "failed") {
    logger.error({
      message:
        "The launchd service needed a rewrite that did not complete (unloading, writing or loading the plist failed, or no installed hack was found); hackd may be stopped | Run: hack daemon install, then check: hack daemon status",
    });
    return 1;
  }
  const rewritten = noteRepair({ repair, trace });
  if (!rewritten && hooks.onlyIfStale) {
    return null;
  }
  if (repair === "other-program" || repair === "unknown-program") {
    // Before HACK-2216 start retargeted such a plist to this CLI; it no
    // longer does, and kickstarting it would run a program this CLI does
    // not own.
    const refused = await refuseForeignLaunchdProgram({
      ...hooks,
      verb: "start",
    });
    if (refused !== null) {
      return refused;
    }
    logger.error({
      message:
        "Not starting hackd through launchd: the program it would run is not this CLI; nothing was changed | Run: hack daemon install",
    });
    return 1;
  }
  if (repair === "retarget-refused") {
    logger.error({
      message:
        "Not starting hackd through launchd: its program is gone and the hack it would be retargeted to is not fit for a login service; nothing was changed | Install hack to a stable location, then run: hack daemon install",
    });
    return 1;
  }
  if (repair === "untrusted-plist") {
    logger.error({
      message:
        "Not starting hackd through launchd: its plist, or a directory above it, could have been written by another account; nothing was changed | Make it and ~/Library/LaunchAgents writable only by you, then run: hack daemon install",
    });
    return 1;
  }
  if (repair === "refresh-refused") {
    logger.error({
      message:
        "Not starting hackd through launchd: its plist is stale and the program a refresh would keep, or the PATH it would give hackd, is not fit for a login service; nothing was changed | Make the program and its PATH directories writable only by you (chmod go-w), then run: hack daemon install",
    });
    return 1;
  }
  if (repair === "home-binding" || repair === "unproven-owner") {
    // The loaded job is not provably this home's: kickstarting it would
    // (re)start another home's daemon.
    logger.error({
      message:
        "Not starting hackd through launchd: the loaded launchd job is not proven to serve this Hack home; nothing was changed | Check: hack daemon status; to take the service over for this home, run: hack daemon install",
    });
    return 1;
  }
  // Last, right before launchd is asked to start the job, current plist or
  // just rewritten: its program and the PATH it gives hackd (HACK-2216).
  const unsafe = await refuseUnsafeLaunchdStart(hooks);
  if (unsafe !== null) {
    return unsafe;
  }
  trace.action = rewritten ? "reinstalled" : "started";
  // launchd owns the daemon: never spawn a bare process next to it —
  // two process managers for one socket is how machines end up with
  // start-then-exit flapping and stale-pid contradictions.
  const kick = await (hooks.kickstart ?? kickstartLaunchdService)();
  if (!kick.ok) {
    logger.error({
      message: `launchd kickstart failed: ${kick.error ?? "unknown error"} | Check: hack daemon logs --tail 200`,
    });
    return 1;
  }
  if (await hooks.waitForReady(8000)) {
    logger.success({ message: "hackd started (launchd)" });
    return 0;
  }
  logger.warn({
    message:
      "launchd kickstarted hackd but it did not report ready yet | Check: hack daemon logs --tail 200",
  });
  return 1;
}

/**
 * {@link checkLaunchdJobBeforeStart} on the plist launchd will start, with
 * nothing started on failure: exit code 1 (reported, `blocked:
 * "rewrite-refused"`, `hack daemon install` step) or null to kickstart. A
 * plist that cannot be read is refused.
 */
async function refuseUnsafeLaunchdStart(
  hooks: LaunchdStartHooks
): Promise<number | null> {
  const unsafe = await launchdStartIsUnsafe(hooks);
  if (unsafe === null) {
    return null;
  }
  hooks.trace.action = "none";
  hooks.trace.blocked = unsafe.blocked;
  logger.error({
    message: `Not starting hackd through launchd: ${unsafe.reason}; nothing was started | Make the plist, the program and its PATH directories writable only by you (chmod go-w), then run: hack daemon install`,
  });
  return 1;
}

/** Why launchd must not start the job as its plist is now, or null. */
async function launchdStartIsUnsafe(
  hooks: LaunchdStartHooks
): Promise<LaunchdStartRefusal | null> {
  const plistText = await (
    hooks.readPlist ?? (() => readTextFile(hooks.paths.launchdPlistPath))
  )();
  if (plistText === null) {
    return {
      reason: "the launchd plist could not be read",
      blocked: "rewrite-refused",
    };
  }
  return await verifyLaunchdJobBeforeKickstart({
    paths: hooks.paths,
    plistText,
    // Read fresh right before a reload: the job may have started since
    // start looked. Unknown counts as running (a reload would stop hackd).
    isRunning: async () => {
      const status = await readStatus(hooks);
      return status === null || launchdJobMayBeRunning(status);
    },
    systemDirectories: hooks.systemPathDirectories,
    readLoaded: hooks.readLoaded,
    reload: hooks.reloadJob,
    uid: hooks.trustUid,
  });
}

/** Reports a repair result; true when the plist was rewritten. */
function noteRepair(opts: {
  readonly repair: LaunchdProgramRepairResult;
  readonly trace: DaemonCommandTrace;
}): boolean {
  const { repair, trace } = opts;
  switch (repair) {
    case "repaired":
      trace.stale.add("program-missing");
      logger.warn({
        message:
          "Repaired launchd service: its program no longer existed (or was a compiled-binary virtual path)",
      });
      return true;
    case "refreshed":
      trace.stale.add("content");
      logger.warn({
        message:
          "Updated launchd service: its plist differed from what this hack writes",
      });
      return true;
    case "other-program":
      trace.blocked = "other-program";
      logger.info({
        message:
          "The launchd service runs another hack; it is left as it is | To switch it to this hack, run: hack daemon install",
      });
      return false;
    case "unknown-program":
      trace.blocked = "unknown-program";
      logger.info({
        message:
          "The launchd service's program cannot be read (Program/ProgramArguments); it is left as it is | To replace it, run: hack daemon install",
      });
      return false;
    case "home-binding":
      trace.blocked = "home-binding";
      logger.warn({
        message:
          "The launchd plist binds another Hack home (HACK_HOME or HOME in EnvironmentVariables), so it is not rewritten from here | To take the service over for this home, run: hack daemon install",
      });
      return false;
    case "unproven-owner":
      trace.blocked = "unproven-owner";
      logger.warn({
        message:
          "The launchd job is not rewritten or restarted from here: it is not proven to be this Hack home's, or hackd runs and this CLI cannot be shown to be what it would run (a source checkout) | Check: hack daemon status; then run: hack daemon install",
      });
      return false;
    case "retarget-refused":
      trace.stale.add("program-missing");
      trace.blocked = "rewrite-refused";
      logger.warn({
        message:
          "The launchd service's program is gone, and the hack it would be retargeted to is not fit for a login service (a source file, a bun script, a temporary location or one others can change) | Install hack to a stable location, then run: hack daemon install",
      });
      return false;
    case "refresh-refused":
      trace.stale.add("content");
      trace.blocked = "rewrite-refused";
      logger.warn({
        message:
          "The launchd plist is stale, but the program a refresh would keep, or the PATH it would give hackd, is not fit for a login service (a source file, a bun script, a temporary location, or a program or PATH directory others can change), so it was not rewritten or restarted | Fix that, then run: hack daemon install",
      });
      return false;
    case "untrusted-plist":
      trace.blocked = "untrusted-unit";
      logger.warn({
        message:
          "The launchd plist, or a directory above it, could have been written by another account, so it was not rewritten, unloaded or loaded | Make it and ~/Library/LaunchAgents writable only by you, then run: hack daemon install",
      });
      return false;
    case "unmanaged":
      trace.stale.add("content");
      trace.blocked = "unmanaged";
      logger.info({
        message:
          "The launchd plist differs from what this hack writes, but it is not hack's (no managed marker and another Label), so it is left as it is | To replace it, run: hack daemon install",
      });
      return false;
    default:
      return false;
  }
}
