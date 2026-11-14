/**
 * Deterministic sharding of the hosted `bun test` suite (HACK-1381).
 *
 * The serial hosted `test` job ran every test file in one `bun test` process
 * under Turbo and took 37-42 minutes, so a slow runner reached GitHub's
 * 60-minute job limit, and Turbo's buffered output could not name the file
 * that was running when the job was cancelled. CI now splits the same files
 * across parallel `test shard i/n` jobs (`scripts/test-shard.ts`).
 *
 * The partition is a pure function of the discovered file paths, the shard
 * count and the checked-in duration table, so every runner of one commit
 * computes the same plan without coordinating. Balancing is longest
 * processing time first: files are taken from the longest recorded duration
 * down (path order breaks ties) and each goes to the currently lightest shard
 * (lowest index breaks ties). A file without a recorded duration gets
 * {@link DEFAULT_FILE_SECONDS}, so a new file is always planned; a stale
 * duration costs wall time, never coverage.
 *
 * Coverage is checked, closed, on every shard run: the union of all shards
 * must equal the full test-file set that `bun run test` (Turbo) runs, which is
 * enumerated independently through `git ls-files`, and no file may appear in
 * two shards.
 */
import { statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import { isRecord } from "../src/lib/guards.ts";

/**
 * One `bun test` invocation of the Turbo `test` task: the files under `root`
 * run with `cwd` as the working directory, so that directory's `bunfig.toml`
 * preloads and its tsconfig path aliases apply exactly as under Turbo.
 * Both paths are repository-relative.
 */
export type TestSuite = {
  readonly id: string;
  readonly cwd: string;
  readonly root: string;
};

/**
 * The suites `bun run test` runs through Turbo. `packages/cli`'s `test` runs
 * `bun test` at the repository root, where `bunfig.toml` sets `root =
 * "./tests"`; `packages/db`'s `test` runs `bun test` in its own directory.
 */
export const TEST_SUITES: readonly TestSuite[] = [
  { id: "cli", cwd: ".", root: "tests" },
  { id: "db", cwd: "packages/db", root: "packages/db" },
];

/** Workspaces whose `test` script Turbo runs; each maps to a suite above. */
export const TEST_SCRIPT_WORKSPACES: readonly string[] = [
  "packages/cli",
  "packages/db",
];

/** The root `bunfig.toml` test root that the `cli` suite mirrors. */
export const ROOT_BUNFIG_TEST_ROOT = "./tests";

/** Upper bound on `n` in `--shard=i/n`. */
export const MAX_TEST_SHARD_COUNT = 32;

/** Planned duration of a file with no recorded duration yet. */
export const DEFAULT_FILE_SECONDS = 5;

/** Planned cost of starting one `bun test` process with the suite preload. */
export const PER_FILE_START_SECONDS = 0.3;

/** Repository-relative path of the checked-in duration table. */
export const DURATION_TABLE_PATH = "scripts/test-shard-durations.json";

/** Schema tag of the duration table and of each shard's measured output. */
export const DURATION_TABLE_SCHEMA = "hack.test-shard-durations.v1";

/** Bun's test-file names: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
const TEST_FILE_NAME =
  /(?:\.test|_test|\.spec|_spec)\.(?:jsx?|tsx?|[cm][jt]s)$/;

const SHARD_PATTERN = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

/** Paths named in one coverage failure before the rest are counted. */
const MAX_NAMED_PATHS = 20;

export type ShardSelection = {
  /** One-based shard index, `1 <= index <= count`. */
  readonly index: number;
  readonly count: number;
};

/** Parse `i/n`; null for anything outside `1 <= i <= n <= 32`. */
export function parseShardSelection(value: string): ShardSelection | null {
  const match = SHARD_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count > MAX_TEST_SHARD_COUNT || index > count) {
    return null;
  }
  return { index, count };
}

/**
 * Whether Bun's test discovery would run `path` (repository-relative, `/`
 * separated): a test-file name outside `node_modules` and hidden directories.
 */
export function isTestFilePath(path: string): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (!TEST_FILE_NAME.test(name)) {
    return false;
  }
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "node_modules" &&
      !segment.startsWith(".")
  );
}

