#!/usr/bin/env bun
/**
 * Fixed-budget Bun crash loop for the gated `bun-crash-experiment` workflow.
 *
 * It alternates `bun test tests/native-https-owner.test.ts` with the full
 * `bun test`, classifies every run with the shared classifier, keeps each run's
 * log, and writes a closed, value-free summary.
 *
 * Budget invariant: an iteration starts only when its estimated duration (the
 * larger of its initial estimate and its longest observed run) ends at or before
 * the deadline. An iteration that is still running at the deadline is stopped and
 * recorded as `overrun`, never as a crash, unless its log carries the crash banner.
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

export interface LoopResult {
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly iterations: readonly IterationRecord[];
  readonly estimatesMs: Readonly<Record<LoopCommandId, number>>;
}

export const DEFAULT_FOCUSED_ESTIMATE_SECONDS = 120;
export const DEFAULT_FULL_ESTIMATE_SECONDS = 600;
const MIN_BUDGET_SECONDS = 60;
const MAX_BUDGET_SECONDS = 6 * 60 * 60;
const KILL_GRACE_MS = 10_000;
const REVISION = /^[0-9a-f]{40}$/;

/** A closed, value-free diagnostic the loop may print. */
export class LoopError extends Error {}

export function loopCommands(opts: {
  readonly bunExecutable: string;
  readonly focusedEstimateSeconds: number;
  readonly fullEstimateSeconds: number;
}): readonly LoopCommand[] {
  return [
    {
      id: "focused",
      argv: [opts.bunExecutable, "test", "tests/native-https-owner.test.ts"],
      initialEstimateMs: opts.focusedEstimateSeconds * 1000,
    },
    {
      id: "full",
      argv: [opts.bunExecutable, "test"],
      initialEstimateMs: opts.fullEstimateSeconds * 1000,
    },
  ];
}

/**
 * Picks the next command, or null when none can finish by the deadline.
 * The command at `cursor` is preferred; when it does not fit, the next command in
 * sequence order that fits runs instead. Equality with the deadline fits.
 */
