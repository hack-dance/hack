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
  readonly same_boot: true;
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
  if (
    !fields(value, [
      "version",
      "kind",
      "run",
      "receipt",
      "receipt_sha256",
      "owner_sha256",
      qualifier,
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    value.kind !== "native-graph-recovery-selection" ||
    value.run !== review.provenance.run ||
    !hash(value.receipt_sha256) ||
    !hash(value.owner_sha256)
  ) {
    return refused();
  }
  const receipt = admitted ? ready(value.receipt) : settled(value.receipt);
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
    value.same_boot !== true ||
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
    same_boot: true,
    publication_retired: true,
    receipt,
  };
}
