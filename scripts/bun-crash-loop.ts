#!/usr/bin/env bun
/**
 * Fixed-budget Bun crash loop for the gated `bun-crash-experiment` workflow.
 *
 * Modes:
 * - `focused` (default) loops `bun test tests/native-https-owner.test.ts`, the file
 *   in which both original segfaults happened;
 * - `full` loops the full `bun test`;
 * - `alternate` alternates the two.
 * Every run is classified with the shared classifier and keeps its own log, and
 * the loop writes a closed, value-free summary with per-command counts and a
 * one-line verdict.
 *
 * Budget invariant: an iteration starts only when its estimated duration ends at
 * or before the deadline. Until a command has completed a run, its estimate is a
 * conservative prior; afterwards it is the longest completed run of that command
 * times {@link ESTIMATE_HEADROOM}. A command whose estimate does not fit is
 * recorded once as skipped for budget and leaves the rotation: its estimate cannot
 * change without a run and the remaining budget only shrinks, so it could never
 * fit again. The loop ends when every command has been skipped.
 *
 * A run still going at the deadline (an estimate that was too small) is stopped
 * and recorded as `overrun`, never as a crash, unless its log carries the crash
 * banner. With honest estimates this does not happen; the stop is a safety net.
 *
 * The loop never opens or fetches crash-report links. It sets
 * `BUN_ENABLE_CRASH_REPORTING=0` so Bun does not upload a report itself; the logs
 * and macOS `.ips` reports stay local for offline decoding.
 *
 * Do not run this on a shared host: it is meant for an isolated hosted runner.
 */
import { closeSync, openSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type BunRunOutcome,
  type BunRunReason,
  classifyBunRun,
  closedBunVersion,
  closedSignalName,
  hasBunCrashBanner,
} from "./lib/bun-crash-classify.ts";

export type LoopCommandId = "focused" | "full";

/** Which commands the loop runs: one file, the full suite, or both in turn. */
export type LoopMode = "focused" | "full" | "alternate";

export const LOOP_MODES: readonly LoopMode[] = ["focused", "full", "alternate"];
export const DEFAULT_LOOP_MODE: LoopMode = "focused";

/** Closed labels for the matched pair; a dispatched run has none. */
export type LoopRole = "baseline" | "candidate";
const LOOP_ROLES: readonly LoopRole[] = ["baseline", "candidate"];

/** The test file in which both original segfaults happened. */
export const FOCUSED_TEST_FILE = "tests/native-https-owner.test.ts";

export interface LoopCommand {
  readonly id: LoopCommandId;
  readonly argv: readonly string[];
  readonly initialEstimateMs: number;
}

export type IterationOutcome = BunRunOutcome | "overrun";
export type IterationReason = BunRunReason | "deadline";

export interface ExecutedRun {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
  /** The harness stopped the run at the deadline. */
  readonly stoppedAtDeadline: boolean;
}

export interface IterationRecord {
  readonly index: number;
  readonly command: LoopCommandId;
  readonly outcome: IterationOutcome;
  readonly reason: IterationReason;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
}

/** A command the loop did not start because its estimate exceeded the remaining budget. */
export interface SkippedForBudget {
  readonly command: LoopCommandId;
  readonly reason: "budget";
  /** Loop time at which the skip was decided. */
  readonly atMs: number;
  readonly remainingMs: number;
  readonly estimateMs: number;
}

export interface LoopResult {
  readonly budgetMs: number;
  readonly elapsedMs: number;
  /** The configured commands, in rotation order. */
  readonly commands: readonly LoopCommandId[];
  readonly iterations: readonly IterationRecord[];
  readonly skippedForBudget: readonly SkippedForBudget[];
  /** The estimate each command had when the loop ended. */
  readonly estimatesMs: Readonly<Partial<Record<LoopCommandId, number>>>;
}

