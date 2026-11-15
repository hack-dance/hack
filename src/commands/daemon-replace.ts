import type { DaemonCommandTrace } from "../daemon/reconcile.ts";
import { logger } from "../ui/logger.ts";

/**
 * How `start` tried to start hackd once none of this home's ran, reported
 * by the start itself (never inferred from the `--json` trace):
 * - `service-refused`: the service path refused before asking the manager
 *   to start anything (an untrusted unit, an unreadable home, a refused
 *   rewrite...);
 * - `service-attempted`: the manager was asked to start (or load) hackd;
 * - `direct-attempted`: hackd was started directly, or another starter
 *   owns the start (no service involved, nothing to fall back to).
 * `manager` names the service involved, null when none was.
 */
export interface ReplacementStartOutcome {
  readonly kind: "service-refused" | "service-attempted" | "direct-attempted";
  readonly exitCode: number;
  readonly manager: "systemd" | "launchd" | null;
}

/**
 * Whether the service manager will not start hackd on its own any more:
 * `idle` only on positive evidence (nothing queued, no restart or KeepAlive
 * retry pending); `pending` when it may still start it; `unknown` when it
 * cannot be told. Only `idle` allows a direct start next to it.
 */
export type ServiceManagerState = "idle" | "pending" | "unknown";

/**
 * `start` has stopped this home's incompatible, running hackd to replace
 * it (HACK-2216). Starts the replacement through the service manager, and
 * when that is refused, fails, or throws after the stop, starts this home's
 * hackd directly instead (the detached start used when the unit serves
 * another home), so a replacement does not leave hackd stopped.
 *
 * The direct start runs only when all of these hold:
 * - the service path was involved (`outcome.kind` is not
 *   `direct-attempted`: a direct start, or another starter, already ran);
 * - no hackd of this home answers now;
 * - the manager is positively idle ({@link ServiceManagerState}): otherwise
 *   a pending start, restart timer or KeepAlive retry could start a second
 *   daemon next to the direct one. Then the service error stands with
 *   `blocked: "service-pending"`.
 * The daemon was running before the stop, so this is allowed in the
 * post-update reconcile-only mode too.
 *
 * Success reports action `restarted` with `fallback: "direct"` and keeps
 * the service path's `blocked` reason. If the direct start also fails, the
 * service's result stands: its exit code, or its error rethrown.
 *
 * A start that reports success only counts when `verifyStarted` confirms
 * the replacement answers on this home's socket and reports this CLI's
 * version: a pid and a socket are not enough, because an older `hack`
 * could have been started (HACK-2216). Otherwise the replacement failed:
 * exit 1, action `none`, never `restarted`.
 */
export async function startReplacementDaemon(opts: {
  readonly trace: DaemonCommandTrace;
  readonly startViaService: () => Promise<ReplacementStartOutcome>;
  readonly startDirect: () => Promise<number>;
  /** Whether this home's hackd runs (pid alive and socket present) now. */
  readonly isRunning: () => Promise<boolean>;
  /** The manager's state; `manager` null: the platform's own manager. */
  readonly managerState: (
    manager: "systemd" | "launchd" | null
  ) => Promise<ServiceManagerState>;
  /**
   * Null when the started hackd answers on this home's socket and reports
   * this CLI's version; otherwise what it reports instead.
   */
  readonly verifyStarted: () => Promise<string | null>;
}): Promise<number> {
  const { trace } = opts;
  let outcome: ReplacementStartOutcome;
  let thrown: { readonly error: unknown } | null = null;
  try {
    outcome = await opts.startViaService();
  } catch (error: unknown) {
    // A rejection after the stop is a failed service start, not a reason
    // to leave hackd stopped; which manager got how far is unknown.
    thrown = { error };
    outcome = { kind: "service-attempted", exitCode: 1, manager: null };
  }
  if (outcome.exitCode === 0) {
    if (await refuseUnverified({ trace, verify: opts.verifyStarted })) {
      return 1;
    }
    if (trace.action === "started") {
      trace.action = "restarted";
    }
    return 0;
  }
  const fail = (): number => {
    if (thrown) {
      throw thrown.error;
    }
    return outcome.exitCode;
  };
  if (outcome.kind === "direct-attempted" || (await opts.isRunning())) {
    return fail();
  }
  const state = await opts.managerState(outcome.manager);
  const manager = outcome.manager ?? "service";
  if (state !== "idle") {
    trace.blocked = "service-pending";
    logger.warn({
      message: `The ${manager} service could not start the replacement hackd, and it ${state === "pending" ? "may still start it (a queued start, restart or retry is pending)" : "could not be checked for a pending start"}, so hackd was not started directly next to it | Check: hack daemon status in a moment; if hackd is still stopped, run: hack daemon install`,
    });
    return fail();
  }
  logger.warn({
    message: `The ${manager} service could not start the replacement hackd; starting it directly so it keeps running (it stops at logout or reboot) | Run: hack daemon install`,
  });
  const direct = await opts.startDirect();
  if (direct !== 0) {
    return fail();
  }
  if (await refuseUnverified({ trace, verify: opts.verifyStarted })) {
    return 1;
  }
  trace.action = "restarted";
  trace.fallback = "direct";
  return 0;
}

/**
 * What `verifyStarted` reports for a probe of this home's socket: null when
 * the daemon answers and is compatible with this CLI (reports its
 * version), otherwise what it does instead.
 */
export function describeUnverifiedReplacement(api: {
  readonly reachable: boolean;
  readonly compatible: boolean;
  readonly version: string | null;
}): string | null {
  if (!api.reachable) {
    return "it does not answer on this home's socket";
  }
  return api.compatible
    ? null
    : `it reports version ${api.version ?? "unknown"}, not this CLI's`;
}

/**
 * True (reported, action `none`) when the replacement that started is not
 * this CLI's hackd on this home's socket.
 */
async function refuseUnverified(opts: {
  readonly trace: DaemonCommandTrace;
  readonly verify: () => Promise<string | null>;
}): Promise<boolean> {
  const problem = await opts.verify();
  if (problem === null) {
    return false;
  }
  opts.trace.action = "none";
  logger.error({
    message: `hackd was replaced, but ${problem}, so it is not running this version | Run: hack daemon install, then check: hack daemon status`,
  });
  return true;
}
