/** Fixed owner-issued boundaries. A diagnostic confers no recovery or execution authority. */
export type LegacyComposePublicationRefusal = {
  readonly stage:
    | "publication-state"
    | "publication-inputs"
    | "publication-layout"
    | "publication-compiler"
    | "publication-stopped"
    | "publication-routing"
    | "publication-originals-directory"
    | "publication-hold-original"
    | "publication-install-native"
    | "publication-sync"
    | "publication-save-native"
    | "publication-finish-native"
    | "publication-active-candidate"
    | "publication-final-inputs"
    | "publication-final-stopped"
    | "publication-final-directories"
    | "publication-save-active"
    | "publication-save-active-context"
    | "publication-save-active-previous"
    | "publication-save-active-staging"
    | "publication-save-active-staged-context"
    | "publication-save-active-latest"
    | "publication-save-active-routing"
    | "publication-save-active-receipt"
    | "publication-save-active-rename"
    | "publication-save-active-sync"
    | "publication-save-active-published"
    | "publication-save-active-final-context"
    | "publication-save-active-decode"
    | "publication-close-originals";
  readonly reason:
    | "legacy-state"
    | "legacy-busy"
    | "legacy-changed"
    | "legacy-unsupported"
    | "legacy-cancelled"
    | "private-state"
    | "private-busy"
    | "private-uncertain"
    | "private-stale"
    | "compiler-transport"
    | "proof-deadline"
    | "unclassified";
};

const issued = new WeakMap<object, LegacyComposePublicationRefusal>();
const stages: readonly LegacyComposePublicationRefusal["stage"][] = [
  "publication-state",
  "publication-inputs",
  "publication-layout",
  "publication-compiler",
  "publication-stopped",
  "publication-routing",
  "publication-originals-directory",
  "publication-hold-original",
  "publication-install-native",
  "publication-sync",
  "publication-save-native",
  "publication-finish-native",
  "publication-active-candidate",
  "publication-final-inputs",
  "publication-final-stopped",
  "publication-final-directories",
  "publication-save-active",
  "publication-save-active-context",
  "publication-save-active-previous",
  "publication-save-active-staging",
  "publication-save-active-staged-context",
  "publication-save-active-latest",
  "publication-save-active-routing",
  "publication-save-active-receipt",
  "publication-save-active-rename",
  "publication-save-active-sync",
  "publication-save-active-published",
  "publication-save-active-final-context",
  "publication-save-active-decode",
  "publication-close-originals",
];
const reasons: readonly LegacyComposePublicationRefusal["reason"][] = [
  "legacy-state",
  "legacy-busy",
  "legacy-changed",
  "legacy-unsupported",
  "legacy-cancelled",
  "private-state",
  "private-busy",
  "private-uncertain",
  "private-stale",
  "compiler-transport",
  "proof-deadline",
  "unclassified",
];

/** Ignores error properties, getters, prototypes and copied public detail. */
export function legacyComposePublicationRefusal(
  error: unknown
): LegacyComposePublicationRefusal | undefined {
  return typeof error === "object" && error !== null
    ? issued.get(error)
    : undefined;
}

/** Accepts only closed data fields; it never retains the error message or cause. */
export function attachLegacyComposePublicationRefusal(
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
        issued.set(
          error,
          Object.freeze({ stage: selectedStage, reason: selectedReason })
        );
        return;
      }
    }
  }
  throw new Error("Legacy publication diagnostic refused; values omitted.");
}

/** Diagnostic failure cannot replace the original rejection, including primitive throws. */
export function retainLegacyComposePublicationRefusal(
  error: unknown,
  diagnostic: LegacyComposePublicationRefusal
): void {
  try {
    if (typeof error === "object" && error !== null) {
      attachLegacyComposePublicationRefusal(error, diagnostic);
    }
  } catch {
    // Preserve the original error and its lifetime; diagnostic publication is optional.
  }
}
