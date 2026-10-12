/**
 * Shared, pure classifier for one Bun process run or one hosted job log.
 *
 * The bounded crash-loop harness (`scripts/bun-crash-loop.ts`) and the read-only
 * hosted census (`scripts/ci-bun-crash-census.ts`) both classify with this module,
 * so a crash means the same thing in an experiment and in hosted history.
 *
 * Results are closed tokens only. Nothing from the output (paths, test names,
 * crash-report links or values) is ever returned.
 */

/** Exit statuses a shell reports for Bun's crash signals: SIGTRAP (133) and SIGSEGV (139). */
export const BUN_CRASH_EXIT_CODES: readonly number[] = [133, 139];

export type BunRunOutcome = "crash" | "failure" | "pass";

export type BunRunReason =
  /** The output carries Bun's own crash banner. */
  | "banner"
  /** The process was ended by a signal it did not get from the harness. */
  | "signal"
  /** The exit status encodes a crash signal (133 or 139). */
  | "signal_exit"
  /** Exit 0 and no crash banner. */
  | "exit_zero"
  /** A non-zero exit with `bun test` failure markers. */
  | "test_failure"
  /** Any other non-zero exit status, for example a typecheck exit 2. */
  | "exit_code"
  /** No exit status and no signal were observed. */
  | "missing_exit";

export interface BunRunClassification {
  readonly outcome: BunRunOutcome;
  readonly reason: BunRunReason;
}

export interface BunRunObservation {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
}

const CRASH_BANNERS = [/Bun has crashed/, /panic\(main thread\)/];
// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ST) and two-byte ESC sequences.
const ANSI_ESCAPES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const TEST_FAILURE_LINE = /(?:^|\s)\(fail\)\s/m;
const TEST_FAILURE_SUMMARY = /(?:^|\s)[1-9]\d* fail\s*$/m;
const HOSTED_EXIT = /##\[error\]Process completed with exit code (\d{1,3})\./g;
const SIGNAL_NAME = /^SIG[A-Z0-9]{2,10}$/;
const BUN_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const HOSTED_BUN_VERSION_INPUT =
  /^(?:\S+Z )?\s*bun-version: "?(\d{1,3}\.\d{1,3}\.\d{1,3})"?\s*$/m;

/** Removes terminal escape sequences so banners and markers match colored output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPES, "");
}

/** True when the output carries Bun's crash banner, colored or not. */
export function hasBunCrashBanner(output: string): boolean {
  const plain = stripAnsi(output);
  return CRASH_BANNERS.some((banner) => banner.test(plain));
}

/**
 * Classifies one run. A crash banner, a signal, or a crash exit status is a crash
 * whatever else the run printed; exit 0 is a pass; every other result is a
 * non-crash failure.
 */
export function classifyBunRun(
  observation: BunRunObservation
): BunRunClassification {
  const plain = stripAnsi(observation.output);
  if (CRASH_BANNERS.some((banner) => banner.test(plain))) {
    return { outcome: "crash", reason: "banner" };
  }
  if (observation.signal !== null) {
    return { outcome: "crash", reason: "signal" };
  }
  if (observation.exitCode === null) {
    return { outcome: "failure", reason: "missing_exit" };
  }
  if (BUN_CRASH_EXIT_CODES.includes(observation.exitCode)) {
    return { outcome: "crash", reason: "signal_exit" };
  }
  if (observation.exitCode === 0) {
    return { outcome: "pass", reason: "exit_zero" };
  }
  if (TEST_FAILURE_LINE.test(plain) || TEST_FAILURE_SUMMARY.test(plain)) {
    return { outcome: "failure", reason: "test_failure" };
  }
  return { outcome: "failure", reason: "exit_code" };
}

/**
 * The exit status of the step that failed a hosted job, from the runner's
 * `Process completed with exit code N.` annotation, or null when there is none
 * (for example a cancelled or timed-out job).
 */
export function hostedJobExitCode(log: string): number | null {
  let last: number | null = null;
  for (const match of stripAnsi(log).matchAll(HOSTED_EXIT)) {
    last = Number(match[1]);
  }
  return last;
}

/** The Bun version the hosted `Setup Bun` step was given, or null. */
export function hostedJobBunVersion(log: string): string | null {
  const match = HOSTED_BUN_VERSION_INPUT.exec(stripAnsi(log));
  return match?.[1] ?? null;
}

/** Classifies a hosted job log with the same rules as a local run. */
export function classifyHostedJobLog(log: string): BunRunClassification {
  return classifyBunRun({
    exitCode: hostedJobExitCode(log),
    signal: null,
    output: log,
  });
}

/** A closed signal name, or null for anything that is not one. */
export function closedSignalName(signal: unknown): string | null {
  return typeof signal === "string" && SIGNAL_NAME.test(signal) ? signal : null;
}

/** A closed `major.minor.patch` Bun version, or null for anything else. */
export function closedBunVersion(version: unknown): string | null {
  return typeof version === "string" && BUN_VERSION.test(version)
    ? version
    : null;
}
