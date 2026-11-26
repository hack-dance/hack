import { isRecord } from "../lib/guards.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  nativeAuthoredReceiptBinding,
  parseNativeAuthoredReceipt,
  parseNativeAuthoredReview,
} from "./native-authored-graph-protocol.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type RecoverySelectionFields = {
  readonly kind: "native-graph-recovery-selection";
  readonly run: string;
  readonly receipt: NativeAuthoredReceipt;
  readonly receipt_sha256: string;
  readonly owner_sha256: string;
  /**
   * Present (`true`) only when the receipt belongs to a pool boot that ended
   * under it (HACK-2715): the runtime then admits a start caught mid-way,
   * whose pending effects ended with that boot's guest.
   */
  readonly ended_boot?: true;
};
export type NativeAuthoredRecoverySelection = RecoverySelectionFields &
  (
    | { readonly version: 1; readonly host_boot_micros: number }
    | { readonly version: 2; readonly host_boot_uuid: string }
  );
export type NativeAuthoredRecoveryResult = {
  readonly version: 1;
  readonly kind: "native-graph-live-owner-recovered";
  readonly run: string;
  /**
   * Whether the run belonged to the current pool boot. `false` when it was
   * recovered from a boot that ended under it (`runtime down --force`, a crash
   * or a host reboot, HACK-2715). `null` in a resumed frontend recovery whose
   * runtime cleanup completed in an earlier attempt.
   */
  readonly same_boot: boolean | null;
  readonly publication_retired: true;
  readonly receipt: NativeAuthoredReceipt;
};
function refused(): never {
  throw new Error(
    "Native recovery response is invalid or changed; values omitted."
  );
}
function fields(
  value: unknown,
  names: readonly string[]
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    names.every((name) => Object.hasOwn(value, name)) &&
    Object.keys(value).length === names.length
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}
function settled(value: unknown): NativeAuthoredReceipt {
  const receipt = parseNativeAuthoredReceipt(value);
  if (
    !(
      receipt.version === 2 ||
      (receipt.version === 4 &&
        receipt.data_tool?.root !== null &&
        receipt.data_tool?.root !== undefined &&
        receipt.data_tool.helper !== null &&
        Object.values(receipt.data ?? {}).every(
          (reference) => reference.state.status === "enrolled"
        ))
    ) ||
    receipt.phase === "preparing" ||
    (receipt.phase === "ready-observed" && receipt.failure !== undefined) ||
    Object.values(receipt.resources).some((resource) => {
      if (receipt.phase === "removed" && resource.phase !== "removed") {
        return true;
      }
      if (resource.id === null) {
        return resource.phase !== "reserved" && resource.phase !== "removed";
      }
      return !(
        resource.kind === "container"
          ? ["created", "started", "stopped", "removed"]
          : ["created", "remove-intent", "removed"]
      ).includes(resource.phase);
    })
  ) {
    return refused();
  }
  return receipt;
}
/**
 * A receipt of an ended pool boot that the runtime's cleanup from that boot
 * admits (HACK-2715): a graph2 receipt in any phase, including a start caught
 * mid-way. The runtime re-checks the boot, the owner and each member before any
 * effect; this copy only binds what it selected.
 */
function endedBootSettled(value: unknown): NativeAuthoredReceipt {
  const receipt = parseNativeAuthoredReceipt(value);
  if (
    receipt.version !== 2 ||
    (receipt.phase === "removed" &&
      Object.values(receipt.resources).some(
        (resource) => resource.phase !== "removed"
      ))
  ) {
    return refused();
  }
  return receipt;
}
function ready(value: unknown): NativeAuthoredReceipt {
  const receipt = settled(value);
  if (
    receipt.phase !== "ready-observed" ||
    receipt.failure !== undefined ||
    Object.values(receipt.resources).some((resource) => resource.id === null)
  ) {
    return refused();
  }
  return receipt;
}

/**
 * Whether a selection carries the runtime's ended-boot marker (HACK-2715). The
 * marker is present only as `true`; any other value refuses.
 */
function endedBootMarker(value: unknown): boolean {
  if (!(isRecord(value) && Object.hasOwn(value, "ended_boot"))) {
    return false;
  }
  return value.ended_boot === true ? true : refused();
}
/** The exact own fields of a selection with this qualifier and marker. */
function selectionFields(qualifier: string, endedBoot: boolean): string[] {
  const names = [
    "version",
    "kind",
    "run",
    "receipt",
    "receipt_sha256",
    "owner_sha256",
    qualifier,
  ];
  return endedBoot ? [...names, "ended_boot"] : names;
}
/**
 * The selected receipt's admission rule. A readied run of an ended boot may
 * have recorded a failure since Ready, or be caught in its own stop; its
 * binding to the admitted Ready is still checked by the caller.
 */
