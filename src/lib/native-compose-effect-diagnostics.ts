import {
  NativeComposeOwnershipError,
  nativeComposeProbeFailure,
} from "./native-compose-ownership.ts";
import { NativeComposeGenerationError } from "./native-compose-private-state.ts";

/** Fixed first failing owner boundary, never execution/recovery authority or an error-text channel. */
export type NativeComposeEffectRefusal = {
  readonly stage:
    | "effect-boundary"
    | "effect-receipt"
    | "effect-admission"
    | "effect-prepublication"
    | "effect-intent"
    | "effect-entry"
    | "effect-source"
    | "effect-projection"
    | "effect-freshness"
    | "effect-witness"
    | "effect-ownership"
    | "effect-storage-observation"
    | "effect-execution"
    | "effect-finalization"
    | "storage-enrollment"
    | "storage-selection"
    | "storage-cold-absence"
    | "storage-dependency"
    | "storage-expectation-admission"
    | "storage-expectation-write"
    | "storage-journal"
    | "storage-enrollment-read"
    | "storage-provision"
    | "storage-root"
    | "storage-seed"
    | "storage-verify"
    | "storage-root-after"
    | "storage-completion-write"
    | "storage-publication"
    | "storage-target"
    | "storage-helper-create"
    | "storage-helper-policy"
    | "storage-helper-start"
    | "storage-helper-response"
    | "storage-helper-cleanup"
    | "workload-execution"
    | "guard-fresh-before"
    | "guard-ownership"
    | "guard-storage"
    | "guard-fresh-after"
    | "compose-child"
    | "compose-readiness"
    | "compose-file-readiness"
    | "vm-file-readiness"
    | "vm-retirement-admission"
    | "vm-retirement-observation"
    | "vm-retirement-observer-stop"
    | "vm-retirement-observer-removal"
    | "vm-retirement-volume-policy"
    | "vm-retirement-volume-removal"
    | "compose-routing-readiness";
  readonly reason:
    | "private-state"
    | "private-busy"
    | "private-uncertain"
    | "private-stale"
    | "resource-ownership"
    | "network-transition"
    | "probe-operation"
    | "probe-child"
    | "probe-timeout"
    | "probe-cancel"
    | "probe-budget"
    | "probe-capture"
    | "probe-decode"
    | "probe-unclassified"
    | "helper-shape"
    | "helper-command"
    | "helper-labels"
    | "helper-host-policy"
    | "helper-mount-cardinality"
    | "helper-program-mount"
    | "helper-storage-request"
    | "helper-storage-identity"
    | "helper-storage-mount"
    | "helper-policy-stability"
    | "unclassified";
};

const issued = new WeakMap<object, NativeComposeEffectRefusal>();
const stages: readonly NativeComposeEffectRefusal["stage"][] = [
  "effect-boundary",
  "effect-receipt",
  "effect-admission",
  "effect-prepublication",
  "effect-intent",
  "effect-entry",
  "effect-source",
  "effect-projection",
  "effect-freshness",
  "effect-witness",
  "effect-ownership",
  "effect-storage-observation",
  "effect-execution",
  "effect-finalization",
  "storage-enrollment",
  "storage-selection",
  "storage-cold-absence",
  "storage-dependency",
  "storage-expectation-admission",
  "storage-expectation-write",
  "storage-journal",
  "storage-enrollment-read",
  "storage-provision",
  "storage-root",
  "storage-seed",
  "storage-verify",
  "storage-root-after",
  "storage-completion-write",
  "storage-publication",
  "storage-target",
  "storage-helper-create",
  "storage-helper-policy",
  "storage-helper-start",
  "storage-helper-response",
  "storage-helper-cleanup",
  "workload-execution",
  "guard-fresh-before",
  "guard-ownership",
  "guard-storage",
  "guard-fresh-after",
  "compose-child",
  "compose-readiness",
  "compose-file-readiness",
  "vm-file-readiness",
  "vm-retirement-admission",
  "vm-retirement-observation",
  "vm-retirement-observer-stop",
  "vm-retirement-observer-removal",
  "vm-retirement-volume-policy",
  "vm-retirement-volume-removal",
  "compose-routing-readiness",
];
const reasons: readonly NativeComposeEffectRefusal["reason"][] = [
  "private-state",
  "private-busy",
  "private-uncertain",
  "private-stale",
  "resource-ownership",
  "network-transition",
  "probe-operation",
  "probe-child",
  "probe-timeout",
  "probe-cancel",
  "probe-budget",
  "probe-capture",
  "probe-decode",
  "probe-unclassified",
  "helper-shape",
  "helper-command",
  "helper-labels",
  "helper-host-policy",
  "helper-mount-cardinality",
  "helper-program-mount",
  "helper-storage-request",
  "helper-storage-identity",
  "helper-storage-mount",
  "helper-policy-stability",
  "unclassified",
];

