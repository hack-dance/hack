/**
 * Shared closed-refusal registry. Each owner module keeps a private WeakMap from
 * a rejected error to a fixed `{ stage, reason }` pair drawn from closed lists.
 * A diagnostic confers no recovery or execution authority and never retains
 * error text, causes, getters or copied public detail.
 */
export type ClosedRefusal<Stage extends string, Reason extends string> = {
  readonly stage: Stage;
  readonly reason: Reason;
};

export type ClosedRefusalRegistry<
  Stage extends string,
  Reason extends string,
> = {
  /** Ignores error properties, getters, prototypes and copied public detail. */
  readonly lookup: (error: unknown) => ClosedRefusal<Stage, Reason> | undefined;
  /**
   * Accepts only closed data fields; it never retains the error message or cause.
   * Throws the registry's fixed message when the diagnostic is not a closed pair.
   */
  readonly attach: (error: object, diagnostic: unknown) => void;
  /** Diagnostic failure cannot replace the original rejection, including primitive throws. */
  readonly retain: (
    error: unknown,
    diagnostic: ClosedRefusal<Stage, Reason>
  ) => void;
};

export function createClosedRefusalRegistry<
  Stage extends string,
  Reason extends string,
>(opts: {
  readonly stages: readonly Stage[];
  readonly reasons: readonly Reason[];
  /** Keep an already issued refusal (first failing boundary) instead of overwriting it. */
  readonly firstWins: boolean;
  /** Fixed message label; it is never derived from a diagnostic value. */
  readonly label: string;
}): ClosedRefusalRegistry<Stage, Reason> {
  const issued = new WeakMap<object, ClosedRefusal<Stage, Reason>>();
  const { stages, reasons, firstWins } = opts;
  const message = `${opts.label} refused; values omitted.`;

  const lookup = (error: unknown): ClosedRefusal<Stage, Reason> | undefined =>
    typeof error === "object" && error !== null ? issued.get(error) : undefined;

  const attach = (error: object, diagnostic: unknown): void => {
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
          if (firstWins && issued.has(error)) {
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
    throw new Error(message);
  };

  const retain = (
    error: unknown,
    diagnostic: ClosedRefusal<Stage, Reason>
  ): void => {
    try {
      if (typeof error === "object" && error !== null) {
        attach(error, diagnostic);
      }
    } catch {
      // Preserve the original error and its lifetime; diagnostic publication is optional.
    }
  };

  return { lookup, attach, retain };
}
