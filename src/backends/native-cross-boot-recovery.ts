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
 * The phase of a stop its owner left inside its enrolled relay cleanup when
 * its VM was lost (HACK-2746: Ctrl-C, then the provider killed). The runtime's
 * cross-boot recovery finishes it once the pool boots again, when
 * `graph foreground-owner` reports `cross_boot_stop`: a pending relay cleanup
 * marker of a boot that has ended (never the boot of a pool still running,
 * HACK-2757), the bridge selection that stop persisted, and a relay owner the
 * recovery can prove from them.
 */
export const NATIVE_CROSS_BOOT_STOP_PHASE = "cleanup-intent";

/**
 * Whether the cross-boot recovery admits a receipt as `graph foreground-owner`
 * reported it: a live phase whose dead relay owner the runtime can prove
 * (`cross_boot_relay`: the run holds a bridge slot, or its relay startup
 * settled; a run with no published port and an unsettled relay startup is
 * refused with `relay_owner_refused`, HACK-2731), a lost start the runtime
 * itself admits, or a stop interrupted inside its enrolled relay cleanup
 * (`cross_boot_stop`, HACK-2746). A pending same-boot recovery
 * (`live_owner_recovery`) resumes only in its own boot, so it is never one.
 * Whether the owner exited is the caller's check.
 */
export function nativeCrossBootRecoverable(selection: {
  readonly phase: string;
  readonly crossBootStart: boolean;
  readonly crossBootRelay: boolean;
  readonly crossBootStop: boolean;
  readonly liveOwnerRecovery: string | null;
}): boolean {
  return (
    selection.liveOwnerRecovery === null &&
    ((NATIVE_RECOVERABLE_LIVE_PHASES.has(selection.phase) &&
      selection.crossBootRelay) ||
      (NATIVE_CROSS_BOOT_START_PHASES.has(selection.phase) &&
        selection.crossBootStart) ||
      (selection.phase === NATIVE_CROSS_BOOT_STOP_PHASE &&
        selection.crossBootStop))
  );
}

/**
 * Whether a run lost once ready is retired by `hack down --recover`, as the
 * selection read once its VM was lost shows (HACK-2731, HACK-2746). A live
 * receipt is, unless the runtime cannot prove its relay owner
 * (`nativeLiveRelayUnprovable`). A stop its owner left at `cleanup-intent`
 * (Ctrl-C, then the VM lost) is only with `cross_boot_stop`, or once a
 * dead-owner recovery of it is selected; the runtime refuses any other one.
 * Any other phase (`stopped-data-retained` after a completed stop, a pending
 * same-boot recovery) keeps the down advice, whose own paths handle it.
 */
export function nativeReadyLossRetirable(
  selection: NativeReadyLossSelection
): boolean {
  return nativeReadyLossWithheld(selection) === undefined;
}

/** The selection fields a ready-stage loss reads. */
type NativeReadyLossSelection = Pick<
  NativeForegroundOwnerSelection,
  | "phase"
  | "crossBootRelay"
  | "crossBootStop"
  | "crossBootStopReported"
  | "deadOwnerRecovery"
>;

/**
 * Why a run lost once ready is not retired by `hack down --recover`, so its
 * message names the real reason (HACK-2757):
 * - `relay`: a live receipt whose relay owner the runtime cannot prove (no
 *   published port and an unsettled relay startup, HACK-2731).
 * - `stop`: a stop interrupted at `cleanup-intent` that the runtime reports
 *   it cannot finish across the boot (`cross_boot_stop` false: its relay
 *   cleanup marker names no ended boot of this pool, or the bridge selection
 *   the stop saved is missing or is not one the recovery accepts).
 * - `stop-unreported`: the same receipt from a runtime too old to report
 *   `cross_boot_stop`, which never finished one.
 * Undefined when the down retires it.
 */
export type NativeReadyLossWithheld = "relay" | "stop" | "stop-unreported";

export function nativeReadyLossWithheld(
  selection: NativeReadyLossSelection
): NativeReadyLossWithheld | undefined {
  if (selection.phase === NATIVE_CROSS_BOOT_STOP_PHASE) {
    if (selection.crossBootStop || selection.deadOwnerRecovery !== null) {
      return;
    }
    return selection.crossBootStopReported ? "stop" : "stop-unreported";
  }
  return nativeLiveRelayUnprovable(selection) ? "relay" : undefined;
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
   * That recovery finishes a stop its owner left inside its enrolled relay
   * cleanup (`cross_boot_stop`, HACK-2746). Absent from an older runtime,
   * which never finished one: false.
   */
  readonly crossBootStop: boolean;
  /** Whether the runtime reported `cross_boot_stop` at all (older ones do not). */
  readonly crossBootStopReported: boolean;
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
    !optionalBoolean(value.cross_boot_stop) ||
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
    crossBootStop: value.cross_boot_stop === true,
    crossBootStopReported: typeof value.cross_boot_stop === "boolean",
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