function within(opts: { readonly root: string; readonly path: string }) {
  return opts.root === "." || opts.path.startsWith(`${opts.root}/`);
}

/** The suite that runs `file`, refused closed when none does. */
export function suiteForFile(
  file: string,
  suites: readonly TestSuite[] = TEST_SUITES
): TestSuite {
  const owners = suites.filter((suite) =>
    within({ root: suite.root, path: file })
  );
  if (owners.length !== 1) {
    throw new ClosedCliError(
      `test shard: ${file} must belong to exactly one test suite, found ${owners.length}.`
    );
  }
  return owners[0] as TestSuite;
}

/**
 * Every test file Bun would discover under the suite roots, found on disk,
 * as sorted repository-relative paths. This is the set the shards run.
 */
export function discoverTestFiles(opts: {
  readonly repoRoot: string;
  readonly suites?: readonly TestSuite[];
}): string[] {
  const suites = opts.suites ?? TEST_SUITES;
  const found = new Set<string>();
  const glob = new Bun.Glob("**/*");
  for (const suite of suites) {
    const base = resolve(opts.repoRoot, suite.root);
    if (!isDirectory(base)) {
      throw new ClosedCliError(
        `test shard: the ${suite.id} suite root ${suite.root} is not a directory.`
      );
    }
    for (const entry of glob.scanSync({ cwd: base, onlyFiles: true })) {
      const path = relative(opts.repoRoot, resolve(base, entry))
        .split(sep)
        .join("/");
      if (isTestFilePath(path)) {
        found.add(path);
      }
    }
  }
  return [...found].sort();
}

/**
 * The same test-file set enumerated independently through Git: tracked files
 * plus untracked files that are not ignored, under the suite roots. Refused,
 * closed, when Git cannot list the checkout.
 */
export function listGitTestFiles(opts: {
  readonly repoRoot: string;
  readonly suites?: readonly TestSuite[];
}): string[] {
  const suites = opts.suites ?? TEST_SUITES;
  const git = Bun.which("git");
  if (!git) {
    throw new ClosedCliError(
      "test shard: git is not on PATH, so the full test-file set cannot be enumerated."
    );
  }
  const result = Bun.spawnSync(
    [
      git,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...suites.map((suite) => suite.root),
    ],
    {
      cwd: opts.repoRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );
  if (result.exitCode !== 0) {
    throw new ClosedCliError(
      "test shard: git ls-files failed, so the full test-file set cannot be enumerated."
    );
  }
  const files = new Set<string>();
  for (const path of result.stdout.toString().split("\0")) {
    // A tracked file deleted in the work tree is still listed; Bun cannot run it.
    if (
      path.length > 0 &&
      isTestFilePath(path) &&
      isFile(resolve(opts.repoRoot, path))
    ) {
      files.add(path);
    }
  }
  return [...files].sort();
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse a duration table, closed: `{ "schema": DURATION_TABLE_SCHEMA,
 * "seconds": { "<repo-relative path>": <finite seconds >= 0> } }`.
 */
export function parseDurationTable(text: string): Record<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ClosedCliError("test shard: the duration table is not JSON.");
  }
  if (
    !(
      isRecord(value) &&
      value.schema === DURATION_TABLE_SCHEMA &&
      isRecord(value.seconds)
    )
  ) {
    throw new ClosedCliError(
      `test shard: the duration table must have schema ${DURATION_TABLE_SCHEMA} and a seconds object.`
    );
  }
  const seconds: Record<string, number> = {};
  for (const [path, entry] of Object.entries(value.seconds)) {
    if (
      !(
        typeof entry === "number" &&
        Number.isFinite(entry) &&
        entry >= 0 &&
        isTestFilePath(path)
      )
    ) {
      throw new ClosedCliError(
        "test shard: every duration table entry must be a test-file path with finite non-negative seconds."
      );
    }
    seconds[path] = entry;
  }
  return seconds;
}

/**
 * Planned seconds for `file`: its recorded duration (else the default) plus
 * the per-file process start. Without that addend, files recorded at zero
 * seconds would not add load and would all land on one shard.
 */
export function plannedSeconds(opts: {
  readonly file: string;
  readonly durations: Readonly<Record<string, number>>;
}): number {
  const recorded = Object.hasOwn(opts.durations, opts.file)
    ? (opts.durations[opts.file] as number)
    : DEFAULT_FILE_SECONDS;
  return recorded + PER_FILE_START_SECONDS;
}

