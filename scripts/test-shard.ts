#!/usr/bin/env bun
/**
 * Hosted test shard runner (HACK-1381). See scripts/test-shard-plan.ts for the
 * partition and its coverage check.
 *
 *   bun scripts/test-shard.ts verify --count=4
 *   bun scripts/test-shard.ts plan --shard=2/4
 *   bun scripts/test-shard.ts run --shard=2/4 [--durations-out=FILE]
 *       [--file-timeout-seconds=720] [--deadline-seconds=1800]
 *   bun scripts/test-shard.ts update-durations --source=TEXT FILE...
 *
 * `run` first checks the Bun pin and the compiler preflight exactly as
 * `bun run test` does, verifies the plan, then runs each of its files in its
 * own `bun test ./<file>` process from the file's suite directory, so the
 * suite's `bunfig.toml` preload applies. Each file prints a start line, Bun's
 * own output, and a result line with its duration and the shard's elapsed
 * time; a file running longer than two minutes prints a heartbeat. A file
 * that outlives `--file-timeout-seconds` is stopped and reported, and when
 * the shard reaches `--deadline-seconds`, or receives SIGINT/SIGTERM (a
 * GitHub cancellation or job timeout), it names the running file, the files
 * not started and the slowest files before it exits. The run fails when any
 * file fails, times out or does not report exactly one file run.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  buildVerifiedPlan,
  DURATION_TABLE_PATH,
  DURATION_TABLE_SCHEMA,
  discoverTestFiles,
  parseDurationTable,
  parseShardSelection,
  plannedSeconds,
  type ShardSelection,
  suiteForFile,
  TEST_SUITES,
  type TestSuite,
} from "./test-shard-plan.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Default per-file limit: about twice the slowest measured hosted file. */
export const DEFAULT_FILE_TIMEOUT_SECONDS = 720;

/** Default shard limit, below the job's `timeout-minutes` so the report prints. */
export const DEFAULT_DEADLINE_SECONDS = 1800;

/** A running file prints a heartbeat this often. */
export const HEARTBEAT_SECONDS = 120;

/** Files named in the slowest-files report. */
const SLOWEST_COUNT = 10;

/** Bytes of a file's stderr kept to read Bun's summary line. */
const STDERR_TAIL_BYTES = 16_384;

/** How long to keep reading a file's stderr after its Bun process exits. */
const STDERR_DRAIN_MS = 2000;

const BUN_SUMMARY = /Ran (\d+) tests? across (\d+) files?\./g;

export type FileOutcome =
  | "pass"
  | "fail"
  | "file-count"
  | "timeout"
  | "deadline"
  | "interrupted";

export type FileResult = {
  readonly file: string;
  readonly outcome: FileOutcome;
  readonly seconds: number;
  /** Bun's exit code; null when the process was stopped. */
  readonly exitCode: number | null;
  /** Files Bun reported running; null when no summary was printed. */
  readonly filesRan: number | null;
};

/** What one file's process returned; `stopped` means the runner stopped it. */
export type FileRun = {
  readonly exitCode: number | null;
  readonly filesRan: number | null;
  readonly stopped: boolean;
};

/** Runs one file; must resolve promptly after `signal` aborts. */
export type RunFile = (opts: {
  readonly file: string;
  readonly signal: AbortSignal;
}) => Promise<FileRun>;

export type ShardState = {
  readonly label: string;
  readonly files: readonly string[];
  readonly results: FileResult[];
  current: { readonly file: string; readonly startedAt: number } | null;
  readonly startedAt: number;
};

/** `0.4s` below a minute, `12m05s` from a minute up. */
export function formatDuration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped < 59.95) {
    return `${clamped.toFixed(1)}s`;
  }
  const whole = Math.round(clamped);
  const rest = whole % 60;
  return `${Math.floor(whole / 60)}m${String(rest).padStart(2, "0")}s`;
}

/** The number of files Bun's last summary line reports, or null. */
export function bunFilesRan(output: string): number | null {
  let last: number | null = null;
  for (const match of output.matchAll(BUN_SUMMARY)) {
    last = Number(match[2]);
  }
  return last;
}