export function planNextCommand(opts: {
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly commands: readonly LoopCommand[];
  readonly cursor: number;
  readonly estimatesMs: Readonly<Record<LoopCommandId, number>>;
}): { readonly command: LoopCommand; readonly cursor: number } | null {
  const count = opts.commands.length;
  if (count === 0 || opts.nowMs >= opts.deadlineMs) {
    return null;
  }
  const preferred = ((opts.cursor % count) + count) % count;
  for (let offset = 0; offset < count; offset += 1) {
    const command = opts.commands[(preferred + offset) % count];
    if (
      command !== undefined &&
      opts.nowMs + opts.estimatesMs[command.id] <= opts.deadlineMs
    ) {
      return { command, cursor: preferred + 1 };
    }
  }
  return null;
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

/** Runs commands until none can finish within the budget. */
export async function runBunCrashLoop(opts: {
  readonly budgetMs: number;
  readonly commands: readonly LoopCommand[];
  readonly now: () => number;
  readonly execute: (
    command: LoopCommand,
    context: { readonly index: number; readonly deadlineMs: number }
  ) => Promise<ExecutedRun>;
  readonly onIteration?: (record: IterationRecord) => void;
}): Promise<LoopResult> {
  const startMs = opts.now();
  const deadlineMs = startMs + opts.budgetMs;
  const estimatesMs = {} as Record<LoopCommandId, number>;
  for (const command of opts.commands) {
    estimatesMs[command.id] = command.initialEstimateMs;
  }
  const iterations: IterationRecord[] = [];
  let cursor = 0;
  for (;;) {
    const next = planNextCommand({
      nowMs: opts.now(),
      deadlineMs,
      commands: opts.commands,
      cursor,
      estimatesMs,
    });
    if (next === null) {
      break;
    }
    cursor = next.cursor;
    const index = iterations.length + 1;
    const started = opts.now();
    const run = await opts.execute(next.command, { index, deadlineMs });
    const durationMs = Math.max(0, opts.now() - started);
    estimatesMs[next.command.id] = Math.max(
      estimatesMs[next.command.id],
      durationMs
    );
    const { outcome, reason } = classifyIteration(run);
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
    iterations,
    estimatesMs,
  };
}

const OUTCOMES: readonly IterationOutcome[] = [
  "pass",
  "failure",
  "crash",
  "overrun",
];

export function summarizeIterations(
  iterations: readonly IterationRecord[]
): Record<LoopCommandId, Record<IterationOutcome, number>> {
  const empty = (): Record<IterationOutcome, number> => ({
    pass: 0,
    failure: 0,
    crash: 0,
    overrun: 0,
  });
  const totals = { focused: empty(), full: empty() };
  for (const record of iterations) {
    totals[record.command][record.outcome] += 1;
  }
  return totals;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** Markdown for `$GITHUB_STEP_SUMMARY`. Only closed tokens, numbers and validated identifiers. */
export function renderLoopSummary(opts: {
  readonly result: LoopResult;
  readonly bunVersion: string | null;
  readonly sourceRevision: string | null;
  readonly diagnosticReports: number;
}): string {
  const totals = summarizeIterations(opts.result.iterations);
  const lines = [
    "## Bun crash experiment",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Bun | ${opts.bunVersion ?? "unknown"} |`,
    `| Source revision | ${opts.sourceRevision ?? "unknown"} |`,
    `| Budget seconds | ${seconds(opts.result.budgetMs)} |`,
    `| Loop seconds | ${seconds(opts.result.elapsedMs)} |`,
    `| Iterations | ${opts.result.iterations.length} |`,
    `| Crash reports (bun*.ips) | ${opts.diagnosticReports} |`,
    "",
    "| Command | Runs | Pass | Failure | Crash | Overrun | Estimate seconds |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const id of ["focused", "full"] as const) {
    const row = totals[id];
    const runs = OUTCOMES.reduce((sum, outcome) => sum + row[outcome], 0);
    lines.push(
      `| ${id} | ${runs} | ${row.pass} | ${row.failure} | ${row.crash} | ${row.overrun} | ${seconds(opts.result.estimatesMs[id] ?? 0)} |`
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

export function parseLoopArguments(argv: readonly string[]): LoopArguments {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match?.[1] || match[2] === undefined || values.has(match[1])) {
      throw new LoopError("Invalid argument");
    }
    values.set(match[1], match[2]);
  }
  const known = new Set([
    "budget-seconds",
    "out-dir",
    "expect-bun-version",
    "source-revision",
    "focused-estimate-seconds",
    "full-estimate-seconds",
  ]);
  for (const key of values.keys()) {
    if (!known.has(key)) {
      throw new LoopError("Invalid argument");
    }
  }
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
  return {
    budgetSeconds: parseSeconds(
      "--budget-seconds",
      budget,
      MIN_BUDGET_SECONDS,
      MAX_BUDGET_SECONDS
    ),
    outDir: resolve(outDir ?? join(tmpdir(), "bun-crash-loop")),
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
  });
  const diagnosticReports = await collectDiagnosticReports({
    source: join(homedir(), "Library", "Logs", "DiagnosticReports"),
    destination: join(args.outDir, "diagnostic-reports"),
    sinceMs: loopStartMs,
  });
  const summary = renderLoopSummary({
    result,
    bunVersion,
    sourceRevision: args.sourceRevision,
    diagnosticReports,
  });
  await Bun.write(
    join(args.outDir, "summary.json"),
    `${JSON.stringify(
      {
        bunVersion,
        sourceRevision: args.sourceRevision,
        diagnosticReports,
        ...result,
      },
      null,
      2
    )}\n`
  );
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    await appendFile(stepSummary, summary);
  } else {
    process.stdout.write(summary);
  }
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
