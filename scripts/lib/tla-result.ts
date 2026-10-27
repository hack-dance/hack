export type TlaViolation = {
  readonly kind: "invariant" | "temporal";
  readonly property: string;
};

export type TlaExpectation = { readonly kind: "pass" } | TlaViolation;

export type TlaResult = {
  readonly exitCode: number | null;
  readonly output: string;
  readonly failed?: boolean;
};

const COMPLETED = /^Model checking completed\. No error has been found\.$/m;
const DISTINCT_STATES =
  /\b([\d,]+) distinct states found, 0 states left on queue\b/;
const TOOL_MESSAGE =
  /^@!@!@STARTMSG (\d+):(\d+) @!@!@\r?\n([\s\S]*?)^@!@!@ENDMSG \1 @!@!@$/gm;
const TOOL_FAILURE =
  /(?:^|\n)(?:Parsing or semantic analysis failed\.|\*\*\* (?:Parse )?Errors?:|Exception in thread |Error:)/;

/** Accept only completed TLC tool-mode output and the exact expected result. */
export function verifyTlaResult(
  opts: TlaResult & {
    readonly expected: TlaExpectation;
  }
): boolean {
  if (opts.failed || opts.exitCode === null || TOOL_FAILURE.test(opts.output)) {
    return false;
  }
  const messages = Array.from(opts.output.matchAll(TOOL_MESSAGE), (match) => ({
    code: Number(match[1]),
    severity: Number(match[2]),
    body: match[3]?.trim() ?? "",
  }));
  if (
    messages.filter((message) => message.code === 2186).length !== 1 ||
    opts.output.split("@!@!@STARTMSG ").length - 1 !== messages.length ||
    opts.output.split("@!@!@ENDMSG ").length - 1 !== messages.length
  ) {
    return false;
  }
  const errors = messages.filter(
    (message) => message.severity === 1 || message.severity === 2
  );
  if (opts.expected.kind === "pass") {
    const states = DISTINCT_STATES.exec(opts.output)?.[1]?.replaceAll(",", "");
    return (
      opts.exitCode === 0 &&
      errors.length === 0 &&
      messages.some(
        (message) => message.code === 2193 && COMPLETED.test(message.body)
      ) &&
      Number(states) > 0
    );
  }
  const { kind, property } = opts.expected;
  const code = kind === "invariant" ? 2110 : 2116;
  const diagnostic =
    kind === "invariant"
      ? `Invariant ${property} is violated.`
      : `Temporal property ${property} was violated.`;
  const allowedCodes = new Set([code, 2121, 2264]);
  const violations = errors.filter((message) => message.code === code);
  const temporalNames = opts.output
    .split(/\r?\n/)
    .filter((line) => /^Temporal property .+ was violated\.$/.test(line));
  return (
    opts.exitCode === (kind === "invariant" ? 12 : 13) &&
    errors.every((message) => allowedCodes.has(message.code)) &&
    violations.length === 1 &&
    (kind === "invariant"
      ? violations[0]?.body === diagnostic
      : violations[0]?.body === "Temporal properties were violated." &&
        temporalNames.length === 1 &&
        temporalNames[0] === diagnostic)
  );
}