/** Classify one file's run. Exactly one file must have run for a pass. */
export function classifyFileRun(opts: {
  readonly run: FileRun;
  readonly stopReason: "timeout" | "deadline" | "interrupted" | null;
}): FileOutcome {
  if (opts.stopReason) {
    return opts.stopReason;
  }
  if (opts.run.exitCode !== 0) {
    return "fail";
  }
  return opts.run.filesRan === 1 ? "pass" : "file-count";
}

/** Slowest finished files, longest first (path order breaks ties). */
export function slowestFiles(
  results: readonly FileResult[],
  count = SLOWEST_COUNT
): FileResult[] {
  return [...results]
    .sort(
      (left, right) =>
        right.seconds - left.seconds || (left.file < right.file ? -1 : 1)
    )
    .slice(0, count);
}

/**
 * The report printed when the shard stops early: the running file, the files
 * never started and the slowest finished files.
 */
export function stopReport(opts: {
  readonly state: ShardState;
  readonly reason: string;
  readonly now: number;
}): string[] {
  const { state } = opts;
  const lines = [
    `${state.label} stopped (${opts.reason}) after ${formatDuration((opts.now - state.startedAt) / 1000)}; ${state.results.length}/${state.files.length} files finished.`,
  ];
  if (state.current) {
    lines.push(
      `${state.label} running file: ${state.current.file} (${formatDuration((opts.now - state.current.startedAt) / 1000)})`
    );
  }
  const done = new Set(state.results.map((result) => result.file));
  const notStarted = state.files.filter(
    (file) => !done.has(file) && file !== state.current?.file
  );
  if (notStarted.length > 0) {
    lines.push(`${state.label} not started (${notStarted.length}):`);
    for (const file of notStarted) {
      lines.push(`  ${file}`);
    }
  }
  lines.push(...slowestReport(state));
  return lines;
}

function slowestReport(state: ShardState): string[] {
  const slowest = slowestFiles(state.results);
  if (slowest.length === 0) {
    return [];
  }
  return [
    `${state.label} slowest files:`,
    ...slowest.map(
      (result) =>
        `  ${formatDuration(result.seconds).padStart(7)}  ${result.outcome.padEnd(11)} ${result.file}`
    ),
  ];
}

/** The closing summary; failures first, then the slowest files. */
export function summaryReport(state: ShardState, now: number): string[] {
  const failed = state.results.filter((result) => result.outcome !== "pass");
  const lines = [
    `${state.label} finished ${state.results.length}/${state.files.length} files in ${formatDuration((now - state.startedAt) / 1000)}: ${state.results.length - failed.length} passed, ${failed.length} failed.`,
  ];
  if (failed.length > 0) {
    lines.push(`${state.label} failed files:`);
    for (const result of failed) {
      lines.push(
        `  ${result.outcome.padEnd(11)} ${result.file} (exit ${result.exitCode ?? "none"}, files reported ${result.filesRan ?? "none"}, ${formatDuration(result.seconds)})`
      );
    }
  }
  lines.push(...slowestReport(state));
  return lines;
}

/**
 * Run `state.files` one at a time through `runFile`, recording each result.
 * Stops a file at `fileTimeoutMs`, and the shard at `deadlineAt` or when
 * `interrupt` aborts; files after a stop are left unstarted.
 */
