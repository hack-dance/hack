#!/usr/bin/env bun
/**
 * Read-only census of Bun crashes in hosted CI history.
 *
 * For a `--since`/`--until` window it lists every run of the CI workflow, reads
 * the `test` job of every run attempt, downloads only failed-job logs (all
 * completed logs with `--scan-passing`) into an owned temporary directory, and
 * classifies each with the shared classifier used by `scripts/bun-crash-loop.ts`.
 *
 * It uses the caller's existing `gh` authentication and never handles a token.
 * It is strictly read-only: no reruns, comments, labels or uploads. It prints
 * counts, closed tokens, versions and numeric run/job ids only, never log bodies.
 *
 * Bun version per job comes from the `Setup Bun` input in the job log when a log
 * is read, and otherwise from the workflow file at the run's head commit. For a
 * pull-request run the job actually used the merge commit's workflow, so a stale
 * pull-request head can attribute a job to the older pin; `versionSources` shows
 * how many jobs each source covers.
 */
import { closeSync, openSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BunRunReason,
  classifyHostedJobLog,
  closedBunVersion,
  hostedJobBunVersion,
} from "./lib/bun-crash-classify.ts";

/** A closed, value-free diagnostic the census may print. */
export class CensusError extends Error {}

/** The GitHub REST reads the census needs, through the caller's `gh` authentication. */
export interface GhReader {
  /** Paginated GET; one JSON value per output line of `jq`. */
  readonly lines: (path: string, jq: string) => Promise<readonly string[]>;
  /** One GET returning JSON. */
  readonly json: (path: string) => Promise<unknown>;
  /** GET whose body is written to `destination`. */
  readonly download: (path: string, destination: string) => Promise<void>;
}

export type JobConclusion =
  | "success"
  | "failure"
  | "timed_out"
  | "cancelled"
  | "other";

export type VersionSource = "log" | "workflow" | "unknown";

export interface JobRecord {
  readonly runId: number;
  readonly attempt: number;
  readonly jobId: number;
  readonly conclusion: JobConclusion;
  readonly bunVersion: string;
  readonly versionSource: VersionSource;
  /** Null when no log was read. */
  readonly scan: "crash" | "failure" | "pass" | "unavailable" | null;
  readonly reason: BunRunReason | null;
}

export interface CrashingJob {
  readonly runId: number;
  readonly attempt: number;
  readonly jobId: number;
  readonly reason: BunRunReason;
}

export interface VersionTotals {
  readonly bunVersion: string;
  executions: number;
  successes: number;
  failures: number;
  cancelled: number;
  crashes: number;
  logsScanned: number;
  logsUnavailable: number;
  readonly versionSources: Record<VersionSource, number>;
  readonly crashing: CrashingJob[];
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
const JOB_NAME = /^[A-Za-z0-9_. -]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The runs endpoint returns at most 1000 results for one `created` query. */
const MAX_WINDOW_RUNS = 1000;
const DEFAULT_CONCURRENCY = 6;

const FAILED: ReadonlySet<JobConclusion> = new Set(["failure", "timed_out"]);

function closedConclusion(value: unknown): JobConclusion {
  return value === "success" ||
    value === "failure" ||
    value === "timed_out" ||
    value === "cancelled"
    ? value
    : "other";
}

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

/**
 * The `bun-version` given to the named job in a workflow file, or null. The
 * job block runs from `  <job>:` to the next two-space-indented key.
 */
export function workflowJobBunVersion(
  workflow: string,
  job: string
): string | null {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `  ${job}:`);
  if (start === -1) {
    return null;
  }
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) {
      return null;
    }
    const match = /^\s+bun-version:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (match) {
      return closedBunVersion(match[1]);
    }
  }
  return null;
}

export function emptyTotals(bunVersion: string): VersionTotals {
  return {
    bunVersion,
    executions: 0,
    successes: 0,
    failures: 0,
    cancelled: 0,
    crashes: 0,
    logsScanned: 0,
    logsUnavailable: 0,
    versionSources: { log: 0, workflow: 0, unknown: 0 },
    crashing: [],
  };
}

