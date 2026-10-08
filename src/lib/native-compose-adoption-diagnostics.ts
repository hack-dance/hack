/** Fixed categories describe the rejecting boundary, never private input or daemon output. */
export type LegacyComposeOrderedRefusal =
  | {
      readonly stage: "ordered-observation";
      readonly reason:
        | "shape"
        | "timestamp"
        | "restart-policy"
        | "membership"
        | "probe";
    }
  | {
      readonly stage: "ordered-scheduler";
      readonly reason:
        | "selection"
        | "deadline"
        | "prior-attempt"
        | "missing-attempt"
        | "job-failed"
        | "job-refused"
        | "readiness"
        | "completion-authority";
    };

const issued = new WeakMap<object, LegacyComposeOrderedRefusal>();
type ObservationReason = Extract<
  LegacyComposeOrderedRefusal,
  { stage: "ordered-observation" }
>["reason"];
type SchedulerReason = Extract<
  LegacyComposeOrderedRefusal,
  { stage: "ordered-scheduler" }
>["reason"];

function observationReason(value: unknown): value is ObservationReason {
  return ["shape", "timestamp", "restart-policy", "membership", "probe"].some(
    (reason) => value === reason
  );
}
function schedulerReason(value: unknown): value is SchedulerReason {
  return [
    "selection",
    "deadline",
    "prior-attempt",
    "missing-attempt",
    "job-failed",
    "job-refused",
    "readiness",
    "completion-authority",
  ].some((reason) => value === reason);
}

function diagnosticRefused(): never {
  throw new Error("Legacy adoption diagnostic refused; values omitted.");
}

/** The weak association ignores arbitrary error properties, getters, prototypes and copied detail. */
export function legacyComposeOrderedRefusal(
  error: unknown
): LegacyComposeOrderedRefusal | undefined {
  return typeof error === "object" && error !== null
    ? issued.get(error)
    : undefined;
}

/** Only allowlisted stage/reason pairs may reach the public error envelope. No execution authority is issued. */
export function attachLegacyComposeOrderedRefusal(
  error: Error,
  diagnostic: unknown
): void {
  if (
    typeof diagnostic !== "object" ||
    diagnostic === null ||
    Reflect.ownKeys(diagnostic).length !== 2
  ) {
    diagnosticRefused();
  }
  const descriptors = Object.getOwnPropertyDescriptors(diagnostic);
  const stageDescriptor = descriptors.stage;
  const reasonDescriptor = descriptors.reason;
  if (
    !(
      stageDescriptor &&
      reasonDescriptor &&
      Object.hasOwn(descriptors, "stage") &&
      Object.hasOwn(descriptors, "reason") &&
      Object.hasOwn(stageDescriptor, "value") &&
      Object.hasOwn(reasonDescriptor, "value")
    )
  ) {
    diagnosticRefused();
  }
  const stage: unknown = stageDescriptor.value;
  const reason: unknown = reasonDescriptor.value;
  if (stage === "ordered-observation" && observationReason(reason)) {
    issued.set(error, Object.freeze({ stage, reason }));
    return;
  }
  if (stage === "ordered-scheduler" && schedulerReason(reason)) {
    issued.set(error, Object.freeze({ stage, reason }));
    return;
  }
  diagnosticRefused();
}

export function legacyComposeOrderedError(opts: {
  readonly diagnostic: LegacyComposeOrderedRefusal;
  readonly message: string;
}): Error {
  const error = new Error(opts.message);
  attachLegacyComposeOrderedRefusal(error, opts.diagnostic);
  return error;
}