export async function runShardFiles(opts: {
  readonly state: ShardState;
  readonly runFile: RunFile;
  readonly fileTimeoutMs: number;
  readonly deadlineAt: number;
  readonly heartbeatMs: number;
  readonly interrupt: AbortSignal;
  readonly now: () => number;
  readonly log: (line: string) => void;
}): Promise<"complete" | "deadline" | "interrupted"> {
  const { state } = opts;
  for (const [position, file] of state.files.entries()) {
    if (opts.interrupt.aborted) {
      return "interrupted";
    }
    if (opts.now() >= opts.deadlineAt) {
      return "deadline";
    }
    const startedAt = opts.now();
    state.current = { file, startedAt };
    opts.log(
      `${state.label} (${position + 1}/${state.files.length}) start ${file}`
    );
    const controller = new AbortController();
    let stopReason: "timeout" | "deadline" | "interrupted" | null = null;
    const stop = (reason: "timeout" | "deadline" | "interrupted") => {
      if (!stopReason) {
        stopReason = reason;
        controller.abort();
      }
    };
    const fileTimer = setTimeout(
      () => stop("timeout"),
      Math.max(0, Math.min(opts.fileTimeoutMs, opts.deadlineAt - startedAt))
    );
    const deadlineFirst = opts.deadlineAt - startedAt < opts.fileTimeoutMs;
    const onInterrupt = () => stop("interrupted");
    opts.interrupt.addEventListener("abort", onInterrupt);
    const heartbeat = setInterval(() => {
      opts.log(
        `${state.label} still running ${file} (${formatDuration((opts.now() - startedAt) / 1000)})`
      );
    }, opts.heartbeatMs);
    let run: FileRun;
    try {
      run = await opts.runFile({ file, signal: controller.signal });
    } finally {
      clearTimeout(fileTimer);
      clearInterval(heartbeat);
      opts.interrupt.removeEventListener("abort", onInterrupt);
    }
    if (stopReason === "timeout" && deadlineFirst) {
      stopReason = "deadline";
    }
    const result: FileResult = {
      file,
      outcome: classifyFileRun({ run, stopReason }),
      seconds: (opts.now() - startedAt) / 1000,
      exitCode: run.exitCode,
      filesRan: run.filesRan,
    };
    state.results.push(result);
    state.current = null;
    opts.log(
      `${state.label} (${position + 1}/${state.files.length}) ${result.outcome.toUpperCase()} ${file} in ${formatDuration(result.seconds)}; shard elapsed ${formatDuration((opts.now() - state.startedAt) / 1000)}`
    );
    if (result.outcome === "deadline" || result.outcome === "interrupted") {
      return result.outcome;
    }
  }
  return "complete";
}

/** Serialize a duration table: sorted paths, seconds to one decimal. */
export function formatDurationTable(opts: {
  readonly source: string;
  readonly seconds: Readonly<Record<string, number>>;
}): string {
  const seconds: Record<string, number> = {};
  for (const file of Object.keys(opts.seconds).sort()) {
    seconds[file] = Math.round((opts.seconds[file] as number) * 10) / 10;
  }
  return `${JSON.stringify({ schema: DURATION_TABLE_SCHEMA, source: opts.source, seconds }, null, 2)}\n`;
}

/**
 * Measured seconds per finished file, in the duration-table format. Stopped
 * files are left out: their time is a limit, not a measurement.
 */
export function measuredDurations(opts: {
  readonly label: string;
  readonly results: readonly FileResult[];
}): string {
  const seconds: Record<string, number> = {};
  for (const result of opts.results) {
    if (result.outcome === "pass" || result.outcome === "fail") {
      seconds[result.file] = result.seconds;
    }
  }
  return formatDurationTable({ source: opts.label, seconds });
}

/**
 * Merge measured shard outputs over `table`, keeping only files that still
 * exist. Later inputs win for a file measured twice.
 */
export function mergeDurationTables(opts: {
  readonly source: string;
  readonly table: Readonly<Record<string, number>>;
  readonly measured: readonly Readonly<Record<string, number>>[];
  readonly files: readonly string[];
}): string {
  const present = new Set(opts.files);
  const merged: Record<string, number> = {};
  for (const source of [opts.table, ...opts.measured]) {
    for (const [file, seconds] of Object.entries(source)) {
      if (present.has(file)) {
        merged[file] = seconds;
      }
    }
  }
  return formatDurationTable({ source: opts.source, seconds: merged });
}

/**
 * Runs `bun test ./<file>` from the file's suite directory with the caller's
 * environment, forwarding its output unless `quiet`. Stopping sends SIGTERM,
 * then SIGKILL after ten seconds.
 */
export function bunTestFile(opts: {
  readonly repoRoot: string;
  readonly suites?: readonly TestSuite[];
  readonly quiet?: boolean;
}): RunFile {
  return async ({ file, signal }) => {
    const suite = suiteForFile(file, opts.suites ?? TEST_SUITES);
    const cwd = resolve(opts.repoRoot, suite.cwd);
    const relativePath =
      suite.cwd === "." ? file : file.slice(suite.cwd.length + 1);
    const child = Bun.spawn([process.execPath, "test", `./${relativePath}`], {
      cwd,
      env: process.env,
      stdin: "ignore",
      stdout: opts.quiet ? "ignore" : "inherit",
      stderr: "pipe",
    });
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    let tail = "";
    const decoder = new TextDecoder();
    const reader = child.stderr.getReader();
    const forward = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (!opts.quiet) {
          process.stderr.write(value);
        }
        tail = (tail + decoder.decode(value, { stream: true })).slice(
          -STDERR_TAIL_BYTES
        );
      }
    })();
    const exitCode = await child.exited;
    // A process a test left running can hold the pipe open after Bun exits;
    // take what it has written so far rather than wait for its end.
    await Promise.race([forward, Bun.sleep(STDERR_DRAIN_MS)]);
    await reader.cancel().catch(() => undefined);
    signal.removeEventListener("abort", onAbort);
    if (killTimer) {
      clearTimeout(killTimer);
    }
    return {
      exitCode: signal.aborted ? null : exitCode,
      filesRan: bunFilesRan(tail),
      stopped: signal.aborted,
    };
  };
}

