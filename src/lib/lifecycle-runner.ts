export type LifecycleRunner = "mux" | "supervisor";

export const LIFECYCLE_RUNNER_CONFIG_ERROR =
  'Invalid lifecycle.runner; expected "mux" or "supervisor". Values omitted.';

/** Validate without coercion: a misspelled runner must never launch another one. */
export function parseLifecycleRunner(value: unknown): LifecycleRunner | null {
  return value === "mux" || value === "supervisor" ? value : null;
}

/** Explicit test/runtime overrides precede project config; omission keeps mux. */
export function resolveLifecycleRunner(opts: {
  readonly runner?: unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): LifecycleRunner {
  const env = opts.env ?? process.env;
  const override = env.HACK_LIFECYCLE_RUNNER;
  if (override !== undefined) {
    const runner = parseLifecycleRunner(override);
    if (!runner) {
      throw new Error(
        'Invalid HACK_LIFECYCLE_RUNNER; expected "mux" or "supervisor". Values omitted.'
      );
    }
    return runner;
  }
  if (opts.runner === undefined) {
    return "mux";
  }
  const runner = parseLifecycleRunner(opts.runner);
  if (!runner) {
    throw new Error(LIFECYCLE_RUNNER_CONFIG_ERROR);
  }
  return runner;
}