/**
 * Split `files` into `count` disjoint shards whose union is `files`, each in
 * path order. Duplicate paths are refused because they would run twice.
 */
export function partitionTestFiles(opts: {
  readonly files: readonly string[];
  readonly count: number;
  readonly durations: Readonly<Record<string, number>>;
}): string[][] {
  if (
    !Number.isSafeInteger(opts.count) ||
    opts.count < 1 ||
    opts.count > MAX_TEST_SHARD_COUNT
  ) {
    throw new ClosedCliError(
      `test shard: the shard count must be an integer from 1 to ${MAX_TEST_SHARD_COUNT}.`
    );
  }
  if (new Set(opts.files).size !== opts.files.length) {
    throw new ClosedCliError("test shard: test file paths must be unique.");
  }
  const longestFirst = [...opts.files].sort((left, right) => {
    const byDuration =
      plannedSeconds({ file: right, durations: opts.durations }) -
      plannedSeconds({ file: left, durations: opts.durations });
    if (byDuration !== 0) {
      return byDuration;
    }
    return left < right ? -1 : 1;
  });
  const loads: number[] = Array.from({ length: opts.count }, () => 0);
  const shards: string[][] = Array.from({ length: opts.count }, () => []);
  for (const file of longestFirst) {
    let lightest = 0;
    for (let shard = 1; shard < opts.count; shard += 1) {
      if ((loads[shard] as number) < (loads[lightest] as number)) {
        lightest = shard;
      }
    }
    loads[lightest] =
      (loads[lightest] as number) +
      plannedSeconds({ file, durations: opts.durations });
    (shards[lightest] as string[]).push(file);
  }
  return shards.map((shard) => shard.sort());
}

export type CoverageReport = {
  /** Files in the full set that no shard runs. */
  readonly missing: readonly string[];
  /** Files that more than one shard (or one shard twice) runs. */
  readonly duplicated: readonly string[];
  /** Files a shard runs that are not in the full set. */
  readonly unexpected: readonly string[];
};

/** Compare the shards' union with the full set; every list empty means exact. */
export function shardCoverage(opts: {
  readonly expected: readonly string[];
  readonly shards: readonly (readonly string[])[];
}): CoverageReport {
  const expected = new Set(opts.expected);
  const seen = new Map<string, number>();
  for (const shard of opts.shards) {
    for (const file of shard) {
      seen.set(file, (seen.get(file) ?? 0) + 1);
    }
  }
  return {
    missing: [...expected].filter((file) => !seen.has(file)).sort(),
    duplicated: [...seen]
      .filter(([, count]) => count > 1)
      .map(([file]) => file)
      .sort(),
    unexpected: [...seen.keys()].filter((file) => !expected.has(file)).sort(),
  };
}

function namedPaths(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return [];
  }
  const lines = [`${label} (${paths.length}):`];
  for (const path of paths.slice(0, MAX_NAMED_PATHS)) {
    lines.push(`  ${path}`);
  }
  if (paths.length > MAX_NAMED_PATHS) {
    lines.push(`  ... and ${paths.length - MAX_NAMED_PATHS} more`);
  }
  return lines;
}

/** Refuses, closed, unless the shards cover `expected` exactly once each. */
export function assertShardCoverage(opts: {
  readonly expected: readonly string[];
  readonly shards: readonly (readonly string[])[];
}): void {
  const report = shardCoverage(opts);
  const lines = [
    ...namedPaths("not run by any shard", report.missing),
    ...namedPaths("run by more than one shard", report.duplicated),
    ...namedPaths(
      "run by a shard but not in the full test set",
      report.unexpected
    ),
  ];
  if (lines.length > 0) {
    throw new ClosedCliError(
      [
        `test shard: the ${opts.shards.length} shards do not cover the full test set exactly once.`,
        ...lines,
      ].join("\n")
    );
  }
}

/**
 * Refuses, closed, when Turbo's `test` task would run a suite the shards do
 * not know: a workspace `test` script outside {@link TEST_SCRIPT_WORKSPACES},
 * a known one that disappeared, or a changed root `bunfig.toml` test root.
 */
