import { createClosedRefusalRegistry } from "./closed-refusal-registry.ts";

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

/** Latest attach overwrites: publication reports the last boundary it reached. */
const registry = createClosedRefusalRegistry<
  LegacyComposePublicationRefusal["stage"],
  LegacyComposePublicationRefusal["reason"]
>({
  stages,
  reasons,
  firstWins: false,
  label: "Legacy publication diagnostic",
});

/** Ignores error properties, getters, prototypes and copied public detail. */
export function legacyComposePublicationRefusal(
  error: unknown
): LegacyComposePublicationRefusal | undefined {
  return registry.lookup(error);
}

/** Accepts only closed data fields; it never retains the error message or cause. */
export function attachLegacyComposePublicationRefusal(
  error: object,
  diagnostic: unknown
): void {
  registry.attach(error, diagnostic);
}

/** Diagnostic failure cannot replace the original rejection, including primitive throws. */
export function retainLegacyComposePublicationRefusal(
  error: unknown,
  diagnostic: LegacyComposePublicationRefusal
): void {
  registry.retain(error, diagnostic);
}