export const DEFAULT_FOCUSED_ESTIMATE_SECONDS = 120;
/**
 * The full CLI suite takes about 30 to 35 minutes on hosted macOS, so the prior
 * is 40 minutes. The workflow's full-mode budget floor mirrors this value.
 */
export const DEFAULT_FULL_ESTIMATE_SECONDS = 2400;
/** Multiplier on the longest completed run, to absorb run-to-run variance. */
export const ESTIMATE_HEADROOM = 1.2;
const MIN_BUDGET_SECONDS = 60;
const MAX_BUDGET_SECONDS = 6 * 60 * 60;
const KILL_GRACE_MS = 10_000;
const REVISION = /^[0-9a-f]{40}$/;

/** A closed, value-free diagnostic the loop may print. */
export class LoopError extends Error {}

export function loopCommands(opts: {
  readonly bunExecutable: string;
  readonly mode: LoopMode;
  readonly focusedEstimateSeconds: number;
  readonly fullEstimateSeconds: number;
}): readonly LoopCommand[] {
  const focused: LoopCommand = {
    id: "focused",
    argv: [opts.bunExecutable, "test", FOCUSED_TEST_FILE],
    initialEstimateMs: opts.focusedEstimateSeconds * 1000,
  };
  const full: LoopCommand = {
    id: "full",
    argv: [opts.bunExecutable, "test"],
    initialEstimateMs: opts.fullEstimateSeconds * 1000,
  };
  switch (opts.mode) {
    case "focused":
      return [focused];
    case "full":
      return [full];
    case "alternate":
      return [focused, full];
    default:
      throw new LoopError("Invalid mode");
  }
}

/**
 * The estimate for the next start of a command: its conservative prior until a
 * run completes, then the longest completed run times {@link ESTIMATE_HEADROOM}.
 */
export function nextEstimateMs(opts: {
  readonly priorMs: number;
  readonly longestCompletedMs: number | null;
}): number {
  return opts.longestCompletedMs === null
    ? opts.priorMs
    : Math.ceil(opts.longestCompletedMs * ESTIMATE_HEADROOM);
}

/**
 * Decides the next step for the active rotation: run the command at `cursor`
 * when it ends at or before the deadline, otherwise skip it for budget. Equality
 * with the deadline fits; nothing fits once the deadline is reached.
 * Returns null when no command is left.
 */
export function planNextIteration(opts: {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly active: readonly LoopCommand[];
  readonly cursor: number;
  readonly estimatesMs: Readonly<Partial<Record<LoopCommandId, number>>>;
}): {
  readonly action: "run" | "skip";
  readonly command: LoopCommand;
  readonly position: number;
} | null {
  const count = opts.active.length;
  if (count === 0) {
    return null;
  }
  const position = ((opts.cursor % count) + count) % count;
  const command = opts.active[position];
  if (command === undefined) {
    return null;
  }
  const estimate = opts.estimatesMs[command.id] ?? command.initialEstimateMs;
  const fits =
    opts.nowMs < opts.deadlineMs && opts.nowMs + estimate <= opts.deadlineMs;
  return { action: fits ? "run" : "skip", command, position };
}

function classifyIteration(run: ExecutedRun): {
  readonly outcome: IterationOutcome;
  readonly reason: IterationReason;
} {
  if (run.stoppedAtDeadline) {
    return hasBunCrashBanner(run.output)
      ? { outcome: "crash", reason: "banner" }
      : { outcome: "overrun", reason: "deadline" };
  }
  return classifyBunRun(run);
}

