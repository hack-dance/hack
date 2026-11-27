import { isRecord } from "../lib/guards.ts";

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
 * reported it: a live phase whose dead relay owner the runtime can prove
 * (`cross_boot_relay`: the run holds a bridge slot, or its relay startup
 * settled; a run with no published port and an unsettled relay startup is
 * refused with `relay_owner_refused`, HACK-2731), or a lost start the runtime
 * itself admits. A pending same-boot recovery (`live_owner_recovery`) resumes
 * only in its own boot, so it is never one. Whether the owner exited is the
 * caller's check.
 */
export function nativeCrossBootRecoverable(selection: {
  readonly phase: string;
  readonly crossBootStart: boolean;
  readonly crossBootRelay: boolean;
  readonly liveOwnerRecovery: string | null;
}): boolean {
  return (
    selection.liveOwnerRecovery === null &&
    ((NATIVE_RECOVERABLE_LIVE_PHASES.has(selection.phase) &&
      selection.crossBootRelay) ||
      (NATIVE_CROSS_BOOT_START_PHASES.has(selection.phase) &&
        selection.crossBootStart))
  );
}

/**
 * Whether the cross-boot recovery refuses a live receipt only because it cannot
 * prove the dead relay owner (`cross_boot_relay` false: no published port and
 * an unsettled relay startup, HACK-2731). A receipt in any other phase is not
 * refused for that reason: a ready-stage loss whose receipt is not live (a VM
 * lost during the owner's own stop, `cleanup-intent` or `stopped-data-retained`)
 * keeps the down advice, whose own paths handle that phase (#1279 review).
 */
export function nativeLiveRelayUnprovable(selection: {
  readonly phase: string;
  readonly crossBootRelay: boolean;
}): boolean {
  return (
    NATIVE_RECOVERABLE_LIVE_PHASES.has(selection.phase) &&
    !selection.crossBootRelay
  );
}

const RECEIPT_SHA = /^[a-f0-9]{64}$/;
const RECOVERY_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FOREGROUND_STATES = new Set(["absent", "running", "exited", "uncertain"]);

/** What `graph foreground-owner` selected; it grants no recovery authority. */
export type NativeForegroundOwnerSelection = {
  readonly phase: string;
  readonly receiptSha256: string;
  readonly foreground: "absent" | "running" | "exited" | "uncertain";
  /** Original receipt digest of an interrupted same-boot dead-owner recovery. */
  readonly liveOwnerRecovery: string | null;
  readonly deadOwnerRecovery: string | null;
  /** Guest completion commit. Retirement still finishes and verifies reservation release. */
  readonly deadOwnerRecoveryComplete: boolean;
  readonly deadOwnerRecoveryError: string | null;
  readonly failedStartRecoverable: boolean;
  /**
   * The runtime's cross-boot recovery admits this receipt as a start lost before
   * ready (`cross_boot_start`: a lost-start phase, a settled relay startup and no
   * cleanup marker). Absent from an older runtime, which never admitted one.
   */
  readonly crossBootStart: boolean;
  /**
   * That recovery can prove the dead owner's relay (`cross_boot_relay`): the
   * run holds a bridge slot, or its relay startup settled (HACK-2731). Absent
   * from an older runtime, which did not report it: true, as before.
   */
  readonly crossBootRelay: boolean;
  /**
   * A lost-removal repair whose storage barrier has not confirmed
   * (`lost_removal_pending`, HACK-2719), read from its host marker. Absent
   * from an older runtime: false.
   */
  readonly lostRemovalPending: boolean;
};

/**
 * Parse a `graph foreground-owner` reply for `run`: the one parser of that
 * reply, shared by `hack down` and a lost start's advice so the two cannot
 * read it differently (#1273 review). Undefined for any reply that is not
 * exactly a selection of this run and owner.
 */
export function parseNativeForegroundOwner(
  value: unknown,
  run: { readonly run: string; readonly owner: string }
): NativeForegroundOwnerSelection | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !optionalBoolean(value.failed_start_recoverable) ||
    !optionalBoolean(value.cross_boot_start) ||
    !optionalBoolean(value.cross_boot_relay) ||
    !optionalBoolean(value.lost_removal_pending) ||
    value.run !== run.run ||
    value.owner !== run.owner ||
    typeof value.phase !== "string" ||
    typeof value.receipt_sha256 !== "string" ||
    !RECEIPT_SHA.test(value.receipt_sha256) ||
    typeof value.foreground !== "string" ||
    !FOREGROUND_STATES.has(value.foreground) ||
    (value.foreground !== "running" &&
      !(
        value.live_owner_recovery === null ||
        (typeof value.live_owner_recovery === "string" &&
          RECEIPT_SHA.test(value.live_owner_recovery))
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery === undefined ||
        value.dead_owner_recovery === null ||
        (typeof value.dead_owner_recovery === "string" &&
          RECEIPT_SHA.test(value.dead_owner_recovery))
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery_complete === undefined ||
        typeof value.dead_owner_recovery_complete === "boolean"
      )) ||
    (value.foreground !== "running" &&
      !(
        value.dead_owner_recovery_error === undefined ||
        value.dead_owner_recovery_error === null ||
        (typeof value.dead_owner_recovery_error === "string" &&
          RECOVERY_CODE.test(value.dead_owner_recovery_error))
      ))
  ) {
    return;
  }
  return {
    phase: value.phase,
    failedStartRecoverable: value.failed_start_recoverable === true,
    crossBootStart: value.cross_boot_start === true,
    crossBootRelay: value.cross_boot_relay !== false,
    lostRemovalPending: value.lost_removal_pending === true,
    receiptSha256: value.receipt_sha256,
    foreground:
      value.foreground as NativeForegroundOwnerSelection["foreground"],
    liveOwnerRecovery:
      value.foreground !== "running" &&
      typeof value.live_owner_recovery === "string"
        ? value.live_owner_recovery
        : null,
    deadOwnerRecovery:
      value.foreground !== "running" &&
      typeof value.dead_owner_recovery === "string"
        ? value.dead_owner_recovery
        : null,
    deadOwnerRecoveryComplete:
      value.foreground !== "running" &&
      value.dead_owner_recovery_complete === true,
    deadOwnerRecoveryError:
      value.foreground !== "running" &&
      typeof value.dead_owner_recovery_error === "string"
        ? value.dead_owner_recovery_error
        : null,
  };
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}
