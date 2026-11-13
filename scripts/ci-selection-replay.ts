#!/usr/bin/env bun
import { posix } from "node:path";
import ts from "typescript";
import { isRecord } from "../src/lib/guards.ts";
/**
 * Read-only replay of merged PR test selections, including every CI run attempt.
 * No historical code is executed. Git objects are read into memory; gh uses its
 * existing authentication. Missing annotations/history make the verdict inconclusive.
 * Usage: bun scripts/ci-selection-replay.ts --repository=owner/repo --read-logs [--count=30]
 */
import { COMPILER_HOSTS, planScope } from "./ci-change-scope.ts";
import { touchesCandidate, touchesCompilerHost } from "./ci-pr-plan.ts";
import {
  type SelectionInputs,
  selectTests,
  type TestSelection,
} from "./ci-test-selection.ts";
import { requiresWorkflowFull } from "./ci-workflow-guard.ts";
import {
  classifyTestPools,
  isTestFilePath,
  TEST_SUITES,
} from "./test-shard-plan.ts";

export type ReplayVerdict = {
  readonly failed: readonly string[];
  readonly hidden: readonly string[];
  readonly unknown: boolean;
  readonly unattributedFailure?: boolean;
};

/**
 * Independent, deliberately narrow witness finder: follow static relative runtime
 * imports/exports in snapshot text, without consulting the selector's graph.
 * Prefer a transitive source edge so a direct-test-only selector cannot pass.
 */
function dependencyWitness(opts: {
  readonly tests: readonly string[];
  readonly sources: Readonly<Record<string, string>>;
  readonly selection: TestSelection;
}): { file: string; edited: string; depth: number } {
  let direct: { file: string; edited: string; depth: number } | undefined;
  for (const file of opts.tests) {
    if (opts.selection.files.includes(file)) {
      continue;
    }
    const seen = new Set<string>();
    const queue = [{ path: file, depth: 0 }];
    while (queue.length) {
      const entry = queue.pop();
      if (!entry || seen.has(entry.path)) {
        continue;
      }
      seen.add(entry.path);
      const source = opts.sources[entry.path];
      if (source === undefined) {
        continue;
      }
      if (
        entry.path.startsWith("src/") &&
        !requiresWorkflowFull([entry.path])
      ) {
        const witness = { file, edited: entry.path, depth: entry.depth };
        if (entry.depth > 1) {
          return witness;
        }
        direct ??= witness;
      }
      const ast = ts.createSourceFile(
        entry.path,
        source,
        ts.ScriptTarget.Latest,
        true
      );
      for (const node of ast.statements) {
        if (
          !(
            ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
              (ts.isExportDeclaration(node) && !node.isTypeOnly)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier) &&
            node.moduleSpecifier.text.startsWith(".")
          )
        ) {
          continue;
        }
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        if (
          bindings &&
          (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly)
        ) {
          continue;
        }
        const base = posix.join(
          posix.dirname(entry.path),
          node.moduleSpecifier.text
        );
        const candidates = [base, base.replace(/\.js$/, ".ts")].flatMap(
          (path) =>
            [
              "",
              ".ts",
              ".tsx",
              ".js",
              ".jsx",
              ".mts",
              ".cts",
              "/index.ts",
              "/index.js",
            ].map((extension) => `${path}${extension}`)
        );
        const target = candidates.find((path) =>
          Object.hasOwn(opts.sources, path)
        );
        if (target) {
          queue.push({ path: target, depth: entry.depth + 1 });
        }
      }
    }
  }
  if (!direct) {
    throw new Error(
      "subset has no omitted test with a source dependency witness"
    );
  }
  return direct;
}

/** Virtually edit an omitted test's source dependency to fail; no code executes. */
export function replayPlantedFailure(opts: {
  readonly inputs: SelectionInputs & {
    readonly tests: readonly string[];
    readonly sources: Readonly<Record<string, string>>;
  };
  readonly selection: TestSelection;
  readonly select?: typeof selectTests;
}) {
  const witness =
    opts.selection.mode === "selected"
      ? dependencyWitness({ ...opts.inputs, selection: opts.selection })
      : { file: opts.inputs.tests[0], edited: opts.inputs.tests[0], depth: 0 };
  const { file, edited, depth } = witness;
  if (!(file && edited) || opts.inputs.sources[edited] === undefined) {
    throw new Error("no test source for planted failure");
  }
  const selection = (opts.select ?? selectTests)({
    ...opts.inputs,
    changed:
      opts.inputs.changed === null ? null : [...opts.inputs.changed, edited],
    sources: {
      ...opts.inputs.sources,
      [edited]: `${opts.inputs.sources[edited]}\nthrow new Error("planted replay failure");\n`,
    },
  });
  const verdict = replayFailures({
    log: `[test shard 1/8] (1/1) FAIL ${file} in 0s`,
    selection,
  });
  return {
    file,
    edited,
    depth,
    kind: opts.selection.mode === "selected" ? "dependency" : "full-fallback",
    previouslySelected: opts.selection.files.includes(file),
    mode: selection.mode,
    covered: verdict.hidden.length === 0,
    hidden: verdict.hidden,
  };
}

