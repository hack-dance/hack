import type { TlaExpectation, TlaViolation } from "./tla-result.ts";

export type TlaCheck = {
  readonly id: string;
  readonly module: string;
  readonly baseline: {
    readonly config: string;
    readonly expected: TlaExpectation;
  };
  readonly reference?: {
    readonly config: string;
    readonly expected: { readonly kind: "pass" };
  };
  readonly controls?: readonly {
    readonly config: string;
    readonly expected: { readonly kind: "pass" };
  }[];
  readonly mutation: {
    readonly config: string;
    readonly expected: TlaViolation;
  };
};

/** Paths are repository-relative. Each config enables exactly one named check. */
export const CHECKS: readonly TlaCheck[] = [
  { id: "P1", property: "SingleRunner", kind: "invariant" },
  { id: "P2", property: "CancelQuiescent", kind: "invariant" },
  { id: "P3", property: "RetryIdempotent", kind: "invariant" },
  { id: "P4", property: "ClaimedTerminal", kind: "temporal" },
  { id: "P5", property: "CancelWins", kind: "invariant" },
].map(({ id, property, kind }): TlaCheck => {
  const violation: TlaViolation = {
    kind: kind === "temporal" ? "temporal" : "invariant",
    property,
  };
  return {
    id,
    module: "specs/tla/SupervisorJob.tla",
    baseline: {
      config: `specs/tla/${id}.cfg`,
      expected: id === "P5" ? { kind: "pass" } : violation,
    },
    ...(id === "P5"
      ? {}
      : {
          reference: {
            config: `specs/tla/reference/${id}.cfg`,
            expected: { kind: "pass" as const },
          },
        }),
    ...(id === "P4"
      ? {
          controls: [
            {
              config: "specs/tla/reference/P4SuccessfulIO.cfg",
              expected: { kind: "pass" as const },
            },
          ],
        }
      : {}),
    mutation: { config: `specs/tla/mutations/${id}.cfg`, expected: violation },
  };
});
