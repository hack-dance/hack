const COMPLETED = /Model checking completed\. No error has been found\./;
type ModelResult = {
  readonly negative: boolean;
  readonly exitCode: number | null;
  readonly output: string;
};

export function verifyAdmissionModelResult(result: ModelResult): boolean {
  return verifyFiniteModelResult({
    ...result,
    states: 5,
    invariant: "Capacity",
    fields: ["used = {1, 2}"],
  });
}

export function verifyBalloonReuseModelResult(result: ModelResult): boolean {
  return verifyFiniteModelResult({
    ...result,
    states: 7,
    invariant: "MappedMemoryAccounted",
    fields: ['phase = "mapped"', "reusable = TRUE"],
  });
}

export function verifyRestoreHistoryModelResult(result: ModelResult): boolean {
  return verifyFiniteModelResult({
    ...result,
    states: 27,
    invariant: "HistoryPreserved",
    fields: ["legacy = <<>>", "manifest = <<>>", 'phase = "writing"'],
  });
}

const TRACE_STATES = /(?=^State \d+:)/m;
const STATE_HEADER = /^State \d+: <[^>]+>$/;
const DISTINCT_STATES =
  /\b(\d{1,3}(?:,\d{3})+|\d+) distinct states found, 0 states left on queue\b/;

export function verifyFiniteModelResult(
  opts: ModelResult & {
    readonly states: number;
    readonly invariant: string;
    readonly fields: readonly string[];
    readonly alternativeWitnesses?: readonly (readonly string[])[];
  }
): boolean {
  if (!opts.negative) {
    return (
      opts.exitCode === 0 &&
      COMPLETED.test(opts.output) &&
      Number(DISTINCT_STATES.exec(opts.output)?.[1]?.replaceAll(",", "")) ===
        opts.states
    );
  }
  const expectedError = `Error: Invariant ${opts.invariant} is violated.`;
  const outputLines = opts.output.split(/\r?\n/);
  if (
    opts.exitCode !== 12 ||
    !outputLines.includes(expectedError) ||
    opts.output.includes("Parse error") ||
    opts.output.includes("Semantic errors") ||
    COMPLETED.test(opts.output) ||
    outputLines.some(
      (line) =>
        line.startsWith("Error: ") &&
        line !== expectedError &&
        line !== "Error: The behavior up to this point is:"
    )
  ) {
    return false;
  }
  const finalState = opts.output.split(TRACE_STATES).at(-1) ?? "";
  const [header = "", ...lines] = finalState.split(/\r?\n/);
  // TLC reports a first violation. Its incoming action can vary with the
  // search order. The named invariant and the final state's fields are evidence.
  return (
    STATE_HEADER.test(header) &&
    [opts.fields, ...(opts.alternativeWitnesses ?? [])].some(
      (fields) =>
        fields.length > 0 &&
        fields.every((field) => lines.includes(`/\\ ${field}`))
    )
  );
}