function runPackageScript(script: string): void {
  const result = Bun.spawnSync([process.execPath, "run", script], {
    cwd: REPO_ROOT,
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new ClosedCliError(
      `test shard: bun run ${script} failed; the shard has not started.`
    );
  }
}

function githubError(message: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::error title=test shard::${message}\n`);
  }
}

function writeStepSummary(state: ShardState, now: number): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    return;
  }
  const failed = state.results.filter((result) => result.outcome !== "pass");
  const lines = [
    `### ${state.label}`,
    "",
    `${state.results.length}/${state.files.length} files finished in ${formatDuration((now - state.startedAt) / 1000)}; ${failed.length} failed.`,
    "",
    "| Seconds | Outcome | File |",
    "| ---: | --- | --- |",
    ...[...failed, ...slowestFiles(state.results)]
      .filter(
        (result, index, all) =>
          all.findIndex((other) => other.file === result.file) === index
      )
      .map(
        (result) =>
          `| ${result.seconds.toFixed(1)} | ${result.outcome} | \`${result.file}\` |`
      ),
    "",
  ];
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    process.stderr.write(`${state.label} could not write the step summary.\n`);
  }
}

function optionValue(
  args: readonly string[],
  name: string
): string | undefined {
  const prefix = `--${name}=`;
  const found = args.filter((arg) => arg.startsWith(prefix));
  if (found.length > 1) {
    throw new ClosedCliError(`test shard: --${name} was given more than once.`);
  }
  return found[0]?.slice(prefix.length);
}

function positiveSeconds(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9][0-9]{0,5}$/.test(value)) {
    throw new ClosedCliError(
      "test shard: a seconds option must be a positive whole number."
    );
  }
  return Number(value);
}

function requireSelection(args: readonly string[]): ShardSelection {
  const selection = parseShardSelection(optionValue(args, "shard") ?? "");
  if (!selection) {
    throw new ClosedCliError(
      "test shard: --shard=i/n with 1 <= i <= n <= 32 is required."
    );
  }
  return selection;
}

async function commandVerify(args: readonly string[]): Promise<number> {
  const count = Number(optionValue(args, "count") ?? "");
  const plan = await buildVerifiedPlan({ repoRoot: REPO_ROOT, count });
  console.log(
    `test shard plan: ${plan.files.length} files in ${count} shards cover the full test set exactly once.`
  );
  for (const [index, shard] of plan.shards.entries()) {
    const seconds = shard.reduce(
      (total, file) =>
        total + plannedSeconds({ file, durations: plan.durations }),
      0
    );
    const unknown = shard.filter(
      (file) => !Object.hasOwn(plan.durations, file)
    ).length;
    console.log(
      `  shard ${index + 1}/${count}: ${shard.length} files, planned ${formatDuration(seconds)}${unknown > 0 ? ` (${unknown} without a recorded duration)` : ""}`
    );
  }
  return 0;
}

async function commandPlan(args: readonly string[]): Promise<number> {
  const selection = requireSelection(args);
  const plan = await buildVerifiedPlan({
    repoRoot: REPO_ROOT,
    count: selection.count,
  });
  for (const file of plan.shards[selection.index - 1] ?? []) {
    console.log(file);
  }
  return 0;
}