export async function assertSuiteInputs(opts: {
  readonly repoRoot: string;
}): Promise<void> {
  const rootPackage: unknown = await Bun.file(
    resolve(opts.repoRoot, "package.json")
  ).json();
  const workspaces =
    isRecord(rootPackage) && Array.isArray(rootPackage.workspaces)
      ? rootPackage.workspaces.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [];
  const withTest: string[] = [];
  for (const pattern of workspaces) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for (const manifest of glob.scanSync({
      cwd: opts.repoRoot,
      onlyFiles: true,
    })) {
      const parsed: unknown = await Bun.file(
        resolve(opts.repoRoot, manifest)
      ).json();
      if (
        isRecord(parsed) &&
        isRecord(parsed.scripts) &&
        typeof parsed.scripts.test === "string"
      ) {
        withTest.push(
          manifest
            .split(sep)
            .join("/")
            .replace(/\/package\.json$/, "")
        );
      }
    }
  }
  const actual = [...new Set(withTest)].sort();
  const known = [...TEST_SCRIPT_WORKSPACES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(known)) {
    throw new ClosedCliError(
      `test shard: Turbo runs test scripts in [${actual.join(", ")}] but the shard suites cover [${known.join(", ")}]; update TEST_SUITES in scripts/test-shard-plan.ts.`
    );
  }
  const bunfig: unknown = Bun.TOML.parse(
    await Bun.file(resolve(opts.repoRoot, "bunfig.toml")).text()
  );
  const testRoot =
    isRecord(bunfig) && isRecord(bunfig.test) ? bunfig.test.root : undefined;
  if (testRoot !== ROOT_BUNFIG_TEST_ROOT) {
    throw new ClosedCliError(
      `test shard: bunfig.toml [test].root must be ${ROOT_BUNFIG_TEST_ROOT} to match the cli suite root.`
    );
  }
}

/**
 * How the hosted shards split the suite (HACK-1960).
 *
 * - `full`: every shard runs on macOS and the `n` shards partition the whole
 *   set. CI no longer uses it (HACK-2028); it stays for manual runs.
 * - `pooled`: CI pushes and pull requests run the platform-sensitive files
 *   (the `macos` pool) on the first {@link POOLED_MACOS_SHARDS} shards, on
 *   macOS, and every other file (the `linux` pool) on the remaining shards, on
 *   Linux.
 */
export type TestLayout = "full" | "pooled";

export type TestPool = "macos" | "linux";

/** In the pooled layout, shards `1..POOLED_MACOS_SHARDS` are the macOS pool. */
export const POOLED_MACOS_SHARDS = 3;

/**
 * A test file whose source, or a `tests/` module it imports, matches this may
 * behave differently off macOS, so the pooled layout keeps it on macOS. The
 * match is deliberately broad: a false positive costs macOS minutes, a false
 * negative loses CI macOS coverage of that file (pushes are pooled too, since
 * HACK-2028), so add such a file to {@link MACOS_POOL_FILES}.
 */
export const PLATFORM_SENSITIVE_SOURCE =
  /process\.platform|\bplatform\(\)|\bdarwin\b|\bmacOS\b|launchctl|osascript|sandbox-exec|keychain|\/private\/(?:tmp|var)|\blsof\b|\bpgrep\b|\bsysctl\b|kqueue|fsevents/i;

/**
 * Files the pattern misses that still need macOS, with the reason. An entry
 * here keeps the file in the macOS pool of the pooled layout.
 */
export const MACOS_POOL_FILES: Readonly<Record<string, string>> = {};

/**
 * Files that need both hosts, with the reason: their macOS run (they match
 * {@link PLATFORM_SENSITIVE_SOURCE} or are listed in {@link MACOS_POOL_FILES})
 * would otherwise be their only one, while tests in them skip off Linux or
 * observe Linux-only behavior, or include portable CLI contracts needed on light
 * PRs. They are planned in the macOS pool, which
 * keeps the pools a partition for the exactly-once coverage check, and are
 * added to the Linux pool as well (HACK-2142).
 */
