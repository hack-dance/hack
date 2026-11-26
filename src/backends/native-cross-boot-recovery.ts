/**
 * Which receipts of a run whose foreground owner and VM were lost the runtime's
 * cross-boot dead-owner recovery retires once `hack down --recover` has started
 * the pool again. One predicate serves the down (whether to start the pool) and
 * a lost start's message (whether to name `hack down --recover`), so the advice
 * always matches what the down does (#1273 review). It grants no authority: the
 * runtime revalidates the dead owner, the ended boot and every inventory.
 */

/**
 * Graph phases in which an exited foreground owner is recovered: ready, or every
 * service started with some goal still unmet (`started-observed`, written only
 * under `--report-started`; a started return of a restore is one). Only a run
 * with a saved mapping gets here. A fresh start saves its mapping only at ready
 * today, so in the started phase this is a restored run; PR B saves the mapping
 * at started.
 */
export const NATIVE_RECOVERABLE_LIVE_PHASES: ReadonlySet<string> = new Set([
  "ready-observed",
  "started-observed",
  "reconciled-cleanup-only",
]);

/**
 * Phases of a start lost before it was ready that the runtime's cross-boot
 * dead-owner recovery also retires once the pool is started again (HACK-2714):
 * the owner's own unwind leaves `failed-retained`; an owner that died without
 * unwinding leaves its start's `preparing` or (an admitted restore) `restoring`.
 * A restart in progress (`restarting`) is not one. The runtime also requires a
 * settled relay startup and no cleanup marker, which `graph foreground-owner`
 * reports as `cross_boot_start`.
 */
export const NATIVE_CROSS_BOOT_START_PHASES: ReadonlySet<string> = new Set([
  "failed-retained",
  "preparing",
  "restoring",
]);

/**
 * Whether the cross-boot recovery admits a receipt as `graph foreground-owner`
 * reported it: a live phase, or a lost start the runtime itself admits. A
 * pending same-boot recovery (`live_owner_recovery`) resumes only in its own
 * boot, so it is never one. Whether the owner exited is the caller's check.
 */
export function nativeCrossBootRecoverable(selection: {
  readonly phase: string;
  readonly crossBootStart: boolean;
  readonly liveOwnerRecovery: string | null;
}): boolean {
  return (
    selection.liveOwnerRecovery === null &&
    (NATIVE_RECOVERABLE_LIVE_PHASES.has(selection.phase) ||
      (NATIVE_CROSS_BOOT_START_PHASES.has(selection.phase) &&
        selection.crossBootStart))
  );
}
