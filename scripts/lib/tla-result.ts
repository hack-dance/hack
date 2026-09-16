const COMPLETED = /Model checking completed\. No error has been found\./;
const POSITIVE_STATES = /5 distinct states found, 0 states left on queue/;
const CAPACITY_VIOLATION = /Invariant Capacity is violated\./;
const OVERCOMMIT = /used = \{1, 2\}/;

export function verifyAdmissionModelResult(opts: {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}): boolean {
  if (opts.negative) {
    return (
      opts.exitCode === 12 &&
      CAPACITY_VIOLATION.test(opts.output) &&
      OVERCOMMIT.test(opts.output)
    );
  }
  return (
    opts.exitCode === 0 &&
    COMPLETED.test(opts.output) &&
    POSITIVE_STATES.test(opts.output)
  );
}