export const BOTH_POOL_FILES: Readonly<Record<string, string>> = {
  "tests/lifecycle-fifo-retirement.test.ts":
    "FIFO retirement needs Linux process groups and macOS zombie-probe EPERM coverage",
  "tests/lifecycle-zombie-retirement.test.ts":
    "held zombies return probe success on Linux and can return EPERM on macOS",
  "tests/v4-upgrade.test.ts":
    "historical upgrade must preserve keys and values on Linux and macOS",
  "tests/upgrade-installer.test.ts":
    "download recovery and installation publication must work on both hosts",
  "tests/daemon-systemd.test.ts":
    "the systemd user service tests run only on Linux (linuxTest)",
  "tests/daemon-systemd-cli.test.ts":
    "the systemd CLI flows run only on Linux (skipIf not linux)",
  "tests/daemon-process-proof.test.ts":
    "the /proc process-identity tests run only on Linux",
  "tests/daemon-detach.test.ts":
    "detached start differs on Linux (setsid, /proc liveness)",
  "tests/daemon-socket-permissions.test.ts":
    "daemon directory trust walks host paths (macOS /var -> /private/var)",
  "tests/local-network-hint.test.ts":
    "portable open --json subprocess contract must gate light PRs; macOS hint behavior still needs macOS",
};

/** Parse a layout name, refused closed. */
export function parseTestLayout(value: string | undefined): TestLayout {
  if (value === undefined || value === "full") {
    return "full";
  }
  if (value === "pooled") {
    return "pooled";
  }
  throw new ClosedCliError("test shard: --layout must be full or pooled.");
}

/**
 * The pool and the pool-local selection of global shard `selection` in the
 * pooled layout: shards `1..POOLED_MACOS_SHARDS` split the macOS pool, the
 * rest split the Linux pool.
 */
export function pooledSelection(selection: ShardSelection): {
  readonly pool: TestPool;
  readonly selection: ShardSelection;
} {
  if (selection.count <= POOLED_MACOS_SHARDS) {
    throw new ClosedCliError(
      `test shard: the pooled layout needs more than ${POOLED_MACOS_SHARDS} shards.`
    );
  }
  if (selection.index <= POOLED_MACOS_SHARDS) {
    return {
      pool: "macos",
      selection: { index: selection.index, count: POOLED_MACOS_SHARDS },
    };
  }
  return {
    pool: "linux",
    selection: {
      index: selection.index - POOLED_MACOS_SHARDS,
      count: selection.count - POOLED_MACOS_SHARDS,
    },
  };
}

/** The `process.platform` a pool must run on. */
export function poolPlatform(pool: TestPool): NodeJS.Platform {
  return pool === "macos" ? "darwin" : "linux";
}

const RELATIVE_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;

/** Repository-relative modules that `file` imports through relative paths. */
function localImports(opts: {
  readonly repoRoot: string;
  readonly file: string;
  readonly source: string;
  readonly sources?: Readonly<Record<string, string>>;
}): string[] {
  const found: string[] = [];
  const base = dirname(resolve(opts.repoRoot, opts.file));
  for (const match of opts.source.matchAll(RELATIVE_IMPORT)) {
    const target = resolve(base, match[1] as string);
    for (const candidate of [target, `${target}.ts`]) {
      const path = relative(opts.repoRoot, candidate).split(sep).join("/");
      if (
        !path.startsWith("../") &&
        (opts.sources ? Object.hasOwn(opts.sources, path) : isFile(candidate))
      ) {
        found.push(path);
        break;
      }
    }
  }
  return found;
}

/** Whether `path` is a module under one of the test suite roots. */
function inTestSuite(path: string): boolean {
  return TEST_SUITES.some((suite) => within({ root: suite.root, path }));
}

/**
 * Whether `file`'s source, or a module it imports (transitively) that
 * `follow` admits, matches `pattern`. By default only test-suite modules are
 * followed, not product code: the test is what decides which host behavior
 * it observes.
 */