/** Runs commands until every command has been skipped for budget. */
export async function runBunCrashLoop(opts: {
  readonly budgetMs: number;
  readonly commands: readonly LoopCommand[];
  readonly now: () => number;
  readonly execute: (
    command: LoopCommand,
    context: { readonly index: number; readonly deadlineMs: number }
  ) => Promise<ExecutedRun>;
  readonly onIteration?: (record: IterationRecord) => void;
  readonly onSkip?: (skip: SkippedForBudget) => void;
}): Promise<LoopResult> {
  const startMs = opts.now();
  const deadlineMs = startMs + opts.budgetMs;
  const estimatesMs: Partial<Record<LoopCommandId, number>> = {};
  const longestCompletedMs: Partial<Record<LoopCommandId, number>> = {};
  for (const command of opts.commands) {
    estimatesMs[command.id] = command.initialEstimateMs;
  }
  const active = [...opts.commands];
  const iterations: IterationRecord[] = [];
  const skippedForBudget: SkippedForBudget[] = [];
  let cursor = 0;
  for (;;) {
    const nowMs = opts.now();
    const next = planNextIteration({
      nowMs,
      deadlineMs,
      active,
      cursor,
      estimatesMs,
    });
    if (next === null) {
      break;
    }
    if (next.action === "skip") {
      const skip: SkippedForBudget = {
        command: next.command.id,
        reason: "budget",
        atMs: Math.max(0, nowMs - startMs),
        remainingMs: Math.max(0, deadlineMs - nowMs),
        estimateMs: estimatesMs[next.command.id] ?? 0,
      };
      skippedForBudget.push(skip);
      opts.onSkip?.(skip);
      // The command after the skipped one moves into its position.
      active.splice(next.position, 1);
      cursor = next.position;
      continue;
    }
    cursor = next.position + 1;
    const index = iterations.length + 1;
    const run = await opts.execute(next.command, { index, deadlineMs });
    const durationMs = Math.max(0, opts.now() - nowMs);
    const { outcome, reason } = classifyIteration(run);
    if (!run.stoppedAtDeadline) {
      const longest = Math.max(
        longestCompletedMs[next.command.id] ?? 0,
        durationMs
      );
      longestCompletedMs[next.command.id] = longest;
      estimatesMs[next.command.id] = nextEstimateMs({
        priorMs: next.command.initialEstimateMs,
        longestCompletedMs: longest,
      });
    }
    const record: IterationRecord = {
      index,
      command: next.command.id,
      outcome,
      reason,
      exitCode:
        typeof run.exitCode === "number" && Number.isInteger(run.exitCode)
          ? run.exitCode
          : null,
      signal: run.stoppedAtDeadline ? null : closedSignalName(run.signal),
      durationMs,
    };
    iterations.push(record);
    opts.onIteration?.(record);
  }
  return {
    budgetMs: opts.budgetMs,
    elapsedMs: Math.max(0, opts.now() - startMs),
    commands: opts.commands.map((command) => command.id),
    iterations,
    skippedForBudget,
    estimatesMs,
  };
}

/** Per-command counts. `failures` are non-crash failures. */
export interface CommandCounts {
  iterations: number;
  passes: number;
  crashes: number;
  failures: number;
  overruns: number;
  skippedForBudget: number;
}

/** Counts for each configured command, in rotation order. */
export function countIterations(
  result: Pick<LoopResult, "commands" | "iterations" | "skippedForBudget">
): Partial<Record<LoopCommandId, CommandCounts>> {
  const counts: Partial<Record<LoopCommandId, CommandCounts>> = {};
  for (const id of result.commands) {
    counts[id] = {
      iterations: 0,
      passes: 0,
      crashes: 0,
      failures: 0,
      overruns: 0,
      skippedForBudget: 0,
    };
  }
  const outcomeField = {
    pass: "passes",
    crash: "crashes",
    failure: "failures",
    overrun: "overruns",
  } as const satisfies Record<IterationOutcome, keyof CommandCounts>;
  for (const record of result.iterations) {
    const row = counts[record.command];
    if (row !== undefined) {
      row.iterations += 1;
      row[outcomeField[record.outcome]] += 1;
    }
  }
  for (const skip of result.skippedForBudget) {
    const row = counts[skip.command];
    if (row !== undefined) {
      row.skippedForBudget += 1;
    }
  }
  return counts;
}

