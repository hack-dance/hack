import {
  getLaunchdServiceStatus,
  kickstartLaunchdService,
  type LaunchdProgramRepairResult,
  type LaunchdProgramState,
  type LaunchdServiceStatus,
  readLaunchdProgramState,
  repairLaunchdProgramIfInvalid,
} from "../daemon/launchd.ts";
import type { DaemonPaths } from "../daemon/paths.ts";
import { hasAncestorProcess } from "../daemon/process-ancestry.ts";
import type { DaemonCommandTrace } from "../daemon/reconcile.ts";
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
    : readLaunchdProgramState({ paths: hooks.paths });
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
  return null;
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
  const repair = await (
    hooks.repair ?? (() => repairLaunchdProgramIfInvalid({ paths }))
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
    return await refuseForeignLaunchdProgram({ ...hooks, verb: "start" });
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