export async function testSourceMatches(opts: {
  readonly repoRoot: string;
  readonly file: string;
  readonly pattern: RegExp;
  readonly cache?: Map<string, string>;
  /** Which imported modules to read too; test-suite modules by default. */
  readonly follow?: (path: string) => boolean;
  /** Historical replay reads git objects without executing or checking them out. */
  readonly sources?: Readonly<Record<string, string>>;
}): Promise<boolean> {
  const cache = opts.cache ?? new Map<string, string>();
  const seen = new Set<string>();
  const queue = [opts.file];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    let source = cache.get(file);
    if (source === undefined) {
      source = opts.sources
        ? opts.sources[file]
        : await Bun.file(resolve(opts.repoRoot, file)).text();
      if (source === undefined) {
        throw new ClosedCliError("test shard: source snapshot is incomplete.");
      }
      cache.set(file, source);
    }
    if (opts.pattern.test(source)) {
      return true;
    }
    queue.push(
      ...localImports({
        repoRoot: opts.repoRoot,
        file,
        source,
        sources: opts.sources,
      }).filter(opts.follow ?? inTestSuite)
    );
  }
  return false;
}

/** Split `files` into the pooled layout's macOS and Linux pools. */
export async function classifyTestPools(opts: {
  readonly repoRoot: string;
  readonly files: readonly string[];
  readonly macosFiles?: Readonly<Record<string, string>>;
  /** Test seam: files run in both pools (defaults to {@link BOTH_POOL_FILES}). */
  readonly bothFiles?: Readonly<Record<string, string>>;
  readonly sources?: Readonly<Record<string, string>>;
}): Promise<{
  readonly macos: readonly string[];
  /** Includes the {@link BOTH_POOL_FILES} files, which are also in `macos`. */
  readonly linux: readonly string[];
  /** The files in both pools. */
  readonly both: readonly string[];
}> {
  const macosFiles = opts.macosFiles ?? MACOS_POOL_FILES;
  const bothFiles = opts.bothFiles ?? BOTH_POOL_FILES;
  const cache = new Map<string, string>();
  const macos: string[] = [];
  const linux: string[] = [];
  const both: string[] = [];
  for (const file of opts.files) {
    if (Object.hasOwn(bothFiles, file)) {
      macos.push(file);
      linux.push(file);
      both.push(file);
      continue;
    }
    const sensitive =
      Object.hasOwn(macosFiles, file) ||
      (await testSourceMatches({
        repoRoot: opts.repoRoot,
        file,
        pattern: PLATFORM_SENSITIVE_SOURCE,
        cache,
        sources: opts.sources,
      }));
    (sensitive ? macos : linux).push(file);
  }
  return { macos, linux, both };
}

/**
 * Focused runs for pull requests that change only documentation or only the
 * runtime core (HACK-1960): instead of the whole suite, Linux jobs run every
 * test file that names those sources, directly or through a shared
 * `tests/helpers/` module or a `scripts/` module it imports (the documentation
 * generators and checks live there). The patterns are broad, so a doubtful file runs.
 * Scenario fixtures are not followed: they write their own README and docs
 * files into temporary projects, which would pull in the whole suite.
 */
export type TestFocus = "docs" | "runtime-core";

export const FOCUS_SOURCE: Readonly<Record<TestFocus, RegExp>> = {
  docs: /docs\/|["'`]docs["'`]|README|CHANGELOG|SECURITY\.md|PACKAGING\.md|LICENSE|site\/|["'`]site["'`]/,
  "runtime-core":
    /runtime-core|relay-guest|hack-runtime-candidate|provider-pins|hack-local|build-hack-local/,
};

/** Parse a comma-separated focus list, refused closed. */
export function parseTestFocus(value: string): readonly TestFocus[] {
  const names = value.split(",");
  const focus: TestFocus[] = [];
  for (const name of names) {
    if (!(name === "docs" || name === "runtime-core") || focus.includes(name)) {
      throw new ClosedCliError(
        "test shard: --focus must list docs and/or runtime-core, comma-separated, once each."
      );
    }
    focus.push(name);
  }
  return focus.sort();
}

export type ShardPlan = {
  /** The full test-file set, from disk; equal to the Git enumeration. */
  readonly files: readonly string[];
  /** The files the shards split: the full set, one pool, or a focus. */
  readonly scope: readonly string[];
  readonly shards: readonly (readonly string[])[];
  readonly durations: Readonly<Record<string, number>>;
};

