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

const HISTORY_POSITIVE_STATES =
  /\b27 distinct states found, 0 states left on queue\b/;
const HISTORY_VIOLATION = /Invariant HistoryPreserved is violated\./;
const HISTORY_STATES = /(?=State \d+:)/;
const HISTORY_PREPARE = /^State \d+: <Prepare[^\n]*>/;
const EMPTY_LEGACY = /^\/\\ legacy = <<>>$/m;
const EMPTY_MANIFEST = /^\/\\ manifest = <<>>$/m;
const HISTORY_WRITING = /^\/\\ phase = "writing"$/m;

export function verifyRestoreHistoryModelResult(opts: {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}): boolean {
  if (opts.negative) {
    return (
      opts.exitCode === 12 &&
      HISTORY_VIOLATION.test(opts.output) &&
      opts.output
        .split(HISTORY_STATES)
        .some(
          (state) =>
            HISTORY_PREPARE.test(state) &&
            EMPTY_LEGACY.test(state) &&
            EMPTY_MANIFEST.test(state) &&
            HISTORY_WRITING.test(state)
        )
    );
  }
  return (
    opts.exitCode === 0 &&
    COMPLETED.test(opts.output) &&
    HISTORY_POSITIVE_STATES.test(opts.output)
  );
}

const TRACE_STATES = /(?=State \d+:)/;
const DISTINCT_STATES =
  /\b(\d+) distinct states found, 0 states left on queue\b/;

export function verifyFiniteModelResult(opts: {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  readonly states: number;
  readonly invariant: string;
  readonly action: string;
  readonly fields: readonly string[];
  readonly alternativeWitnesses?: readonly {
    readonly action: string;
    readonly fields: readonly string[];
  }[];
}): boolean {
  if (!opts.negative) {
    return (
      opts.exitCode === 0 &&
      COMPLETED.test(opts.output) &&
      Number(DISTINCT_STATES.exec(opts.output)?.[1]) === opts.states
    );
  }
  const expectedError = `Error: Invariant ${opts.invariant} is violated.`;
  if (
    opts.output.includes("Parse error") ||
    opts.output.includes("Semantic errors") ||
    COMPLETED.test(opts.output) ||
    opts.output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith("Error: ") &&
          line !== expectedError &&
          line !== "Error: The behavior up to this point is:"
      )
  ) {
    return false;
  }
  return (
    opts.exitCode === 12 &&
    opts.output.includes(`Invariant ${opts.invariant} is violated.`) &&
    opts.output.split(TRACE_STATES).some((state) => {
      const lines = state.split(/\r?\n/);
      if (!/^State \d+: </.test(lines[0] ?? "")) {
        return false;
      }
      return [
        { action: opts.action, fields: opts.fields },
        ...(opts.alternativeWitnesses ?? []),
      ].some(
        (witness) =>
          lines[0]?.includes(`<${witness.action} `) &&
          witness.fields.every((field) => lines.includes(`/\\ ${field}`))
      );
    })
  );
}
