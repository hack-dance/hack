import type { TlaExpectation, TlaViolation } from "./supervisor-tla-result.ts";

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
    module: "tests/models/tla/supervisor-job/SupervisorJob.tla",
    baseline: {
      config: `tests/models/tla/supervisor-job/${id}.cfg`,
      expected: id === "P5" ? { kind: "pass" } : violation,
    },
    ...(id === "P5"
      ? {}
      : {
          reference: {
            config: `tests/models/tla/supervisor-job/reference/${id}.cfg`,
            expected: { kind: "pass" as const },
          },
        }),
    ...(id === "P4"
      ? {
          controls: [
            {
              config:
                "tests/models/tla/supervisor-job/reference/P4SuccessfulIO.cfg",
              expected: { kind: "pass" as const },
            },
          ],
        }
      : {}),
    mutation: {
      config: `tests/models/tla/supervisor-job/mutations/${id}.cfg`,
      expected: violation,
    },
  };
});