/** Missing synthetic evidence is inconclusive, rather than a hidden failure. */
export function replayPlantOutcome(
  opts: Parameters<typeof replayPlantedFailure>[0]
) {
  try {
    return { planted: replayPlantedFailure(opts), unknown: [] as string[] };
  } catch {
    return {
      planted: undefined,
      unknown: ["no usable planted-failure source witness"],
    };
  }
}

function replayLogLine(raw: string): string {
  return raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s+/, "");
}

/** The run API names the PR head; checkout records the merge tree actually tested. */
export function replayCheckoutRevision(opts: {
  readonly log: string;
}): string | null {
  const revisions = new Set<string>();
  let expectingRevision = false;
  for (const raw of opts.log.split("\n")) {
    const line = replayLogLine(raw).trim();
    if (/^\[command\].*\bgit(?:\.exe)? log -1 --format=%H$/.test(line)) {
      expectingRevision = true;
      continue;
    }
    if (expectingRevision && line) {
      if (!/^[0-9a-f]{40}$/.test(line)) {
        return null;
      }
      revisions.add(line);
      expectingRevision = false;
    }
  }
  return !expectingRevision && revisions.size === 1
    ? ([...revisions][0] ?? null)
    : null;
}

/** File-runner outcomes include crashes/timeouts; a failed test step without a named file is unknown. */
export function replayFailures(opts: {
  readonly log: string;
  readonly selection: TestSelection;
}): ReplayVerdict {
  const failed = new Set<string>();
  const bunFailures = new Set<string>();
  let running: string | undefined;
  let runnerFrames = false;
  let unattributedFailure = false;
  for (const raw of opts.log.split("\n")) {
    const line = replayLogLine(raw).trimEnd();
    const header = /^((?:tests|packages\/db)\/\S+):$/.exec(line);
    if (!runnerFrames && header?.[1] && isTestFilePath(header[1])) {
      running = header[1];
    }
    const start =
      /\bstart ((?:tests|packages\/db)\/\S+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(
        line
      );
    if (start?.[1]) {
      runnerFrames = true;
      running = start[1];
    }
    if (/(?:^|\s)\(fail\) /.test(line)) {
      if (running) {
        bunFailures.add(running);
      } else {
        unattributedFailure = true;
      }
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
    unknown: failed.size === 0 || unattributedFailure,
    ...(unattributedFailure ? { unattributedFailure: true } : {}),
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

/** Integration jobs keep their own tests even when PRs defer their tier. */
export function replayJobAdmitted(opts: {
  readonly name: string;
  readonly changed: readonly string[];
}): boolean | null {
  const coarse = planScope(opts.changed);
  const full = requiresWorkflowFull(opts.changed) || coarse.scope === "full";
  if (opts.name.startsWith("Candidate core (")) {
    return full || opts.changed.some(touchesCandidate);
  }
  if (opts.name.startsWith("Config compiler (")) {
    const hosts =
      full || opts.changed.some(touchesCompilerHost)
        ? JSON.stringify(
            COMPILER_HOSTS.filter((host) => host.os !== "macos-15-intel")
          )
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

type ReadResult = {
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

/** Retry only transient read failures; auth, quota and output guards fail immediately. */
export function replayReadCommand(opts: {
  readonly args: readonly string[];
  readonly run: () => ReadResult;
}): string {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = opts.run();
    if (result.exitCode === 0) {
      return Buffer.from(result.stdout).toString();
    }
    const error = Buffer.from(result.stderr).toString();
    const refused =
      /HTTP 4\d\d|allow-escape-sequences|refus|denied|authentication|rate limit/i.test(
        error
      );
    const transient =
      !refused &&
      (result.signalCode === "SIGTERM" ||
        /HTTP 50[234]|TLS handshake timeout|i\/o timeout|context deadline exceeded|connection reset|temporary failure|timed out/i.test(
          error
        ));
    if (opts.args[0] !== "gh" || !transient || attempt === 3) {
      throw new Error(
        `read command failed: ${opts.args[0]} (${transient ? "transient read exhausted" : "non-transient read failure"}; ${attempt} attempt(s))`
      );
    }
  }
  throw new Error("unreachable read retry state");
}

function command(args: readonly string[], stdin?: Uint8Array): string {
  return replayReadCommand({
    args,
    run: () =>
      Bun.spawnSync([...args], {
        stdin: stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        maxBuffer: 256 * 1024 * 1024,
      }),
  });
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
    "bunfig.toml",
  ]);
  const entries = tree.split("\0").flatMap((row) => {
    const match =
      /^100[0-7]+ blob ([0-9a-f]{40})\t(.+(?:\.[cm]?[jt]sx?|package\.json|bunfig\.toml)|package\.json|bunfig\.toml)$/.exec(
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
  readonly run: Record<string, unknown>;
  readonly job: Record<string, unknown>;
  readonly skipEvidence: boolean;
  readonly readLogs: boolean;
  readonly historyCache: Map<
    string,
    { changed: readonly string[]; selection: TestSelection }
  >;
}): ReplayVerdict & {
  readonly checkout?: string;
  readonly selectionMode?: string;
} {
  try {
    if (opts.skipEvidence || !opts.readLogs) {
      return { failed: [], hidden: [], unknown: true };
    }
    const log = command([
      "gh",
      "api",
      "--allow-escape-sequences",
      `repos/${opts.repository}/actions/jobs/${integer(opts.job, "id")}/logs`,
    ]);
    const revision = replayCheckoutRevision({ log });
    if (!revision) {
      return { failed: [], hidden: [], unknown: true };
    }
    const head = field(opts.run, "head_sha");
    const key = `${revision}:${head}`;
    let history = opts.historyCache.get(key);
    if (!history) {
      const historical = snapshot(revision);
      const parents = command([
        "git",
        "rev-list",
        "--parents",
        "-n",
        "1",
        revision,
      ])
        .trim()
        .split(/\s+/)
        .slice(1);
      const [base, parentHead] = parents;
      if (
        !(base && parentHead) ||
        parents.length !== 2 ||
        !(parentHead === head || revision === head)
      ) {
        return { failed: [], hidden: [], unknown: true, checkout: revision };
      }
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
          full: requiresWorkflowFull(changed),
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
        checkout: revision,
        selectionMode: selection.mode,
      };
    }
    // A merge-time label might not have existed on this attempt. Audit the
    // narrower unlabeled subset so a later label cannot mask a selection bug.
    const annotations = list(
      `repos/${opts.repository}/check-runs/${integer(opts.job, "id")}/annotations`
    );
    const verdict = replayAnnotations({ annotations, selection });
    const fromLog = replayFailures({ log, selection });
    const failed = [...new Set([...verdict.failed, ...fromLog.failed])];
    const combined = {
      failed,
      hidden: failed.filter((file) => !selection.files.includes(file)),
      unknown: failed.length === 0 || fromLog.unattributedFailure === true,
      checkout: revision,
      selectionMode: selection.mode,
    };
    // A cancelled file has an unknown outcome, not an observed failure. Its
    // complete available log still exposes assertions that failed before it stopped.
    return opts.job.conclusion === "cancelled" &&
      log.trim().length > 0 &&
      !fromLog.unattributedFailure
      ? { ...combined, unknown: false }
      : combined;
  } catch {
    return { failed: [], hidden: [], unknown: true };
  }
}

/** Replays final selections and historical failing revisions separately. */
export async function main(args: readonly string[]): Promise<number> {
  const skipLogs = args.includes("--skip-logs");
  const readLogs = args.includes("--read-logs");
  const plantFailures = args.includes("--plant-failures");
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
      requiresWorkflowFull(changed) ||
      (Array.isArray(pr.labels) &&
        pr.labels.some((label) => isRecord(label) && label.name === "ci:full"));
    const selection = selectTests({
      repoRoot: "/snapshot",
      ...state,
      changed,
      full,
    });
    const planting = plantFailures
      ? replayPlantOutcome({
          inputs: { repoRoot: "/snapshot", ...state, changed, full },
          selection,
        })
      : { planted: undefined, unknown: [] };
    const { planted } = planting;
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
    const unknown: string[] = [...planting.unknown];
    const failures: string[] = [];
    const history: Record<string, unknown>[] = [];
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
            run,
            job,
            skipEvidence: skipLogs,
            readLogs,
            historyCache,
          });
          history.push({
            run: integer(run, "id"),
            attempt,
            job: field(job, "name"),
            checkout: verdict.checkout ?? null,
            selectionMode: verdict.selectionMode ?? null,
            failed: verdict.failed,
            hidden: verdict.hidden,
            unknown: verdict.unknown,
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
    if (hidden.length || planted?.covered === false) {
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
          linuxOnly: true,
          docker: false,
          candidate: false,
          compilerNative: false,
          deferredMacos: pools.macos,
        },
        integration: {
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
        history,
        planted,
        failed: [...new Set(failures)],
        hidden: [...new Set(hidden)],
        unknown,
        verdict:
          hidden.length || planted?.covered === false
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