function selectedScope(opts: {
  readonly scope: readonly string[];
  readonly tracked: readonly string[];
  readonly selected: readonly string[] | undefined;
}): readonly string[] {
  if (!opts.selected) {
    return opts.scope;
  }
  const selected = new Set(opts.selected);
  if (
    selected.size !== opts.selected.length ||
    opts.selected.some((file) => !opts.tracked.includes(file))
  ) {
    throw new ClosedCliError(
      "test shard: selection contains duplicate or undiscovered files."
    );
  }
  return opts.scope.filter((file) => selected.has(file));
}

/**
 * Discover, partition and verify the plan for `count` shards. Refuses,
 * closed, when disk and Git disagree on the test-file set or when the shards
 * do not cover it exactly once.
 */
export async function buildVerifiedPlan(opts: {
  readonly repoRoot: string;
  readonly count: number;
  readonly suites?: readonly TestSuite[];
  readonly durationTablePath?: string;
  /** Test seam: replaces the partition, to prove the coverage check fails. */
  readonly partition?: typeof partitionTestFiles;
  /** Plan only this pool of the pooled layout; `count` shards split it. */
  readonly pool?: TestPool;
  /** Test seam: extra macOS pool files (defaults to {@link MACOS_POOL_FILES}). */
  readonly macosFiles?: Readonly<Record<string, string>>;
  /** Test seam: files run in both pools (defaults to {@link BOTH_POOL_FILES}). */
  readonly bothFiles?: Readonly<Record<string, string>>;
  /** Plan only the files that read these sources; `count` shards split them. */
  readonly focus?: readonly TestFocus[];
  /** Validated PR subset. Full discovery/coverage still runs before filtering. */
  readonly selectedFiles?: readonly string[];
}): Promise<ShardPlan> {
  const suites = opts.suites ?? TEST_SUITES;
  if (!opts.suites) {
    await assertSuiteInputs({ repoRoot: opts.repoRoot });
  }
  const durations = parseDurationTable(
    await Bun.file(
      resolve(opts.repoRoot, opts.durationTablePath ?? DURATION_TABLE_PATH)
    ).text()
  );
  const files = discoverTestFiles({ repoRoot: opts.repoRoot, suites });
  const tracked = listGitTestFiles({ repoRoot: opts.repoRoot, suites });
  const drift = shardCoverage({ expected: tracked, shards: [files] });
  if (drift.missing.length > 0 || drift.unexpected.length > 0) {
    throw new ClosedCliError(
      [
        "test shard: the test files found on disk and listed by git differ.",
        ...namedPaths("listed by git but not found on disk", drift.missing),
        ...namedPaths("found on disk but not listed by git", drift.unexpected),
      ].join("\n")
    );
  }
  if (opts.pool && opts.focus) {
    throw new ClosedCliError("test shard: a pool and a focus cannot combine.");
  }
  let scope: readonly string[] = tracked;
  if (opts.pool) {
    const pools = await classifyTestPools({
      repoRoot: opts.repoRoot,
      files: tracked,
      macosFiles: opts.macosFiles,
      bothFiles: opts.bothFiles,
    });
    // Apart from the files deliberately run on both hosts (counted in the
    // macOS pool), the two pools must partition the full set, so the pooled
    // layout as a whole still runs every file at least once and only those
    // twice.
    const both = new Set(pools.both);
    assertShardCoverage({
      expected: tracked,
      shards: [pools.macos, pools.linux.filter((file) => !both.has(file))],
    });
    scope = pools[opts.pool];
  } else if (opts.focus) {
    if (opts.focus.length === 0) {
      throw new ClosedCliError(
        "test shard: a focus needs at least one source set."
      );
    }
    const pattern = new RegExp(
      opts.focus.map((name) => FOCUS_SOURCE[name].source).join("|")
    );
    const cache = new Map<string, string>();
    const focused: string[] = [];
    for (const file of tracked) {
      if (
        await testSourceMatches({
          repoRoot: opts.repoRoot,
          file,
          pattern,
          cache,
          follow: (path) =>
            path.startsWith("tests/helpers/") || path.startsWith("scripts/"),
        })
      ) {
        focused.push(file);
      }
    }
    scope = focused;
  }
  scope = selectedScope({ scope, tracked, selected: opts.selectedFiles });
  const shards = (opts.partition ?? partitionTestFiles)({
    files: scope,
    count: opts.count,
    durations,
  });
  assertShardCoverage({ expected: scope, shards });
  return { files, scope, shards, durations };
}