/**
 * One closed line, for example `baseline 0/97 focused crashes` or
 * `Bun 1.4.2 0/40 focused crashes, 0/1 full crashes`.
 */
export function renderVerdict(opts: {
  readonly result: Pick<
    LoopResult,
    "commands" | "iterations" | "skippedForBudget"
  >;
  readonly role: LoopRole | null;
  readonly bunVersion: string | null;
}): string {
  const counts = countIterations(opts.result);
  const subject = opts.role ?? `Bun ${opts.bunVersion ?? "unknown"}`;
  const parts = opts.result.commands.map((id) => {
    const row = counts[id];
    return `${row?.crashes ?? 0}/${row?.iterations ?? 0} ${id} crashes`;
  });
  const overruns = opts.result.commands.reduce(
    (sum, id) => sum + (counts[id]?.overruns ?? 0),
    0
  );
  let verdict = `${subject} ${parts.join(", ")}`;
  if (opts.result.iterations.length === 0) {
    verdict += "; no iteration fit the budget";
  } else if (overruns > 0) {
    verdict += `; ${overruns} overrun`;
  }
  return verdict;
}

/** The closed, value-free `summary.json` document. */
export function buildLoopSummary(opts: {
  readonly result: LoopResult;
  readonly mode: LoopMode;
  readonly role: LoopRole | null;
  readonly bunVersion: string | null;
  readonly sourceRevision: string | null;
  readonly diagnosticReports: number;
}) {
  return {
    verdict: renderVerdict(opts),
    bunVersion: opts.bunVersion,
    role: opts.role,
    mode: opts.mode,
    sourceRevision: opts.sourceRevision,
    diagnosticReports: opts.diagnosticReports,
    budgetMs: opts.result.budgetMs,
    elapsedMs: opts.result.elapsedMs,
    counts: countIterations(opts.result),
    estimatesMs: opts.result.estimatesMs,
    skippedForBudget: opts.result.skippedForBudget,
    iterations: opts.result.iterations,
  };
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** Markdown for `$GITHUB_STEP_SUMMARY`. Only closed tokens, numbers and validated identifiers. */
export function renderLoopSummary(opts: {
  readonly result: LoopResult;
  readonly mode: LoopMode;
  readonly role: LoopRole | null;
  readonly bunVersion: string | null;
  readonly sourceRevision: string | null;
  readonly diagnosticReports: number;
}): string {
  const counts = countIterations(opts.result);
  const lines = [
    "## Bun crash experiment",
    "",
    `Verdict: ${renderVerdict(opts)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Bun | ${opts.bunVersion ?? "unknown"} |`,
    `| Role | ${opts.role ?? "-"} |`,
    `| Mode | ${opts.mode} |`,
    `| Source revision | ${opts.sourceRevision ?? "unknown"} |`,
    `| Budget seconds | ${seconds(opts.result.budgetMs)} |`,
    `| Loop seconds | ${seconds(opts.result.elapsedMs)} |`,
    `| Iterations | ${opts.result.iterations.length} |`,
    `| Crash reports (bun*.ips) | ${opts.diagnosticReports} |`,
    "",
    "| Command | Runs | Pass | Crash | Other failure | Overrun | Skipped for budget | Estimate seconds |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const id of opts.result.commands) {
    const row = counts[id];
    lines.push(
      `| ${id} | ${row?.iterations ?? 0} | ${row?.passes ?? 0} | ${row?.crashes ?? 0} | ${row?.failures ?? 0} | ${row?.overruns ?? 0} | ${row?.skippedForBudget ?? 0} | ${seconds(opts.result.estimatesMs[id] ?? 0)} |`
    );
  }
  lines.push(
    "",
    "| # | Command | Outcome | Reason | Exit | Signal | Seconds |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const record of opts.result.iterations) {
    lines.push(
      `| ${record.index} | ${record.command} | ${record.outcome} | ${record.reason} | ${record.exitCode ?? "-"} | ${record.signal ?? "-"} | ${seconds(record.durationMs)} |`
    );
  }
  for (const skip of opts.result.skippedForBudget) {
    lines.push(
      `| - | ${skip.command} | skipped | budget | - | - | ${seconds(skip.estimateMs)} estimated, ${seconds(skip.remainingMs)} left |`
    );
  }
  lines.push(
    "",
    "Logs and crash reports are in the run artifact. Crash-report links are never opened.",
    ""
  );
  return lines.join("\n");
}

/** Copies `bun*.ips` reports modified at or after `sinceMs` into `destination`. */
export async function collectDiagnosticReports(opts: {
  readonly source: string;
  readonly destination: string;
  readonly sinceMs: number;
}): Promise<number> {
  let names: string[];
  try {
    names = await readdir(opts.source);
  } catch {
    return 0;
  }
  let copied = 0;
  for (const name of names) {
    if (!/^bun.*\.ips$/i.test(name)) {
      continue;
    }
    const source = join(opts.source, name);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile() || info.mtimeMs < opts.sinceMs) {
      continue;
    }
    await mkdir(opts.destination, { recursive: true });
    await copyFile(source, join(opts.destination, name));
    copied += 1;
  }
  return copied;
}