/** Per-Bun-version totals, versions in ascending order with `unknown` last. */
export function aggregateCensus(
  records: readonly JobRecord[]
): VersionTotals[] {
  const byVersion = new Map<string, VersionTotals>();
  for (const record of records) {
    const totals =
      byVersion.get(record.bunVersion) ?? emptyTotals(record.bunVersion);
    byVersion.set(record.bunVersion, totals);
    totals.executions += 1;
    totals.versionSources[record.versionSource] += 1;
    if (record.conclusion === "success") {
      totals.successes += 1;
    } else if (FAILED.has(record.conclusion)) {
      totals.failures += 1;
    } else if (record.conclusion === "cancelled") {
      totals.cancelled += 1;
    }
    if (record.scan === "unavailable") {
      totals.logsUnavailable += 1;
    } else if (record.scan !== null) {
      totals.logsScanned += 1;
    }
    if (record.scan === "crash" && record.reason !== null) {
      totals.crashes += 1;
      totals.crashing.push({
        runId: record.runId,
        attempt: record.attempt,
        jobId: record.jobId,
        reason: record.reason,
      });
    }
  }
  const order = (version: string): number[] =>
    version === "unknown"
      ? [Number.POSITIVE_INFINITY]
      : version.split(".").map(Number);
  return [...byVersion.values()].sort((left, right) => {
    const a = order(left.bunVersion);
    const b = order(right.bunVersion);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] ?? 0) - (b[index] ?? 0);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  });
}

export interface CensusOptions {
  readonly repository: string;
  readonly workflow: string;
  readonly job: string;
  readonly since: string;
  readonly until: string;
  readonly scanPassing: boolean;
  readonly concurrency?: number;
}

export interface CensusResult {
  readonly runs: number;
  readonly records: readonly JobRecord[];
  readonly totals: readonly VersionTotals[];
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  );
  return results;
}

function parseLine(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CensusError("Unexpected GitHub response");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CensusError("Unexpected GitHub response");
  }
  return value as Record<string, unknown>;
}

interface ScannedLog {
  readonly scan: Exclude<JobRecord["scan"], null>;
  readonly reason: BunRunReason | null;
  readonly bunVersion: string | null;
}

/** Downloads one job log into `workDir`, classifies it and removes it. */
async function scanJobLog(opts: {
  readonly gh: GhReader;
  readonly repo: string;
  readonly jobId: number;
  readonly workDir: string;
}): Promise<ScannedLog> {
  const destination = join(opts.workDir, `job-${opts.jobId}.log`);
  try {
    await opts.gh.download(
      `repos/${opts.repo}/actions/jobs/${opts.jobId}/logs`,
      destination
    );
    const log = await readFile(destination, "utf8");
    const classification = classifyHostedJobLog(log);
    return {
      scan: classification.outcome,
      reason: classification.reason,
      bunVersion: hostedJobBunVersion(log),
    };
  } catch {
    return { scan: "unavailable", reason: null, bunVersion: null };
  } finally {
    await rm(destination, { force: true });
  }
}

function jobVersion(
  fromLog: string | null,
  fromWorkflow: string | null
): { readonly bunVersion: string; readonly versionSource: VersionSource } {
  if (fromLog !== null) {
    return { bunVersion: fromLog, versionSource: "log" };
  }
  if (fromWorkflow !== null) {
    return { bunVersion: fromWorkflow, versionSource: "workflow" };
  }
  return { bunVersion: "unknown", versionSource: "unknown" };
}

/**
 * Runs the census. Logs are written only under `workDir`, one at a time per
 * worker, and each is removed as soon as it is classified.
 */
