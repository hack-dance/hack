import {
  getLaunchdServiceStatus,
  kickstartLaunchdService,
  type LaunchdServiceStatus,
  readLaunchdProgramState,
  repairLaunchdProgramIfInvalid,
} from "../daemon/launchd.ts";
import type { DaemonPaths } from "../daemon/paths.ts";
import { hasAncestorProcess } from "../daemon/process-ancestry.ts";
import type { DaemonCommandTrace } from "../daemon/reconcile.ts";
import { logger } from "../ui/logger.ts";

/**
 * macOS `hack daemon start` through a loaded launchd agent (HACK-2216).
 * `waitForReady` and the ancestry reader are injected so the decisions can
 * be driven without launchd.
 */

export interface LaunchdStartHooks {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
  readonly waitForReady: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to the real launchd status. */
  readonly readStatus?: () => Promise<LaunchdServiceStatus | null>;
  /** Defaults to {@link hasAncestorProcess} for this process. */
  readonly isAncestor?: (pid: number) => Promise<boolean | null>;
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

/**
 * Whether this process runs under the launchd job: its pid is an ancestor
 * of this process (a job hackd started runs `hack daemon start`). Restarting
 * the job would stop the caller. An unreadable ancestry counts as inside.
 */
async function runsInsideJob(opts: {
  readonly hooks: LaunchdStartHooks;
  readonly status: LaunchdServiceStatus;
}): Promise<boolean> {
  const jobPid = opts.status.pid;
  if (jobPid === null || jobPid <= 1) {
    return false;
  }
  const isAncestor =
    opts.hooks.isAncestor ??
    ((pid: number) => hasAncestorProcess({ ancestor: pid }));
  return (await isAncestor(jobPid)) !== false;
}

/**
 * `start` found this home's hackd running and launchd has the agent
 * loaded. Returns an exit code when start is done, or null to go on as
 * before (already running, or replace an incompatible daemon):
 * - from inside the job nothing is rewritten or restarted: a compatible
 *   daemon is kept, an incompatible one refused;
 * - an incompatible daemon under a plist that runs another existing `hack`
 *   is refused with `hack daemon install` (kickstart would run it again);
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
      message: `hackd (pid ${hooks.pid}) is incompatible with this CLI, but this command runs inside the launchd job (a job hackd started), so restarting it would stop this command too; nothing was changed | Run hack daemon start from a shell outside the service`,
    });
    return 1;
  }
  if (hooks.compatible) {
    return await startViaLaunchdIfLoaded({ ...hooks, onlyIfStale: true });
  }
  const program = await readLaunchdProgramState({ paths: hooks.paths });
  if (program.kind === "other") {
    trace.stale.add("version-mismatch");
    trace.blocked = "other-program";
    logger.warn({
      message: `hackd (pid ${hooks.pid}) is incompatible with this CLI, and the launchd service runs ${program.program ?? "another hack"}, so restarting it would start the same version again | Run: hack daemon install`,
    });
    return 1;
  }
  return null;
}

/**
 * When launchd manages the daemon, start through launchd. Returns null when
 * no launchd service is loaded, or with `onlyIfStale` when nothing was
 * rewritten. See {@link repairLaunchdProgramIfInvalid} for what is
 * rewritten; `kickstart -k` then (re)starts hackd.
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
  const repair = await repairLaunchdProgramIfInvalid({ paths });
  const rewritten = noteRepair({ repair, trace });
  if (!rewritten && hooks.onlyIfStale) {
    return null;
  }
  trace.action = rewritten ? "reinstalled" : "started";
  // launchd owns the daemon: never spawn a bare process next to it —
  // two process managers for one socket is how machines end up with
  // start-then-exit flapping and stale-pid contradictions.
  const kick = await kickstartLaunchdService();
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
  readonly repair: Awaited<ReturnType<typeof repairLaunchdProgramIfInvalid>>;
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