async function commandRun(args: readonly string[]): Promise<number> {
  const selection = requireSelection(args);
  const fileTimeoutSeconds = positiveSeconds(
    optionValue(args, "file-timeout-seconds"),
    DEFAULT_FILE_TIMEOUT_SECONDS
  );
  const deadlineSeconds = positiveSeconds(
    optionValue(args, "deadline-seconds"),
    DEFAULT_DEADLINE_SECONDS
  );
  const durationsOut = optionValue(args, "durations-out");
  const label = `[test shard ${selection.index}/${selection.count}]`;
  const startedAt = Date.now();
  runPackageScript("check:bun-version");
  runPackageScript("test:preflight");
  const plan = await buildVerifiedPlan({
    repoRoot: REPO_ROOT,
    count: selection.count,
  });
  const files = plan.shards[selection.index - 1] ?? [];
  const state: ShardState = {
    label,
    files,
    results: [],
    current: null,
    startedAt,
  };
  const planned = files.reduce(
    (total, file) =>
      total + plannedSeconds({ file, durations: plan.durations }),
    0
  );
  console.log(
    `${label} ${files.length} of ${plan.files.length} files, planned ${formatDuration(planned)}; file timeout ${formatDuration(fileTimeoutSeconds)}, shard deadline ${formatDuration(deadlineSeconds)}.`
  );
  const interrupt = new AbortController();
  let signalName: string | null = null;
  const onSignal = (name: "SIGINT" | "SIGTERM") => {
    if (!signalName) {
      signalName = name;
      for (const line of stopReport({
        state,
        reason: `received ${name}`,
        now: Date.now(),
      })) {
        console.log(line);
      }
      interrupt.abort();
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  const ended = await runShardFiles({
    state,
    runFile: bunTestFile({ repoRoot: REPO_ROOT }),
    fileTimeoutMs: fileTimeoutSeconds * 1000,
    deadlineAt: startedAt + deadlineSeconds * 1000,
    heartbeatMs: HEARTBEAT_SECONDS * 1000,
    interrupt: interrupt.signal,
    now: Date.now,
    log: (line) => console.log(line),
  });
  const now = Date.now();
  if (ended === "deadline") {
    for (const line of stopReport({
      state,
      reason: `reached the ${formatDuration(deadlineSeconds)} shard deadline`,
      now,
    })) {
      console.log(line);
    }
  }
  for (const line of summaryReport(state, now)) {
    console.log(line);
  }
  for (const result of state.results) {
    if (result.outcome !== "pass") {
      githubError(
        `${result.file}: ${result.outcome} after ${formatDuration(result.seconds)}`
      );
    }
  }
  if (ended !== "complete") {
    githubError(
      `${label} stopped (${ended}) with ${files.length - state.results.length} files not finished`
    );
  }
  writeStepSummary(state, now);
  if (durationsOut) {
    await Bun.write(
      durationsOut,
      measuredDurations({ label, results: state.results })
    );
  }
  const failed =
    ended !== "complete" ||
    state.results.length !== files.length ||
    state.results.some((result) => result.outcome !== "pass");
  if (signalName === "SIGINT") {
    return 130;
  }
  if (signalName === "SIGTERM") {
    return 143;
  }
  return failed ? 1 : 0;
}

async function commandUpdateDurations(
  args: readonly string[]
): Promise<number> {
  const source = optionValue(args, "source");
  const inputs = args.filter((arg) => !arg.startsWith("--"));
  if (!source || inputs.length === 0) {
    throw new ClosedCliError(
      "test shard: update-durations needs --source=TEXT (where the numbers were measured) and one or more measured shard files."
    );
  }
  const tablePath = resolve(REPO_ROOT, DURATION_TABLE_PATH);
  const table = parseDurationTable(await Bun.file(tablePath).text());
  const measured: Record<string, number>[] = [];
  for (const path of inputs) {
    measured.push(parseDurationTable(await Bun.file(path).text()));
  }
  await Bun.write(
    tablePath,
    mergeDurationTables({
      source,
      table,
      measured,
      files: discoverTestFiles({ repoRoot: REPO_ROOT }),
    })
  );
  console.log(
    `test shard: updated ${DURATION_TABLE_PATH} from ${inputs.length} file(s).`
  );
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "verify":
        return await commandVerify(args);
      case "plan":
        return await commandPlan(args);
      case "run":
        return await commandRun(args);
      case "update-durations":
        return await commandUpdateDurations(args);
      default:
        throw new ClosedCliError(
          "test shard: usage: bun scripts/test-shard.ts verify --count=n | plan --shard=i/n | run --shard=i/n | update-durations --source=TEXT FILE..."
        );
    }
  } catch (error) {
    if (error instanceof ClosedCliError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