export async function runCensus(
  options: CensusOptions,
  gh: GhReader,
  workDir: string
): Promise<CensusResult> {
  const repo = options.repository;
  const created = `${options.since}..${options.until}`;
  const runsPath = `repos/${repo}/actions/workflows/${options.workflow}/runs?created=${created}`;
  const head = await gh.json(`${runsPath}&per_page=1`);
  const total =
    typeof head === "object" && head !== null && "total_count" in head
      ? head.total_count
      : null;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new CensusError("Unexpected GitHub response");
  }
  if (total > MAX_WINDOW_RUNS) {
    throw new CensusError("Window has more than 1000 runs; narrow it");
  }
  const runs: { readonly id: number; readonly headSha: string | null }[] = [];
  for (const line of await gh.lines(
    `${runsPath}&per_page=100`,
    ".workflow_runs[] | {id, head_sha}"
  )) {
    const run = parseLine(line);
    const id = positiveInteger(run.id);
    if (id === null) {
      throw new CensusError("Unexpected GitHub response");
    }
    const sha =
      typeof run.head_sha === "string" && SHA.test(run.head_sha)
        ? run.head_sha
        : null;
    if (!runs.some((existing) => existing.id === id)) {
      runs.push({ id, headSha: sha });
    }
  }

  const workflowVersions = new Map<string, Promise<string | null>>();
  const workflowVersion = (sha: string | null): Promise<string | null> => {
    if (sha === null) {
      return Promise.resolve(null);
    }
    const cached = workflowVersions.get(sha);
    if (cached) {
      return cached;
    }
    const pending = gh
      .json(
        `repos/${repo}/contents/.github/workflows/${options.workflow}?ref=${sha}`
      )
      .then((value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("content" in value) ||
          typeof value.content !== "string"
        ) {
          return null;
        }
        return workflowJobBunVersion(
          Buffer.from(value.content, "base64").toString("utf8"),
          options.job
        );
      })
      .catch(() => null);
    workflowVersions.set(sha, pending);
    return pending;
  };

  const perRun = await mapConcurrent(
    runs,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (run) => {
      const seen = new Set<number>();
      const records: JobRecord[] = [];
      const lines = await gh.lines(
        `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
        ".jobs[] | {id, name, run_attempt, status, conclusion}"
      );
      for (const line of lines) {
        const job = parseLine(line);
        const jobId = positiveInteger(job.id);
        const attempt = positiveInteger(job.run_attempt);
        if (
          job.name !== options.job ||
          job.status !== "completed" ||
          job.conclusion === "skipped" ||
          jobId === null ||
          attempt === null ||
          seen.has(jobId)
        ) {
          continue;
        }
        seen.add(jobId);
        const conclusion = closedConclusion(job.conclusion);
        const scanned =
          FAILED.has(conclusion) ||
          (options.scanPassing && conclusion !== "other")
            ? await scanJobLog({ gh, repo, jobId, workDir })
            : null;
        const fromWorkflow = scanned?.bunVersion
          ? null
          : await workflowVersion(run.headSha);
        records.push({
          runId: run.id,
          attempt,
          jobId,
          conclusion,
          ...jobVersion(scanned?.bunVersion ?? null, fromWorkflow),
          scan: scanned?.scan ?? null,
          reason: scanned?.reason ?? null,
        });
      }
      return records;
    }
  );
  const records = perRun.flat();
  return { runs: runs.length, records, totals: aggregateCensus(records) };
}

/** Closed, value-free text report. */
export function renderCensus(opts: {
  readonly options: CensusOptions;
  readonly result: CensusResult;
}): string {
  const { options, result } = opts;
  const lines = [
    `Bun crash census repo=${options.repository} workflow=${options.workflow} job=${options.job} since=${options.since} until=${options.until} runs=${result.runs} jobs=${result.records.length} scan_passing=${options.scanPassing}`,
  ];
  for (const totals of result.totals) {
    const sources = Object.entries(totals.versionSources)
      .map(([source, count]) => `${source}:${count}`)
      .join(",");
    lines.push(
      `bun=${totals.bunVersion} executions=${totals.executions} successes=${totals.successes} failures=${totals.failures} cancelled=${totals.cancelled} crashes=${totals.crashes} logs_scanned=${totals.logsScanned} logs_unavailable=${totals.logsUnavailable} version_sources=${sources}`
    );
    for (const crash of totals.crashing) {
      lines.push(
        `  crash run=${crash.runId} attempt=${crash.attempt} job=${crash.jobId} reason=${crash.reason}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const VALUED_ARGUMENTS = new Set(["since", "until", "repo", "workflow", "job"]);
const BOOLEAN_ARGUMENTS = new Set(["scan-passing", "json"]);

function tokenizeCensusArguments(argv: readonly string[]): {
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index] ?? "");
    const key = match?.[1];
    let value = match?.[2];
    if (key && BOOLEAN_ARGUMENTS.has(key) && value === undefined) {
      if (flags.has(key)) {
        throw new CensusError("Invalid argument");
      }
      flags.add(key);
      continue;
    }
    if (!(key && VALUED_ARGUMENTS.has(key)) || values.has(key)) {
      throw new CensusError("Invalid argument");
    }
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined) {
      throw new CensusError("Invalid argument");
    }
    values.set(key, value);
  }
  return { values, flags };
}