/** Ignores error properties, getters, prototypes and copied public detail. */
export function nativeComposeEffectRefusal(
  error: unknown
): NativeComposeEffectRefusal | undefined {
  return typeof error === "object" && error !== null
    ? issued.get(error)
    : undefined;
}

/** Accepts only closed data fields; it never retains the error message or cause. */
export function attachNativeComposeEffectRefusal(
  error: object,
  diagnostic: unknown
): void {
  if (
    typeof diagnostic === "object" &&
    diagnostic !== null &&
    Reflect.ownKeys(diagnostic).length === 2
  ) {
    const descriptors = Object.getOwnPropertyDescriptors(diagnostic);
    const stage = descriptors.stage;
    const reason = descriptors.reason;
    if (
      stage &&
      reason &&
      Object.hasOwn(descriptors, "stage") &&
      Object.hasOwn(descriptors, "reason") &&
      Object.hasOwn(stage, "value") &&
      Object.hasOwn(reason, "value")
    ) {
      const selectedStage = stages.find((value) => value === stage.value);
      const selectedReason = reasons.find((value) => value === reason.value);
      if (selectedStage && selectedReason) {
        if (issued.has(error)) {
          return;
        }
        issued.set(
          error,
          Object.freeze({ stage: selectedStage, reason: selectedReason })
        );
        return;
      }
    }
  }
  throw new Error("Native Compose effect diagnostic refused; values omitted.");
}

/** Diagnostic failure cannot replace the original rejection, including primitive throws. */
export function retainNativeComposeEffectRefusal(
  error: unknown,
  diagnostic: NativeComposeEffectRefusal
): void {
  try {
    if (typeof error === "object" && error !== null) {
      attachNativeComposeEffectRefusal(error, diagnostic);
    }
  } catch {
    // Preserve the original error and its lifetime; diagnostic publication is optional.
  }
}

/** Classify only a trusted error class's own closed data property; never invoke error getters. */
export function nativeComposeEffectReason(
  error: unknown
): NativeComposeEffectRefusal["reason"] {
  try {
    const code =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (code && Object.hasOwn(code, "value")) {
      if (error instanceof NativeComposeGenerationError) {
        switch (code.value) {
          case "E_NATIVE_COMPOSE_STATE":
            return "private-state";
          case "E_NATIVE_COMPOSE_BUSY":
            return "private-busy";
          case "E_NATIVE_COMPOSE_UNCERTAIN":
            return "private-uncertain";
          case "E_NATIVE_COMPOSE_STALE":
            return "private-stale";
          default:
            break;
        }
      }
      if (error instanceof NativeComposeOwnershipError) {
        const failure = nativeComposeProbeFailure(error);
        if (failure) {
          return `probe-${failure}`;
        }
        switch (code.value) {
          case "E_NATIVE_COMPOSE_OWNERSHIP":
            return "resource-ownership";
          case "E_NATIVE_COMPOSE_NETWORK_TRANSITION":
            return "network-transition";
          case "E_NATIVE_COMPOSE_PROBE_TIMEOUT":
            return "probe-timeout";
          case "E_NATIVE_COMPOSE_PROBE_CANCELLED":
            return "probe-cancel";
          case "E_NATIVE_COMPOSE_PROBE_BUDGET":
            return "probe-budget";
          case "E_NATIVE_COMPOSE_PROBE":
            return "probe-unclassified";
          default:
            break;
        }
      }
    }
  } catch {
    /* Optional diagnostics cannot replace the original rejection. */
  }
  return "unclassified";
}

/** Keep the original issued boundary through a deliberate fixed-code translation. */
export function copyNativeComposeEffectRefusal(
  source: unknown,
  target: object
): void {
  try {
    const diagnostic = nativeComposeEffectRefusal(source);
    if (diagnostic) {
      retainNativeComposeEffectRefusal(target, diagnostic);
    }
  } catch {
    /* Preserve primary/cleanup failure precedence. */
  }
}
