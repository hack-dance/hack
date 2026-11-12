#!/usr/bin/env bun
import { isRecord } from "../src/lib/guards.ts";
/**
 * Read-only replay of merged PR test selections, including every CI run attempt.
 * No historical code is executed. Git objects are read into memory; gh uses its
 * existing authentication. Missing annotations/history make the verdict inconclusive.
 * Usage: bun scripts/ci-selection-replay.ts --repository=owner/repo [--count=30]
 */
import { COMPILER_HOSTS, planScope } from "./ci-change-scope.ts";
import { touchesCandidate, touchesCompilerHost } from "./ci-pr-plan.ts";
import { selectTests, type TestSelection } from "./ci-test-selection.ts";
import {
  classifyTestPools,
  isTestFilePath,
  TEST_SUITES,
} from "./test-shard-plan.ts";

export type ReplayVerdict = {
  readonly failed: readonly string[];
  readonly hidden: readonly string[];
  readonly unknown: boolean;
};

/** File-runner outcomes include crashes/timeouts; a failed test step without a named file is unknown. */
export function replayFailures(opts: {
  readonly log: string;
  readonly selection: TestSelection;
}): ReplayVerdict {
  const failed = new Set<string>();
  const bunFailures = new Set<string>();
  let running: string | undefined;
  for (const raw of opts.log.split("\n")) {
    const line = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
    const start =
      /\bstart ((?:tests|packages\/db)\/\S+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(
        line
      );
    if (start?.[1]) {
      running = start[1];
    }
    if (running && /(?:^|\s)\(fail\) /.test(line)) {
      bunFailures.add(running);
    }
    const completed =
      /\b(PASS|FAIL|FILE-COUNT|TIMEOUT|DEADLINE|INTERRUPTED) ((?:tests|packages\/db)\/\S+\.(?:test|spec)\.[cm]?[jt]sx?) in /.exec(
        line
      );
    if (completed?.[2]) {
      if (completed[1] === "PASS") {
        bunFailures.delete(completed[2]);
      }
      running = undefined;
    }
  }
  for (const match of opts.log.matchAll(
    /\b(?:FAIL|FILE-COUNT|TIMEOUT|DEADLINE|INTERRUPTED) ((?:tests|packages\/db)\/[^\r\n]+?\.(?:test|spec)\.[cm]?[jt]sx?) in /g
  )) {
    if (match[1]) {
      failed.add(match[1]);
    }
  }
  for (const file of bunFailures) {
    failed.add(file);
  }
  return {
    failed: [...failed].sort(),
    hidden: [...failed]
      .filter((file) => !opts.selection.files.includes(file))
      .sort(),
    unknown: failed.size === 0,
  };
}

/** The shard runner emits a check annotation for every non-passing file. */
export function replayAnnotations(opts: {
  readonly annotations: readonly Record<string, unknown>[];
  readonly selection: TestSelection;
}): ReplayVerdict {
  const failed = new Set<string>();
  for (const annotation of opts.annotations) {
    if (annotation.annotation_level !== "failure") {
      continue;
    }
    if (
      typeof annotation.path === "string" &&
      isTestFilePath(annotation.path)
    ) {
      failed.add(annotation.path);
    }
    if (typeof annotation.message === "string") {
      for (const match of annotation.message.matchAll(
        /((?:tests|packages\/db)\/[^\s:]+(?:\.test|_test|\.spec|_spec)\.[cm]?[jt]sx?): (?:fail|file-count|timeout|deadline|interrupted) after /g
      )) {
        if (match[1]) {
          failed.add(match[1]);
        }
      }
    }
  }
  return {
    failed: [...failed].sort(),
    hidden: [...failed]
      .filter((file) => !opts.selection.files.includes(file))
      .sort(),
    unknown: failed.size === 0,
  };
}

/** Dedicated jobs keep their own tests even if a unit file is not selected. */
export function replayJobAdmitted(opts: {
  readonly name: string;
  readonly changed: readonly string[];
}): boolean | null {
  const coarse = planScope(opts.changed);
  const full = coarse.scope === "full";
  if (opts.name.startsWith("Candidate core (")) {
    return full || opts.changed.some(touchesCandidate);
  }
  if (opts.name.startsWith("Config compiler (")) {
    const hosts =
      full || opts.changed.some(touchesCompilerHost)
        ? JSON.stringify(COMPILER_HOSTS)
        : coarse.compiler_hosts;
    return hosts.includes(JSON.stringify(opts.name.slice(17, -1)));
  }
  if (opts.name === "docs site") {
    return coarse.docs_site;
  }
  if (
    opts.name.startsWith("docker-e2e shard ") ||
    opts.name === "runtime-images" ||
    opts.name === "linux-process-lifetime"
  ) {
    return coarse.suite;
  }
  if (opts.name === "Runtime state models" || opts.name === "secret-scan") {
    return true;
  }
  return null;
}

function command(args: readonly string[], stdin?: Uint8Array): string {
  const result = Bun.spawnSync([...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`read command failed: ${args[0]}`);
  }
  return result.stdout.toString();
}
function api(path: string): unknown {
  return JSON.parse(command(["gh", "api", path]));
}
function records(value: unknown): Record<string, unknown>[] {
  if (!(Array.isArray(value) && value.every(isRecord))) {
    throw new Error("invalid API list");
  }
  return value;
}
function field(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string") {
    throw new Error(`missing API string: ${key}`);
  }
  return found;
}
function integer(value: Record<string, unknown>, key: string): number {
  const found = value[key];
  if (typeof found !== "number" || !Number.isSafeInteger(found) || found < 1) {
    throw new Error(`missing API integer: ${key}`);
  }
  return found;
}
function list(path: string, key?: string): Record<string, unknown>[] {
  const all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`
    );
    const items = records(key && isRecord(result) ? result[key] : result);
    all.push(...items);
    if (items.length < 100) {
      return all;
    }
  }
  throw new Error("API history exceeds bounded pagination; replay incomplete");
}

/**
 * Updated order provides a stopping bound: an unseen PR cannot have merged
 * after its update time. Sorting only a page of recently created PRs would
 * silently miss an old PR merged today.
 */
export function recentMergedPullRequests(opts: {
  readonly repository: string;
  readonly count: number;
  readonly read?: (path: string) => unknown;
}): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10; page++) {
    const items = records(
      (opts.read ?? api)(
        `repos/${opts.repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`
      )
    );
    found.push(...items.filter((item) => typeof item.merged_at === "string"));
    found.sort((a, b) =>
      field(b, "merged_at").localeCompare(field(a, "merged_at"))
    );
    const last = items.at(-1);
    const cutoff = found[opts.count - 1];
    if (
      items.length < 100 ||
      (last &&
        cutoff &&
        field(last, "updated_at") <= field(cutoff, "merged_at"))
    ) {
      if (found.length < opts.count) {
        throw new Error("insufficient merged PR history");
      }
      return found.slice(0, opts.count).map((pr) => ({
        number: pr.number,
        headRefName: isRecord(pr.head) ? pr.head.ref : undefined,
        mergeCommit: { oid: pr.merge_commit_sha },
        createdAt: pr.created_at,
        mergedAt: pr.merged_at,
        labels: pr.labels,
      }));
    }
  }
  throw new Error("merged PR history exceeds replay bound");
}

/** Parse cat-file byte counts, not line delimiters inside source files. */
export function parseGitSources(opts: {
  readonly entries: readonly { path: string; oid: string }[];
  readonly output: Uint8Array;
}): Record<string, string> {
  const buffer = Buffer.from(opts.output);
  let offset = 0;
  const sources: Record<string, string> = {};
  for (const entry of opts.entries) {
    const end = buffer.indexOf(10, offset);
    const header = buffer.subarray(offset, end).toString().split(" ");
    const size = Number(header[2]);
    if (
      end < 0 ||
      header[0] !== entry.oid ||
      header[1] !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size + 2 > buffer.length
    ) {
      throw new Error("incomplete git object snapshot");
    }
    sources[entry.path] = buffer.subarray(end + 1, end + 1 + size).toString();
    offset = end + size + 2;
  }
  return sources;
}
function snapshot(sha: string): {
  sources: Record<string, string>;
  tests: string[];
} {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("invalid source revision");
  }
  try {
    command(["git", "cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    command(["git", "fetch", "--no-tags", "origin", sha]);
  }
  const tree = command([
    "git",
    "ls-tree",
    "-rz",
    sha,
    "--",
    "src",
    "tests",
    "scripts",
    "packages/db",
    "package.json",
  ]);
  const entries = tree.split("\0").flatMap((row) => {
    const match =
      /^100[0-7]+ blob ([0-9a-f]{40})\t(.+(?:\.[cm]?[jt]sx?|package\.json)|package\.json)$/.exec(
        row
      );
    return match?.[1] && match[2] ? [{ oid: match[1], path: match[2] }] : [];
  });
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    stdin: Buffer.from(`${entries.map((entry) => entry.oid).join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error("git snapshot unavailable");
  }
  return {
    sources: parseGitSources({ entries, output: result.stdout }),
    tests: entries
      .map((entry) => entry.path)
      .filter(
        (path) =>
          isTestFilePath(path) &&
          TEST_SUITES.some((suite) => path.startsWith(`${suite.root}/`))
      ),
  };
}

function isUnitJob(name: string): boolean {
  return /^test shard \d+\/\d+$/.test(name) || name === "test focus";
}

function isReplayFailureJob(job: Record<string, unknown>): boolean {
  if (
    typeof job.conclusion !== "string" ||
    !["failure", "timed_out", "cancelled"].includes(job.conclusion)
  ) {
    return false;
  }
  const name = field(job, "name");
  if (name === "test" || name === "docker-e2e") {
    return false;
  }
  const steps = Array.isArray(job.steps) ? records(job.steps) : [];
  if (isUnitJob(name)) {
    return steps.some(
      (step) =>
        /^(Tests \(shard\)|Focused tests)$/.test(field(step, "name")) &&
        typeof step.conclusion === "string" &&
        ["failure", "timed_out", "cancelled"].includes(step.conclusion)
    );
  }
  return steps.some(
    (step) =>
      /test|verify|regression|check|docs/i.test(field(step, "name")) &&
      step.conclusion === "failure"
  );
}

function inspectReplayJob(opts: {
  readonly repository: string;
  readonly merge: string;
  readonly run: Record<string, unknown>;
  readonly job: Record<string, unknown>;
  readonly skipEvidence: boolean;
  readonly readLogs: boolean;
  readonly historyCache: Map<
    string,
    { changed: readonly string[]; selection: TestSelection }
  >;
}): ReplayVerdict {
  try {
    const revision = field(opts.run, "head_sha");
    const key = `${opts.merge}:${revision}`;
    let history = opts.historyCache.get(key);
    if (!history) {
      const historical = snapshot(revision);
      const base = command([
        "git",
        "merge-base",
        `${opts.merge}^1`,
        revision,
      ]).trim();
      const changed = command([
        "git",
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        base,
        revision,
      ])
        .split("\0")
        .filter(Boolean);
      history = {
        changed,
        selection: selectTests({
          repoRoot: "/snapshot",
          ...historical,
          changed,
          full: false,
        }),
      };
      opts.historyCache.set(key, history);
    }
    const { changed, selection } = history;
    const name = field(opts.job, "name");
    if (!isUnitJob(name)) {
      const admitted = replayJobAdmitted({ name, changed });
      return {
        failed: [`job: ${name}`],
        hidden: admitted === false ? [`job: ${name}`] : [],
        unknown: admitted === null,
      };
    }
    if (opts.skipEvidence) {
      return { failed: [], hidden: [], unknown: true };
    }
    // A merge-time label might not have existed on this attempt. Audit the
    // narrower unlabeled subset so a later label cannot mask a selection bug.
    const annotations = list(
      `repos/${opts.repository}/check-runs/${integer(opts.job, "id")}/annotations`
    );
    const verdict = replayAnnotations({ annotations, selection });
    if (!(verdict.unknown && opts.readLogs)) {
      return verdict;
    }
    const log = command([
      "gh",
      "api",
      "--allow-escape-sequences",
      `repos/${opts.repository}/actions/jobs/${integer(opts.job, "id")}/logs`,
    ]);
    const fromLog = replayFailures({ log, selection });
    // A cancelled file has an unknown outcome, not an observed failure. Its
    // complete available log still exposes assertions that failed before it stopped.
    return opts.job.conclusion === "cancelled"
      ? { ...fromLog, unknown: false }
      : fromLog;
  } catch {
    return { failed: [], hidden: [], unknown: true };
  }
}

/** Replays final selections and historical failing revisions separately. */
export async function main(args: readonly string[]): Promise<number> {
  const skipLogs = args.includes("--skip-logs");
  const readLogs = args.includes("--read-logs");
  const historyCache = new Map<
    string,
    { changed: readonly string[]; selection: TestSelection }
  >();
  const repository = args
    .find((arg) => arg.startsWith("--repository="))
    ?.slice(13);
  const count = Number(
    args.find((arg) => arg.startsWith("--count="))?.slice(8) ?? 30
  );
  if (
    !(
      repository &&
      /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      Number.isSafeInteger(count)
    ) ||
    count < 1 ||
    count > 30
  ) {
    throw new Error("use --repository=owner/repo and --count=1..30");
  }
  const merged = recentMergedPullRequests({ repository, count });
  let bugs = 0;
  let inconclusive = 0;
  for (const pr of merged) {
    const number = integer(pr, "number");
    const merge = pr.mergeCommit;
    if (!isRecord(merge)) {
      throw new Error("missing merge revision");
    }
    const sha = field(merge, "oid");
    const state = snapshot(sha);
    const changed = command([
      "git",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      `${sha}^1`,
      sha,
    ])
      .split("\0")
      .filter(Boolean);
    const full =
      Array.isArray(pr.labels) &&
      pr.labels.some((label) => isRecord(label) && label.name === "ci:full");
    const selection = selectTests({
      repoRoot: "/snapshot",
      ...state,
      changed,
      full,
    });
    const pools = await classifyTestPools({
      repoRoot: "/snapshot",
      files: selection.files,
      sources: state.sources,
    });
    const runs = list(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(field(pr, "headRefName"))}`,
      "workflow_runs"
    ).filter(
      (run) =>
        field(run, "created_at") >= field(pr, "createdAt") &&
        field(run, "created_at") <= field(pr, "mergedAt")
    );
    const hidden: string[] = [];
    const unknown: string[] = [];
    const failures: string[] = [];
    let attempts = 0;
    for (const run of runs) {
      for (let attempt = 1; attempt <= integer(run, "run_attempt"); attempt++) {
        attempts++;
        const jobs = list(
          `repos/${repository}/actions/runs/${integer(run, "id")}/attempts/${attempt}/jobs`,
          "jobs"
        );
        for (const job of jobs.filter(isReplayFailureJob)) {
          const verdict = inspectReplayJob({
            repository,
            merge: sha,
            run,
            job,
            skipEvidence: skipLogs,
            readLogs,
            historyCache,
          });
          failures.push(...verdict.failed);
          hidden.push(...verdict.hidden);
          if (verdict.unknown) {
            unknown.push(
              `run ${integer(run, "id")} attempt ${attempt}: incomplete failure evidence for ${field(job, "name")}`
            );
          }
        }
      }
    }
    if (runs.length === 0) {
      unknown.push("no PR CI history found");
    }
    if (hidden.length) {
      bugs++;
    }
    if (unknown.length) {
      inconclusive++;
    }
    console.log(
      JSON.stringify({
        pr: number,
        sha,
        changed,
        mode: selection.mode,
        reason: selection.reason,
        selected: selection.files.length,
        total: state.tests.length,
        files: selection.files,
        macos: pools.macos,
        linux: pools.linux,
        ready: {
          docker: full || planScope(changed).suite,
          candidate: full || changed.some(touchesCandidate),
          compilerNative: full || changed.some(touchesCompilerHost),
        },
        draft: {
          linuxOnly: true,
          docker: false,
          native: false,
          mergeable: false,
        },
        runs: runs.length,
        attempts,
        failed: [...new Set(failures)],
        hidden: [...new Set(hidden)],
        unknown,
        verdict: hidden.length
          ? "BUG"
          : unknown.length
            ? "INCONCLUSIVE"
            : "no known hidden failure",
      })
    );
  }
  console.error(
    `replayed ${count} PRs; ${bugs} with hidden failures; ${inconclusive} inconclusive`
  );
  return bugs ? 1 : inconclusive ? 2 : 0;
}
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