function selectedReceipt(
  value: unknown,
  opts: { readonly endedBoot: boolean; readonly admitted: boolean }
): NativeAuthoredReceipt {
  if (opts.endedBoot) {
    return endedBootSettled(value);
  }
  return opts.admitted ? ready(value) : settled(value);
}

/** Raw selectors belong to Rust's secure reader. This copied, closed envelope
 * binds the original durable frontend Ready membership; it grants no effects. */
export function parseNativeAuthoredRecoverySelection(
  opts: {
    readonly value: unknown;
  } & (
    | { readonly admitted: NativeAuthoredReceipt }
    | { readonly start: NativeAuthoredReview }
  )
): NativeAuthoredRecoverySelection {
  const admitted = "admitted" in opts ? ready(opts.admitted) : undefined;
  const review =
    admitted?.review ??
    ("start" in opts ? parseNativeAuthoredReview(opts.start) : refused());
  const value = opts.value;
  const qualifier =
    isRecord(value) && Object.hasOwn(value, "host_boot_uuid")
      ? "host_boot_uuid"
      : "host_boot_micros";
  const endedBoot = endedBootMarker(value);
  if (
    !fields(value, selectionFields(qualifier, endedBoot)) ||
    (value.version !== 1 && value.version !== 2) ||
    value.kind !== "native-graph-recovery-selection" ||
    value.run !== review.provenance.run ||
    !hash(value.receipt_sha256) ||
    !hash(value.owner_sha256)
  ) {
    return refused();
  }
  const receipt = selectedReceipt(value.receipt, {
    endedBoot,
    admitted: admitted !== undefined,
  });
  if (
    JSON.stringify(receipt.review) !== JSON.stringify(review) ||
    (admitted &&
      nativeAuthoredReceiptBinding(receipt) !==
        nativeAuthoredReceiptBinding(admitted))
  ) {
    return refused();
  }
  const common: RecoverySelectionFields = {
    kind: "native-graph-recovery-selection",
    run: value.run,
    receipt,
    receipt_sha256: value.receipt_sha256,
    owner_sha256: value.owner_sha256,
    ...(endedBoot ? { ended_boot: true as const } : {}),
  };
  if (value.version === 1) {
    if (
      typeof value.host_boot_micros !== "number" ||
      !Number.isSafeInteger(value.host_boot_micros) ||
      value.host_boot_micros <= 0
    ) {
      return refused();
    }
    return { ...common, version: 1, host_boot_micros: value.host_boot_micros };
  }
  if (
    typeof value.host_boot_uuid !== "string" ||
    value.host_boot_uuid.length !== 36 ||
    !UUID.test(value.host_boot_uuid) ||
    value.host_boot_uuid === "00000000-0000-0000-0000-000000000000"
  ) {
    return refused();
  }
  return { ...common, version: 2, host_boot_uuid: value.host_boot_uuid };
}

/** Matching Removed is a cleanup result, not frontend retirement authority.
 * The caller must also inspect current null observations and retain its leases. */
export function parseNativeAuthoredRecoveryResult(opts: {
  readonly value: unknown;
  readonly expected: NativeAuthoredRecoverySelection;
}): NativeAuthoredRecoveryResult {
  const expected = parseNativeAuthoredRecoverySelection({
    value: opts.expected,
    start: opts.expected.receipt.review,
  });
  const value = opts.value;
  if (
    !fields(value, [
      "version",
      "kind",
      "run",
      "same_boot",
      "publication_retired",
      "receipt",
    ]) ||
    value.version !== 1 ||
    value.kind !== "native-graph-live-owner-recovered" ||
    value.run !== expected.run ||
    typeof value.same_boot !== "boolean" ||
    value.publication_retired !== true
  ) {
    return refused();
  }
  const receipt = parseNativeAuthoredReceipt(value.receipt);
  if (
    receipt.phase !== "removed" ||
    nativeAuthoredReceiptBinding(receipt) !==
      nativeAuthoredReceiptBinding(expected.receipt)
  ) {
    return refused();
  }
  return {
    version: 1,
    kind: "native-graph-live-owner-recovered",
    run: expected.run,
    same_boot: value.same_boot === true,
    publication_retired: true,
    receipt,
  };
}
