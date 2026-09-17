const COMPLETED = /Model checking completed\. No error has been found\./;
const POSITIVE_STATES = /\b5 distinct states found, 0 states left on queue\b/;
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

const REUSE_POSITIVE_STATES =
  /\b7 distinct states found, 0 states left on queue\b/;
const ACCOUNTING_VIOLATION = /Invariant MappedMemoryAccounted is violated\./;
const UNACCOUNTED_REMAP =
  /State \d+: <Remap[^\n]*>\r?\n\/\\ phase = "mapped"\r?\n\/\\ reusable = TRUE(?:\r?\n|$)/;

export function verifyBalloonReuseModelResult(opts: {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}): boolean {
  if (opts.negative) {
    return (
      opts.exitCode === 12 &&
      ACCOUNTING_VIOLATION.test(opts.output) &&
      UNACCOUNTED_REMAP.test(opts.output)
    );
  }
  return (
    opts.exitCode === 0 &&
    COMPLETED.test(opts.output) &&
    REUSE_POSITIVE_STATES.test(opts.output)
  );
}