export function executeWithLog(opts: {
  readonly cwd: string;
  readonly logDir: string;
}): (
  command: LoopCommand,
  context: { readonly index: number; readonly deadlineMs: number }
) => Promise<ExecutedRun> {
  return async (command, context) => {
    const logPath = join(
      opts.logDir,
      `iteration-${String(context.index).padStart(3, "0")}-${command.id}.log`
    );
    // Write straight to a file, so a child that keeps the descriptor open cannot block the loop.
    const fd = openSync(logPath, "w", 0o600);
    let stoppedAtDeadline = false;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...command.argv], {
        cwd: opts.cwd,
        env: { ...process.env, BUN_ENABLE_CRASH_REPORTING: "0" },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = setTimeout(
      () => {
        stoppedAtDeadline = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      },
      Math.max(0, context.deadlineMs - Date.now())
    );
    try {
      await proc.exited;
    } finally {
      clearTimeout(stopTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      closeSync(fd);
    }
    return {
      exitCode: proc.exitCode,
      signal: proc.signalCode ?? null,
      output: await readFile(logPath, "utf8"),
      stoppedAtDeadline,
    };
  };
}

export interface LoopArguments {
  readonly budgetSeconds: number;
  readonly outDir: string;
  readonly mode: LoopMode;
  readonly role: LoopRole | null;
  readonly expectBunVersion: string | null;
  readonly sourceRevision: string | null;
  readonly focusedEstimateSeconds: number;
  readonly fullEstimateSeconds: number;
}

function parseSeconds(name: string, value: string, min: number, max: number) {
  if (!/^\d{1,6}$/.test(value)) {
    throw new LoopError(`Invalid ${name}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new LoopError(`Invalid ${name}`);
  }
  return parsed;
}

function parseClosed<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[]
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new LoopError(`Invalid ${name}`);
  }
  return match;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "budget-seconds",
  "out-dir",
  "mode",
  "role",
  "expect-bun-version",
  "source-revision",
  "focused-estimate-seconds",
  "full-estimate-seconds",
]);

/** `--name=value` flags; unknown, malformed or repeated flags are rejected. */
function readFlags(argv: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (
      !match?.[1] ||
      match[2] === undefined ||
      values.has(match[1]) ||
      !KNOWN_FLAGS.has(match[1])
    ) {
      throw new LoopError("Invalid argument");
    }
    values.set(match[1], match[2]);
  }
  return values;
}

export function parseLoopArguments(argv: readonly string[]): LoopArguments {
  const values = readFlags(argv);
  const budget = values.get("budget-seconds");
  if (budget === undefined) {
    throw new LoopError("Missing --budget-seconds");
  }
  const expect = values.get("expect-bun-version");
  if (expect !== undefined && closedBunVersion(expect) === null) {
    throw new LoopError("Invalid --expect-bun-version");
  }
  const revision = values.get("source-revision");
  if (revision !== undefined && !REVISION.test(revision)) {
    throw new LoopError("Invalid --source-revision");
  }
  const outDir = values.get("out-dir");
  if (outDir !== undefined && outDir.length === 0) {
    throw new LoopError("Invalid --out-dir");
  }
  const role = values.get("role");
  return {
    budgetSeconds: parseSeconds(
      "--budget-seconds",
      budget,
      MIN_BUDGET_SECONDS,
      MAX_BUDGET_SECONDS
    ),
    outDir: resolve(outDir ?? join(tmpdir(), "bun-crash-loop")),
    mode: parseClosed(
      "--mode",
      values.get("mode") ?? DEFAULT_LOOP_MODE,
      LOOP_MODES
    ),
    role: role === undefined ? null : parseClosed("--role", role, LOOP_ROLES),
    expectBunVersion: expect ?? null,
    sourceRevision: revision ?? null,
    focusedEstimateSeconds: parseSeconds(
      "--focused-estimate-seconds",
      values.get("focused-estimate-seconds") ??
        String(DEFAULT_FOCUSED_ESTIMATE_SECONDS),
      1,
      MAX_BUDGET_SECONDS
    ),
    fullEstimateSeconds: parseSeconds(
      "--full-estimate-seconds",
      values.get("full-estimate-seconds") ??
        String(DEFAULT_FULL_ESTIMATE_SECONDS),
      1,
      MAX_BUDGET_SECONDS
    ),
  };
}

async function main(): Promise<void> {
  const args = parseLoopArguments(process.argv.slice(2));
  const bunVersion = closedBunVersion(Bun.version);
  if (args.expectBunVersion !== null && bunVersion !== args.expectBunVersion) {
    throw new LoopError("Running Bun does not match --expect-bun-version");
  }
  const logDir = join(args.outDir, "logs");
  await mkdir(logDir, { recursive: true });
  const loopStartMs = Date.now();
  const result = await runBunCrashLoop({
    budgetMs: args.budgetSeconds * 1000,
    commands: loopCommands({
      bunExecutable: process.execPath,
      mode: args.mode,
      focusedEstimateSeconds: args.focusedEstimateSeconds,
      fullEstimateSeconds: args.fullEstimateSeconds,
    }),
    now: Date.now,
    execute: executeWithLog({ cwd: process.cwd(), logDir }),
    onIteration: (record) => {
      process.stdout.write(
        `iteration=${record.index} command=${record.command} outcome=${record.outcome} reason=${record.reason} seconds=${seconds(record.durationMs)}\n`
      );
    },
    onSkip: (skip) => {
      process.stdout.write(
        `skipped command=${skip.command} reason=${skip.reason} estimate_seconds=${seconds(skip.estimateMs)} remaining_seconds=${seconds(skip.remainingMs)}\n`
      );
    },
  });
  const diagnosticReports = await collectDiagnosticReports({
    source: join(homedir(), "Library", "Logs", "DiagnosticReports"),
    destination: join(args.outDir, "diagnostic-reports"),
    sinceMs: loopStartMs,
  });
  const report = {
    result,
    mode: args.mode,
    role: args.role,
    bunVersion,
    sourceRevision: args.sourceRevision,
    diagnosticReports,
  };
  await Bun.write(
    join(args.outDir, "summary.json"),
    `${JSON.stringify(buildLoopSummary(report), null, 2)}\n`
  );
  const summary = renderLoopSummary(report);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    await appendFile(stepSummary, summary);
  } else {
    process.stdout.write(summary);
  }
  process.stdout.write(`verdict: ${renderVerdict(report)}\n`);
  if (result.iterations.length === 0) {
    throw new LoopError("No iteration fits the budget");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof LoopError ? error.message : "Bun crash loop failed"}\n`
    );
    process.exitCode = 1;
  }
}
