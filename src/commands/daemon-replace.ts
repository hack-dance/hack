import type { DaemonCommandTrace } from "../daemon/reconcile.ts";
import { logger } from "../ui/logger.ts";

/**
 * `start` has stopped this home's incompatible, running hackd to replace
 * it (HACK-2216). Starts the replacement through the service manager, and
 * when that is refused or fails for any reason after the stop, starts this
 * home's hackd directly instead (the detached start used when the unit
 * serves another home), so a replacement never leaves hackd stopped.
 *
 * The pre-stop checks refuse what they can foresee; this covers what they
 * cannot (runtime failures, changes between the check and the start). The
 * direct start runs only when the service path was used (`trace.manager`
 * is not `none`; otherwise it was already the direct start) and no hackd
 * of this home answers now (the service may have started one that is
 * still getting ready). The daemon was running before the stop, so this
 * is allowed in the post-update reconcile-only mode too.
 *
 * Success reports action `restarted` with `fallback: "direct"` and keeps
 * the service path's `blocked` reason; if the direct start also fails,
 * the service path's exit code is returned.
 */
export async function startReplacementDaemon(opts: {
  readonly trace: DaemonCommandTrace;
  readonly startViaService: () => Promise<number>;
  readonly startDirect: () => Promise<number>;
  /** Whether this home's hackd runs (pid alive and socket present) now. */
  readonly isRunning: () => Promise<boolean>;
}): Promise<number> {
  const { trace } = opts;
  const code = await opts.startViaService();
  if (code === 0) {
    if (trace.action === "started") {
      trace.action = "restarted";
    }
    return 0;
  }
  if (trace.manager === "none" || (await opts.isRunning())) {
    return code;
  }
  const manager = trace.manager;
  logger.warn({
    message: `The ${manager} service could not start the replacement hackd; starting it directly so it keeps running (it stops at logout or reboot) | Run: hack daemon install`,
  });
  const direct = await opts.startDirect();
  if (direct !== 0) {
    return code;
  }
  trace.action = "restarted";
  trace.fallback = "direct";
  return 0;
}