export function parseCensusArguments(argv: readonly string[]): CensusOptions & {
  readonly json: boolean;
} {
  const { values, flags } = tokenizeCensusArguments(argv);
  const since = values.get("since");
  const until = values.get("until");
  if (
    !(since && until && ISO_INSTANT.test(since) && ISO_INSTANT.test(until)) ||
    Number.isNaN(Date.parse(since)) ||
    Number.isNaN(Date.parse(until)) ||
    Date.parse(since) >= Date.parse(until)
  ) {
    throw new CensusError(
      "--since and --until must be UTC instants (YYYY-MM-DDTHH:MM:SSZ) with since before until"
    );
  }
  const repository = values.get("repo") ?? "hack-dance/hack";
  const workflow = values.get("workflow") ?? "ci.yml";
  const job = values.get("job") ?? "test";
  if (
    !(
      REPOSITORY.test(repository) &&
      WORKFLOW_FILE.test(workflow) &&
      JOB_NAME.test(job)
    )
  ) {
    throw new CensusError("Invalid argument");
  }
  return {
    repository,
    workflow,
    job,
    since,
    until,
    scanPassing: flags.has("scan-passing"),
    json: flags.has("json"),
  };
}

async function gh(
  args: readonly string[],
  stdout: "pipe" | number
): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], {
    stdin: "ignore",
    stdout,
    stderr: "ignore",
  });
  const text =
    stdout === "pipe" && proc.stdout instanceof ReadableStream
      ? await new Response(proc.stdout).text()
      : "";
  if ((await proc.exited) !== 0) {
    throw new CensusError("gh api request failed");
  }
  return text;
}

/** `gh api` reader; GET only, with the caller's existing authentication. */
export const ghCliReader: GhReader = {
  lines: async (path, jq) =>
    (
      await gh(
        ["api", "--method", "GET", "--paginate", "--jq", jq, path],
        "pipe"
      )
    )
      .split("\n")
      .filter((line) => line.length > 0),
  json: async (path) => {
    try {
      return JSON.parse(await gh(["api", "--method", "GET", path], "pipe"));
    } catch (error) {
      throw error instanceof CensusError
        ? error
        : new CensusError("Unexpected GitHub response");
    }
  },
  download: async (path, destination) => {
    const fd = openSync(destination, "wx", 0o600);
    try {
      // Logs carry terminal colors; the body goes to the owned file, never the terminal.
      await gh(
        ["api", "--method", "GET", "--allow-escape-sequences", path],
        fd
      );
    } finally {
      closeSync(fd);
    }
  },
};

async function main(): Promise<void> {
  const { json, ...options } = parseCensusArguments(process.argv.slice(2));
  const workDir = await mkdtemp(join(tmpdir(), "hack-bun-census-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  const interrupt = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runCensus(options, ghCliReader, workDir);
    process.stdout.write(
      json
        ? `${JSON.stringify({ options, runs: result.runs, totals: result.totals }, null, 2)}\n`
        : renderCensus({ options, result })
    );
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await rm(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof CensusError ? error.message : "Bun crash census failed"}\n`
    );
    process.exitCode = 1;
  }
}
