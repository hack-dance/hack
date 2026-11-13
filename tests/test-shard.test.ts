import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fullPushPlan } from "../scripts/ci-pr-plan.ts";
import { CI_JOBS } from "../scripts/prerelease-plan.ts";
import {
  bunFilesRan,
  bunTestFile,
  classifyFileRun,
  deferredMacosSummary,
  type FileResult,
  formatDuration,
  formatDurationTable,
  measuredDurations,
  mergeDurationTables,
  prioritizeSlowFiles,
  type RunFile,
  runShardFiles,
  type ShardState,
  stopReport,
  summaryReport,
  testFileTimeoutMs,
} from "../scripts/test-shard.ts";
import {
  assertShardCoverage,
  assertSuiteInputs,
  buildVerifiedPlan,
  DEFAULT_FILE_SECONDS,
  DURATION_TABLE_PATH,
  isTestFilePath,
  listGitTestFiles,
  MAX_TEST_SHARD_COUNT,
  PER_FILE_START_SECONDS,
  POOLED_MACOS_SHARDS,
  parseDurationTable,
  parseShardSelection,
  parseTestFocus,
  parseTestLayout,
  partitionTestFiles,
  plannedSeconds,
  pooledSelection,
  poolPlatform,
  shardCoverage,
  suiteForFile,
  type TestSuite,
  testSourceMatches,
} from "../scripts/test-shard-plan.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const repoRoot = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterAll(async () => {
  await Promise.all(
    owned.map((path) => rm(path, { recursive: true, force: true }))
  );
});

const FIXTURE_SUITES: readonly TestSuite[] = [
  { id: "cli", cwd: ".", root: "tests" },
  { id: "db", cwd: "packages/db", root: "packages/db" },
];

/** A throwaway Git work tree with test files; nothing is committed. */
async function fixtureRepo(opts: {
  readonly files: readonly string[];
  readonly gitignore?: string;
  readonly durations?: Record<string, number>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-test-shard-"));
  owned.push(root);
  const init = Bun.spawnSync(["git", "init", "--quiet", root], {
    env: fixtureGitEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(init.exitCode).toBe(0);
  for (const suite of FIXTURE_SUITES) {
    await mkdir(join(root, suite.root), { recursive: true });
  }
  for (const file of opts.files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "");
  }
  if (opts.gitignore) {
    await writeFile(join(root, ".gitignore"), opts.gitignore);
  }
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, DURATION_TABLE_PATH),
    formatDurationTable({ source: "fixture", seconds: opts.durations ?? {} })
  );
  return root;
}

function expectExactPartition(opts: {
  readonly shards: readonly (readonly string[])[];
  readonly files: readonly string[];
}): void {
  const flattened = opts.shards.flat();
  expect(new Set(flattened).size).toBe(flattened.length);
  expect([...flattened].sort()).toEqual([...opts.files].sort());
}

function load(opts: {
  readonly shard: readonly string[];
  readonly durations: Record<string, number>;
}): number {
  return opts.shard.reduce(
    (total, file) =>
      total + plannedSeconds({ file, durations: opts.durations }),
    0
  );
}

describe("test shard selection", () => {
  test("parses only 1 <= i <= n <= 32", () => {
    expect(parseShardSelection("1/4")).toEqual({ index: 1, count: 4 });
    expect(parseShardSelection("4/4")).toEqual({ index: 4, count: 4 });
    expect(parseShardSelection(`1/${MAX_TEST_SHARD_COUNT}`)).toEqual({
      index: 1,
      count: MAX_TEST_SHARD_COUNT,
    });
    for (const invalid of [
      "",
      "1",
      "0/4",
      "5/4",
      "1/0",
      "01/4",
      "-1/4",
      "1/33",
      "1/4 ",
      "a/b",
    ]) {
      expect(parseShardSelection(invalid)).toBeNull();
    }
  });

  test("recognizes Bun test-file names outside node_modules and hidden directories", () => {
    for (const path of [
      "tests/a.test.ts",
      "tests/sub/b_test.tsx",
      "tests/c.spec.js",
      "tests/d_spec.mjs",
      "packages/db/tests/smoke.test.ts",
    ]) {
      expect(isTestFilePath(path)).toBe(true);
    }
    for (const path of [
      "tests/helpers/env.ts",
      "tests/a.test.ts.snap",
      "tests/fixtures/data.json",
      "packages/db/node_modules/zod/a.test.ts",
      "tests/.cache/a.test.ts",
    ]) {
      expect(isTestFilePath(path)).toBe(false);
    }
  });

  test("assigns each file to exactly one suite", () => {
    expect(suiteForFile("tests/a.test.ts", FIXTURE_SUITES).id).toBe("cli");
    expect(
      suiteForFile("packages/db/tests/smoke.test.ts", FIXTURE_SUITES).id
    ).toBe("db");
    expect(() => suiteForFile("src/a.test.ts", FIXTURE_SUITES)).toThrow(
      "must belong to exactly one test suite, found 0"
    );
  });
});

describe("test shard partition", () => {
  const files = Array.from(
    { length: 40 },
    (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`
  );
  const durations: Record<string, number> = {
    "tests/f00.test.ts": 300,
    "tests/f01.test.ts": 290,
    "tests/f02.test.ts": 120,
    "tests/f03.test.ts": 110,
  };

  test("splits files into disjoint shards whose union is the full set, deterministically", () => {
    for (let count = 1; count <= 6; count += 1) {
      const shards = partitionTestFiles({ files, count, durations });
      expect(shards).toHaveLength(count);
      expectExactPartition({ shards, files });
      expect(
        partitionTestFiles({ files: [...files].reverse(), count, durations })
      ).toEqual(shards);
      for (const shard of shards) {
        expect([...shard]).toEqual([...shard].sort());
      }
    }
  });

  test("puts the longest files on separate shards", () => {
    const shards = partitionTestFiles({ files, count: 4, durations });
    for (const long of [
      "tests/f00.test.ts",
      "tests/f01.test.ts",
      "tests/f02.test.ts",
      "tests/f03.test.ts",
    ]) {
      expect(shards.filter((shard) => shard.includes(long))).toHaveLength(1);
    }
    expect(
      shards.filter(
        (shard) =>
          shard.includes("tests/f00.test.ts") ||
          shard.includes("tests/f01.test.ts")
      )
    ).toHaveLength(2);
  });

  test("spreads files recorded at zero seconds instead of stacking them on one shard", () => {
    const zero: Record<string, number> = {};
    for (const file of files) {
      zero[file] = 0;
    }
    const shards = partitionTestFiles({ files, count: 4, durations: zero });
    expect(shards.map((shard) => shard.length)).toEqual([10, 10, 10, 10]);
  });

  test("plans a file without a recorded duration at the default", () => {
    expect(plannedSeconds({ file: "tests/new.test.ts", durations })).toBe(
      DEFAULT_FILE_SECONDS + PER_FILE_START_SECONDS
    );
    expect(plannedSeconds({ file: "tests/f00.test.ts", durations })).toBe(
      300 + PER_FILE_START_SECONDS
    );
    const withNew = [...files, "tests/new.test.ts"];
    expectExactPartition({
      shards: partitionTestFiles({ files: withNew, count: 3, durations }),
      files: withNew,
    });
  });

  test("balances the planned load within the longest file", () => {
    const shards = partitionTestFiles({ files, count: 3, durations });
    const loads = shards.map((shard) => load({ shard, durations }));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(
      300 + PER_FILE_START_SECONDS
    );
  });

  test("refuses duplicate paths and out-of-range counts", () => {
    expect(() =>
      partitionTestFiles({
        files: ["tests/a.test.ts", "tests/a.test.ts"],
        count: 2,
        durations,
      })
    ).toThrow("must be unique");
    for (const count of [0, 33, 1.5, Number.NaN]) {
      expect(() => partitionTestFiles({ files, count, durations })).toThrow(
        "shard count must be an integer"
      );
    }
  });
});

describe("test shard coverage check", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];

  test("accepts an exact cover", () => {
    expect(() =>
      assertShardCoverage({
        expected: files,
        shards: [["tests/a.test.ts"], ["tests/b.test.ts", "tests/c.test.ts"]],
      })
    ).not.toThrow();
  });

  test("mutation: a dropped file fails and is named", () => {
    const shards = [["tests/a.test.ts"], ["tests/c.test.ts"]];
    expect(shardCoverage({ expected: files, shards }).missing).toEqual([
      "tests/b.test.ts",
    ]);
    expect(() => assertShardCoverage({ expected: files, shards })).toThrow(
      "not run by any shard (1):\n  tests/b.test.ts"
    );
  });

  test("mutation: a file in two shards fails and is named", () => {
    const shards = [
      ["tests/a.test.ts", "tests/b.test.ts"],
      ["tests/b.test.ts", "tests/c.test.ts"],
    ];
    expect(() => assertShardCoverage({ expected: files, shards })).toThrow(
      "run by more than one shard (1):\n  tests/b.test.ts"
    );
  });

  test("mutation: a file outside the full set fails and is named", () => {
    const shards = [
      ["tests/a.test.ts", "tests/b.test.ts"],
      ["tests/c.test.ts", "tests/z.test.ts"],
    ];
    expect(() => assertShardCoverage({ expected: files, shards })).toThrow(
      "run by a shard but not in the full test set (1):\n  tests/z.test.ts"
    );
  });

  test("a verified plan covers a fixture checkout's git test files exactly once", async () => {
    const root = await fixtureRepo({
      files: [
        "tests/a.test.ts",
        "tests/sub/b.test.ts",
        "tests/helper.ts",
        "packages/db/tests/smoke.test.ts",
        "packages/db/node_modules/dep/x.test.ts",
      ],
      gitignore: "node_modules/\n",
      durations: { "tests/a.test.ts": 10 },
    });
    const plan = await buildVerifiedPlan({
      repoRoot: root,
      count: 2,
      suites: FIXTURE_SUITES,
    });
    expect(plan.files).toEqual([
      "packages/db/tests/smoke.test.ts",
      "tests/a.test.ts",
      "tests/sub/b.test.ts",
    ]);
    expect(
      listGitTestFiles({ repoRoot: root, suites: FIXTURE_SUITES })
    ).toEqual([...plan.files]);
    expectExactPartition({ shards: plan.shards, files: plan.files });
  });

  test("mutation: a partition that drops a file fails the verified plan", async () => {
    const root = await fixtureRepo({
      files: ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"],
    });
    await expect(
      buildVerifiedPlan({
        repoRoot: root,
        count: 2,
        suites: FIXTURE_SUITES,
        partition: (opts) =>
          partitionTestFiles({ ...opts, files: opts.files.slice(0, -1) }),
      })
    ).rejects.toThrow("not run by any shard (1):\n  tests/c.test.ts");
  });

  test("mutation: a test file that git does not list fails the verified plan", async () => {
    const root = await fixtureRepo({
      files: ["tests/a.test.ts", "tests/ignored/b.test.ts"],
      gitignore: "tests/ignored/\n",
    });
    await expect(
      buildVerifiedPlan({ repoRoot: root, count: 1, suites: FIXTURE_SUITES })
    ).rejects.toThrow(
      "found on disk but not listed by git (1):\n  tests/ignored/b.test.ts"
    );
  });

  test("the current checkout's four CI shards cover every git test file exactly once", async () => {
    const tracked = listGitTestFiles({ repoRoot });
    expect(tracked).toContain("tests/test-shard.test.ts");
    expect(tracked).toContain("packages/db/tests/smoke.test.ts");
    const plan = await buildVerifiedPlan({ repoRoot, count: 4 });
    expect(plan.files).toEqual(tracked);
    expectExactPartition({ shards: plan.shards, files: tracked });
    for (const shard of plan.shards) {
      expect(shard.length).toBeGreaterThan(0);
    }
  });

  test("refuses a missing suite root instead of planning it as empty", async () => {
    const root = await fixtureRepo({ files: ["tests/a.test.ts"] });
    await rm(join(root, "packages", "db"), { recursive: true });
    await expect(
      buildVerifiedPlan({ repoRoot: root, count: 1, suites: FIXTURE_SUITES })
    ).rejects.toThrow("the db suite root packages/db is not a directory");
  });

  test("refuses a workspace test script the shard suites do not cover", async () => {
    const root = await fixtureRepo({ files: [] });
    await writeFile(join(root, "bunfig.toml"), '[test]\nroot = "./tests"\n');
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] })
    );
    for (const name of ["cli", "db"]) {
      await mkdir(join(root, "packages", name), { recursive: true });
      await writeFile(
        join(root, "packages", name, "package.json"),
        JSON.stringify({ scripts: { test: "bun test" } })
      );
    }
    await expect(
      assertSuiteInputs({ repoRoot: root })
    ).resolves.toBeUndefined();
    await mkdir(join(root, "packages", "extra"), { recursive: true });
    await writeFile(
      join(root, "packages", "extra", "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } })
    );
    await expect(assertSuiteInputs({ repoRoot: root })).rejects.toThrow(
      "Turbo runs test scripts in [packages/cli, packages/db, packages/extra]"
    );
    await rm(join(root, "packages", "extra"), { recursive: true });
    await writeFile(join(root, "bunfig.toml"), '[test]\nroot = "./spec"\n');
    await expect(assertSuiteInputs({ repoRoot: root })).rejects.toThrow(
      "[test].root must be ./tests"
    );
  });
});

describe("pooled layout and focused runs (HACK-1960)", () => {
  async function sourceRepo(sources: Record<string, string>): Promise<string> {
    const root = await fixtureRepo({ files: Object.keys(sources) });
    for (const [path, text] of Object.entries(sources)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return root;
  }

  test("parses layouts and focus lists, refusing anything else", () => {
    expect(parseTestLayout(undefined)).toBe("full");
    expect(parseTestLayout("full")).toBe("full");
    expect(parseTestLayout("pooled")).toBe("pooled");
    for (const invalid of ["", "Pooled", "macos", "pooled,full"]) {
      expect(() => parseTestLayout(invalid)).toThrow(
        "--layout must be full or pooled"
      );
    }
    expect(parseTestFocus("docs")).toEqual(["docs"]);
    expect(parseTestFocus("runtime-core,docs")).toEqual([
      "docs",
      "runtime-core",
    ]);
    for (const invalid of [
      "",
      "docs,",
      "docs,docs",
      "rust",
      "docs runtime-core",
    ]) {
      expect(() => parseTestFocus(invalid)).toThrow("--focus must list");
    }
  });

  test("maps global shards to the macOS pool first, then the Linux pool", () => {
    const count = 8;
    const mapped = Array.from({ length: count }, (_, i) =>
      pooledSelection({ index: i + 1, count })
    );
    expect(mapped.map((entry): string => entry.pool)).toEqual([
      ...Array.from({ length: POOLED_MACOS_SHARDS }, () => "macos"),
      ...Array.from({ length: count - POOLED_MACOS_SHARDS }, () => "linux"),
    ]);
    // Every pool-local index 1..n appears exactly once.
    for (const pool of ["macos", "linux"] as const) {
      const local = mapped.filter((entry) => entry.pool === pool);
      expect(local.map((entry) => entry.selection.index)).toEqual(
        Array.from({ length: local.length }, (_, i) => i + 1)
      );
      for (const entry of local) {
        expect(entry.selection.count).toBe(local.length);
      }
    }
    expect(poolPlatform("macos")).toBe("darwin");
    expect(poolPlatform("linux")).toBe("linux");
    expect(() =>
      pooledSelection({ index: 1, count: POOLED_MACOS_SHARDS })
    ).toThrow("needs more than");
  });

  test("keeps platform-sensitive files, directly or through test helpers, in the macOS pool", async () => {
    const root = await sourceRepo({
      "tests/direct.test.ts":
        'test.skipIf(process.platform !== "darwin")("x", () => {});\n',
      "tests/indirect.test.ts": 'import { lsofRows } from "./helpers/lsof";\n',
      "tests/helpers/lsof.ts": 'export const lsofRows = ["lsof", "-nP"];\n',
      "tests/product.test.ts": 'import { x } from "../src/x.ts";\n',
      "src/x.ts": "export const x = process.platform;\n",
      "tests/plain.test.ts": 'import { expect, test } from "bun:test";\n',
      "packages/db/tests/smoke.test.ts": "",
    });
    const macos = await buildVerifiedPlan({
      repoRoot: root,
      count: 1,
      suites: FIXTURE_SUITES,
      pool: "macos",
    });
    const linux = await buildVerifiedPlan({
      repoRoot: root,
      count: 2,
      suites: FIXTURE_SUITES,
      pool: "linux",
    });
    expect(macos.scope).toEqual([
      "tests/direct.test.ts",
      "tests/indirect.test.ts",
    ]);
    // Product code is not read: the test decides what it observes.
    expect(linux.scope).toEqual([
      "packages/db/tests/smoke.test.ts",
      "tests/plain.test.ts",
      "tests/product.test.ts",
    ]);
    expectExactPartition({ shards: linux.shards, files: linux.scope });
    // An explicit entry moves a file the pattern misses.
    const pinned = await buildVerifiedPlan({
      repoRoot: root,
      count: 1,
      suites: FIXTURE_SUITES,
      pool: "macos",
      macosFiles: { "tests/plain.test.ts": "fixture reason" },
    });
    expect(pinned.scope).toContain("tests/plain.test.ts");
  });

  test("focus selects files naming the sources directly, through helpers or scripts, not scenario fixtures", async () => {
    const root = await sourceRepo({
      "tests/cli-docs.test.ts": 'const path = "docs/reference/cli.md";\n',
      "tests/helper-docs.test.ts": 'import { links } from "./helpers/links";\n',
      "tests/helpers/links.ts": 'export const links = ["README.md"];\n',
      "tests/script-docs.test.ts": 'import { gen } from "../scripts/gen.ts";\n',
      "scripts/gen.ts": 'export const gen = join(root, "docs", "x.md");\n',
      "tests/scenario.test.ts": 'import { fixture } from "./e2e/fixture";\n',
      "tests/e2e/fixture.ts": 'export const fixture = "README.md";\n',
      "tests/core.test.ts":
        'const source = "packages/runtime-core/src/x.rs";\n',
      "tests/plain.test.ts": "",
    });
    const docs = await buildVerifiedPlan({
      repoRoot: root,
      count: 1,
      suites: FIXTURE_SUITES,
      focus: ["docs"],
    });
    expect(docs.scope).toEqual([
      "tests/cli-docs.test.ts",
      "tests/helper-docs.test.ts",
      "tests/script-docs.test.ts",
    ]);
    const both = await buildVerifiedPlan({
      repoRoot: root,
      count: 1,
      suites: FIXTURE_SUITES,
      focus: ["docs", "runtime-core"],
    });
    expect(both.scope).toEqual([...docs.scope, "tests/core.test.ts"].sort());
    await expect(
      buildVerifiedPlan({
        repoRoot: root,
        count: 1,
        suites: FIXTURE_SUITES,
        focus: ["docs"],
        pool: "linux",
      })
    ).rejects.toThrow("a pool and a focus cannot combine");
  });

  test("an import cycle between helpers terminates", async () => {
    const root = await sourceRepo({
      "tests/a.test.ts": 'import "./helpers/a";\n',
      "tests/helpers/a.ts": 'import "./b";\n',
      "tests/helpers/b.ts": 'import "./a";\n',
    });
    expect(
      await testSourceMatches({
        repoRoot: root,
        file: "tests/a.test.ts",
        pattern: /darwin/,
      })
    ).toBe(false);
  });

  test("the current checkout's CI pools partition every git test file exactly once", async () => {
    const tracked = listGitTestFiles({ repoRoot });
    const count = 8;
    const macos = pooledSelection({ index: 1, count });
    const linux = pooledSelection({ index: count, count });
    const macosPlan = await buildVerifiedPlan({
      repoRoot,
      count: macos.selection.count,
      pool: "macos",
    });
    const linuxPlan = await buildVerifiedPlan({
      repoRoot,
      count: linux.selection.count,
      pool: "linux",
    });
    expect(linuxPlan.scope).toContain("tests/tmux-private-input.test.ts");
    expect(macosPlan.scope).not.toContain("tests/tmux-private-input.test.ts");
    expectExactPartition({
      shards: [...macosPlan.shards, ...linuxPlan.shards],
      files: tracked,
    });
    for (const shard of [...macosPlan.shards, ...linuxPlan.shards]) {
      expect(shard.length).toBeGreaterThan(0);
    }
    // The darwin-gated suites stay on macOS.
    for (const file of [
      "tests/global-command.macos.test.ts",
      "tests/native-authored-process-census.test.ts",
    ]) {
      expect(macosPlan.scope).toContain(file);
    }
  });
});

describe("test shard duration table", () => {
  test("round-trips and refuses malformed tables", () => {
    const text = formatDurationTable({
      source: "fixture",
      seconds: { "tests/b.test.ts": 1.26, "tests/a.test.ts": 3 },
    });
    expect(parseDurationTable(text)).toEqual({
      "tests/a.test.ts": 3,
      "tests/b.test.ts": 1.3,
    });
    for (const bad of [
      "not json",
      "{}",
      JSON.stringify({ schema: "other", seconds: {} }),
      JSON.stringify({
        schema: "hack.test-shard-durations.v1",
        seconds: { "tests/a.test.ts": -1 },
      }),
      JSON.stringify({
        schema: "hack.test-shard-durations.v1",
        seconds: { "tests/a.ts": 1 },
      }),
    ]) {
      expect(() => parseDurationTable(bad)).toThrow("test shard:");
    }
  });

  test("the checked-in table parses and names only existing test files", async () => {
    const table = parseDurationTable(
      await Bun.file(resolve(repoRoot, DURATION_TABLE_PATH)).text()
    );
    const tracked = new Set(listGitTestFiles({ repoRoot }));
    expect(Object.keys(table).filter((file) => !tracked.has(file))).toEqual([]);
  });

  test("merging keeps later measurements and drops deleted files", () => {
    const merged = parseDurationTable(
      mergeDurationTables({
        source: "fixture",
        table: { "tests/a.test.ts": 1, "tests/gone.test.ts": 9 },
        measured: [{ "tests/a.test.ts": 2 }, { "tests/b.test.ts": 4 }],
        files: ["tests/a.test.ts", "tests/b.test.ts"],
      })
    );
    expect(merged).toEqual({ "tests/a.test.ts": 2, "tests/b.test.ts": 4 });
  });

  test("measured output keeps finished files only", () => {
    const results: FileResult[] = [
      {
        file: "tests/a.test.ts",
        outcome: "pass",
        seconds: 2.04,
        exitCode: 0,
        filesRan: 1,
      },
      {
        file: "tests/b.test.ts",
        outcome: "fail",
        seconds: 1,
        exitCode: 1,
        filesRan: 1,
      },
      {
        file: "tests/c.test.ts",
        outcome: "timeout",
        seconds: 720,
        exitCode: null,
        filesRan: null,
      },
    ];
    expect(
      parseDurationTable(measuredDurations({ label: "fixture", results }))
    ).toEqual({
      "tests/a.test.ts": 2,
      "tests/b.test.ts": 1,
    });
  });
});

function shardState(files: readonly string[]): ShardState {
  return {
    label: "[test shard 1/1]",
    files,
    results: [],
    current: null,
    startedAt: Date.now(),
  };
}

const passRun: RunFile = async () => ({
  exitCode: 0,
  filesRan: 1,
  stopped: false,
});

function hangingRun(hang: ReadonlySet<string>): RunFile {
  return ({ file, signal }) => {
    if (!hang.has(file)) {
      return passRun({ file, signal });
    }
    return new Promise((done) => {
      signal.addEventListener(
        "abort",
        () => done({ exitCode: null, filesRan: null, stopped: true }),
        { once: true }
      );
    });
  };
}

async function runFixture(opts: {
  readonly files: readonly string[];
  readonly runFile: RunFile;
  readonly fileTimeoutMs?: number | ((file: string) => number);
  readonly deadlineMs?: number;
  readonly interrupt?: AbortSignal;
}) {
  const state = shardState(opts.files);
  const lines: string[] = [];
  const ended = await runShardFiles({
    state,
    runFile: opts.runFile,
    fileTimeoutMs: opts.fileTimeoutMs ?? 10_000,
    deadlineAt: state.startedAt + (opts.deadlineMs ?? 60_000),
    heartbeatMs: 10_000,
    interrupt: opts.interrupt ?? new AbortController().signal,
    now: Date.now,
    log: (line) => lines.push(line),
  });
  return { state, lines, ended };
}

describe("test shard runner", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];

  test("the slow activation file has a bounded exception and runs before its shard siblings", () => {
    const slow = "tests/native-compose-storage-activation-command.test.ts";
    expect(
      testFileTimeoutMs({
        file: slow,
        defaultTimeoutMs: 720_000,
        explicit: false,
      })
    ).toBe(1_200_000);
    expect(
      testFileTimeoutMs({
        file: "tests/a.test.ts",
        defaultTimeoutMs: 720_000,
        explicit: false,
      })
    ).toBe(720_000);
    expect(
      testFileTimeoutMs({ file: slow, defaultTimeoutMs: 1000, explicit: true })
    ).toBe(1000);
    expect(
      prioritizeSlowFiles(["tests/a.test.ts", slow, "tests/b.test.ts"])
    ).toEqual([slow, "tests/a.test.ts", "tests/b.test.ts"]);
  });

  test("per-file budgets change the enforced timer while the shard deadline still wins", async () => {
    const delayed: RunFile = ({ signal }) =>
      new Promise((resolve) => {
        const done = setTimeout(
          () => resolve({ exitCode: 0, filesRan: 1, stopped: false }),
          100
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(done);
            resolve({ exitCode: null, filesRan: null, stopped: true });
          },
          { once: true }
        );
      });
    const { state } = await runFixture({
      files: ["tests/a.test.ts", "tests/b.test.ts"],
      runFile: delayed,
      fileTimeoutMs: (file) => (file === files[0] ? 20 : 1000),
    });
    expect(state.results.map((result) => result.outcome)).toEqual([
      "timeout",
      "pass",
    ]);
    const deadline = await runFixture({
      files: ["tests/a.test.ts"],
      runFile: delayed,
      fileTimeoutMs: () => 1000,
      deadlineMs: 20,
    });
    expect(deadline.ended).toBe("deadline");
    expect(deadline.state.results[0]?.outcome).toBe("deadline");
  });

  test("deferred file summary names the selected macOS evidence gap", () => {
    const macos = "tests/native-authored-project-start.test.ts";
    const summary = deferredMacosSummary([macos]);
    expect(summary).toContain("deferred to the integration run");
    expect(summary).toContain(macos);
    expect(summary).toContain("1 selected");
    expect(summary).not.toContain("packages/db/tests/smoke.test.ts");
  });

  test("prints a start and a result line naming each file", async () => {
    const { state, lines, ended } = await runFixture({
      files,
      runFile: passRun,
    });
    expect(ended).toBe("complete");
    expect(state.results.map((result) => result.outcome)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(lines[0]).toBe("[test shard 1/1] (1/3) start tests/a.test.ts");
    expect(lines[1]).toStartWith(
      "[test shard 1/1] (1/3) PASS tests/a.test.ts in "
    );
    expect(lines).toHaveLength(6);
  });

  test("a file that outlives its timeout is stopped, named and the shard continues", async () => {
    const { state, ended } = await runFixture({
      files,
      runFile: hangingRun(new Set(["tests/b.test.ts"])),
      fileTimeoutMs: 50,
    });
    expect(ended).toBe("complete");
    expect(
      state.results.map((result) => [result.file, result.outcome])
    ).toEqual([
      ["tests/a.test.ts", "pass"],
      ["tests/b.test.ts", "timeout"],
      ["tests/c.test.ts", "pass"],
    ]);
    expect(summaryReport(state, Date.now()).join("\n")).toContain(
      "timeout     tests/b.test.ts (exit none, files reported none"
    );
  });

  test("the shard deadline stops the running file and leaves the rest unstarted", async () => {
    const { state, ended } = await runFixture({
      files,
      runFile: hangingRun(new Set(["tests/b.test.ts"])),
      deadlineMs: 100,
    });
    expect(ended).toBe("deadline");
    expect(
      state.results.map((result) => [result.file, result.outcome])
    ).toEqual([
      ["tests/a.test.ts", "pass"],
      ["tests/b.test.ts", "deadline"],
    ]);
  });

  test("an interrupt stops the running file", async () => {
    const interrupt = new AbortController();
    setTimeout(() => interrupt.abort(), 50);
    const { state, ended } = await runFixture({
      files,
      runFile: hangingRun(new Set(["tests/a.test.ts"])),
      interrupt: interrupt.signal,
    });
    expect(ended).toBe("interrupted");
    expect(state.results.map((result) => result.outcome)).toEqual([
      "interrupted",
    ]);
  });

  test("the stop report names the running file, the unstarted files and the slowest files", () => {
    const state = shardState(files);
    state.results.push({
      file: "tests/a.test.ts",
      outcome: "pass",
      seconds: 42,
      exitCode: 0,
      filesRan: 1,
    });
    state.current = { file: "tests/b.test.ts", startedAt: state.startedAt };
    const report = stopReport({
      state,
      reason: "received SIGTERM",
      now: state.startedAt + 125_000,
    }).join("\n");
    expect(report).toContain(
      "[test shard 1/1] stopped (received SIGTERM) after 2m05s; 1/3 files finished."
    );
    expect(report).toContain(
      "[test shard 1/1] running file: tests/b.test.ts (2m05s)"
    );
    expect(report).toContain(
      "[test shard 1/1] not started (1):\n  tests/c.test.ts"
    );
    expect(report).toContain(
      "[test shard 1/1] slowest files:\n    42.0s  pass        tests/a.test.ts"
    );
  });

  test("a pass needs exit 0 and exactly one file reported by Bun", () => {
    expect(
      classifyFileRun({
        run: { exitCode: 0, filesRan: 1, stopped: false },
        stopReason: null,
      })
    ).toBe("pass");
    expect(
      classifyFileRun({
        run: { exitCode: 1, filesRan: 1, stopped: false },
        stopReason: null,
      })
    ).toBe("fail");
    for (const filesRan of [0, 2, null]) {
      expect(
        classifyFileRun({
          run: { exitCode: 0, filesRan, stopped: false },
          stopReason: null,
        })
      ).toBe("file-count");
    }
    expect(
      classifyFileRun({
        run: { exitCode: null, filesRan: null, stopped: true },
        stopReason: "timeout",
      })
    ).toBe("timeout");
  });

  test("reads the file count from Bun's last summary line", () => {
    expect(
      bunFilesRan(" 5 pass\nRan 5 tests across 1 file. [142.00ms]\n")
    ).toBe(1);
    expect(
      bunFilesRan("Ran 1 test across 1 file.\nRan 7 tests across 2 files. [1s]")
    ).toBe(2);
    expect(bunFilesRan("error: something failed\n")).toBeNull();
  });

  test("formats durations", () => {
    expect(formatDuration(0.04)).toBe("0.0s");
    expect(formatDuration(12.34)).toBe("12.3s");
    expect(formatDuration(59.96)).toBe("1m00s");
    expect(formatDuration(725)).toBe("12m05s");
  });
});

type Workflow = {
  readonly jobs: Record<
    string,
    {
      readonly name?: string;
      readonly needs?: string | readonly string[];
      readonly if?: string;
      readonly "runs-on"?: string;
      readonly "timeout-minutes"?: number;
      readonly strategy?: {
        readonly "fail-fast"?: boolean;
        readonly matrix?: { readonly shard?: readonly number[] | string };
      };
      readonly steps: readonly {
        readonly name?: string;
        readonly if?: string;
        readonly run?: string;
        readonly uses?: string;
        readonly env?: Record<string, string>;
      }[];
    }
  >;
};

async function ciWorkflow(): Promise<Workflow> {
  return Bun.YAML.parse(
    await Bun.file(resolve(repoRoot, ".github/workflows/ci.yml")).text()
  ) as Workflow;
}

describe("test shard per-file bun test process", () => {
  async function bunFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "hack-test-shard-bun-"));
    owned.push(root);
    const files: Record<string, string> = {
      "tests/pass.test.ts":
        'import { expect, test } from "bun:test";\ntest("passes", () => expect(1).toBe(1));\n',
      "tests/fail.test.ts":
        'import { expect, test } from "bun:test";\ntest("fails", () => expect(1).toBe(2));\n',
      "tests/hang.test.ts":
        'import { test } from "bun:test";\ntest("hangs", () => new Promise(() => undefined), 60_000);\n',
      // A background writer that keeps the stderr pipe open after Bun exits.
      "tests/writer.test.ts":
        'import { test } from "bun:test";\ntest("leaves a writer", () => { Bun.spawn(["sh", "-c", "sleep 6; echo late >&2"], { stdio: ["ignore", "ignore", "inherit"] }).unref(); });\n',
      "packages/db/tests/cwd.test.ts":
        'import { expect, test } from "bun:test";\ntest("runs in the suite directory", () => expect(process.cwd().endsWith("/packages/db")).toBe(true));\n',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return root;
  }

  async function suitePreloadFixture(rejectingSuite?: string): Promise<string> {
    const root = await bunFixture();
    for (const suite of FIXTURE_SUITES) {
      const cwd = join(root, suite.cwd);
      await writeFile(
        join(cwd, "bunfig.toml"),
        '[test]\npreload = ["./preload.ts"]\n'
      );
      await writeFile(
        join(cwd, "preload.ts"),
        [
          'import { afterEach } from "bun:test";',
          'import { writeFileSync } from "node:fs";',
          `globalThis[Symbol.for("suite-preload")] = "${suite.id}";`,
          "afterEach(() => {",
          `  writeFileSync(new URL("./guard-receipt", import.meta.url), "${suite.id}");`,
          suite.id === rejectingSuite
            ? '  throw new Error("fixture preload guard failed");'
            : "",
          "});",
        ].join("\n")
      );
      await writeFile(
        join(cwd, "tests/preload.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          'import { writeFileSync } from "node:fs";',
          'test("suite preload ran before the test", () => {',
          `  expect(globalThis[Symbol.for("suite-preload")]).toBe("${suite.id}");`,
          '  writeFileSync(new URL("./body-receipt", import.meta.url), "passed");',
          "});",
        ].join("\n")
      );
    }
    return root;
  }

  for (const suite of FIXTURE_SUITES) {
    for (const rejects of [false, true]) {
      test(`${suite.id} suite preload ${rejects ? "guard failure fails the file" : "runs before the test and after its body"}`, async () => {
        const root = await suitePreloadFixture(rejects ? suite.id : undefined);
        const file = join(suite.cwd, "tests/preload.test.ts");
        const { state, ended } = await runFixture({
          files: [file],
          runFile: bunTestFile({
            repoRoot: root,
            suites: FIXTURE_SUITES,
            quiet: true,
          }),
        });
        // The assertion in the body must pass before a teardown failure counts.
        expect(
          await Bun.file(join(root, suite.cwd, "tests/body-receipt")).text()
        ).toBe("passed");
        expect(
          await Bun.file(join(root, suite.cwd, "guard-receipt")).text()
        ).toBe(suite.id);
        expect(ended).toBe("complete");
        expect(state.results).toHaveLength(1);
        expect(state.results[0]).toMatchObject({
          file,
          outcome: rejects ? "fail" : "pass",
          exitCode: rejects ? 1 : 0,
          filesRan: 1,
        });
      }, 30_000);
    }
  }

  test("reports exit status and exactly one file from the suite directory", async () => {
    const root = await bunFixture();
    const run = bunTestFile({
      repoRoot: root,
      suites: FIXTURE_SUITES,
      quiet: true,
    });
    const signal = new AbortController().signal;
    expect(await run({ file: "tests/pass.test.ts", signal })).toEqual({
      exitCode: 0,
      filesRan: 1,
      stopped: false,
    });
    expect(
      await run({ file: "packages/db/tests/cwd.test.ts", signal })
    ).toEqual({
      exitCode: 0,
      filesRan: 1,
      stopped: false,
    });
    const failed = await run({ file: "tests/fail.test.ts", signal });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stopped).toBe(false);
  }, 30_000);

  test("stops a hung file when its signal aborts", async () => {
    const root = await bunFixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1000);
    const startedAt = Date.now();
    const run = await bunTestFile({
      repoRoot: root,
      suites: FIXTURE_SUITES,
      quiet: true,
    })({
      file: "tests/hang.test.ts",
      signal: controller.signal,
    });
    expect(run).toEqual({ exitCode: null, filesRan: null, stopped: true });
    expect(Date.now() - startedAt).toBeLessThan(8000);
  }, 30_000);

  test("does not wait for a leftover process that holds stderr open", async () => {
    const root = await bunFixture();
    const startedAt = Date.now();
    const run = await bunTestFile({
      repoRoot: root,
      suites: FIXTURE_SUITES,
      quiet: true,
    })({
      file: "tests/writer.test.ts",
      signal: new AbortController().signal,
    });
    expect(run.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5500);
  }, 30_000);
});

describe("hosted test CI fan-in", () => {
  test("light planning executes only the Linux portion and reports the selected macOS files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hack-ci-deferred-"));
    owned.push(root);
    const linux = "packages/db/tests/smoke.test.ts";
    const macos = "tests/native-authored-project-start.test.ts";
    const env = {
      ...process.env,
      HACK_TEST_SELECTION: JSON.stringify([linux, macos]),
      HACK_TEST_DRAFT: "true",
      HACK_TEST_DEFER_MACOS: "true",
      GITHUB_STEP_SUMMARY: join(root, "summary"),
    };
    const files: string[] = [];
    for (let index = 4; index <= 8; index++) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "scripts/test-shard.ts",
          "plan",
          `--shard=${index}/8`,
          "--layout=pooled",
        ],
        { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" }
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      files.push(...child.stdout.toString().trim().split("\n").filter(Boolean));
    }
    expect(files).toEqual([linux]);
    const report = Bun.spawnSync(
      [process.execPath, "scripts/test-shard.ts", "report-deferred"],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(report.exitCode, report.stderr.toString()).toBe(0);
    const summary = await Bun.file(env.GITHUB_STEP_SUMMARY).text();
    expect(summary).toContain(macos);
    expect(summary).not.toContain(linux);
    expect(summary).toContain("deferred to the integration run");
    const wrong = Bun.spawnSync(
      [
        process.execPath,
        "scripts/test-shard.ts",
        "plan",
        "--shard=1/8",
        "--layout=pooled",
      ],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" }
    );
    expect(wrong.exitCode).toBe(2);
  }, 30_000);
  test("the shard matrix covers 1..n, keeps the suite setup and runs its own slice", async () => {
    const shardJob = (await ciWorkflow()).jobs["test-shard"];
    expect(shardJob?.strategy?.matrix?.shard).toBe(
      "${{ fromJSON(needs.changes.outputs.test_shards) }}"
    );
    const matrix: number[] = JSON.parse(fullPushPlan().test_shards);
    const count = matrix.length;
    expect(count).toBeGreaterThan(POOLED_MACOS_SHARDS);
    expect(matrix).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(shardJob?.strategy?.["fail-fast"]).toBe(false);
    expect(shardJob?.name).toBe(`test shard \${{ matrix.shard }}/${count}`);
    expect(shardJob?.needs).toBe("changes");
    expect(shardJob?.if).toBe("${{ needs.changes.outputs.suite == 'true' }}");
    // Full layout: every shard on macOS. Pooled: the macOS pool's shards on
    // macOS, the rest on Linux; the runner refuses a shard on the wrong host.
    expect(shardJob?.["runs-on"]).toBe(
      `\${{ (needs.changes.outputs.draft == 'true' || (needs.changes.outputs.test_layout == 'pooled' && matrix.shard > ${POOLED_MACOS_SHARDS})) && 'ubuntu-latest' || 'macos-15' }}`
    );
    expect(shardJob?.["timeout-minutes"]).toBeLessThan(60);
    const steps = shardJob?.steps ?? [];
    const reportIndex = steps.findIndex(
      (step) => step.run === "bun scripts/test-shard.ts report-deferred"
    );
    expect(reportIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeLessThan(
      steps.findIndex((step) => step.name === "Typecheck (Turbo)")
    );
    expect(steps[reportIndex]?.if).toBe(
      "matrix.shard == 8 && needs.changes.outputs.defer_macos == 'true'"
    );
    for (const name of ["Build CLI", "Build release smoke (no tests)"]) {
      expect(steps.find((step) => step.name === name)?.if).toBe(
        "matrix.shard == 8 && needs.changes.outputs.build_smoke == 'true'"
      );
    }
    const run = steps.find((step) => step.name === "Tests (shard)");
    expect(run?.env?.HACK_TEST_SHARD).toBe(`\${{ matrix.shard }}/${count}`);
    expect(run?.env?.HACK_TEST_LAYOUT).toBe(
      "${{ needs.changes.outputs.test_layout }}"
    );
    expect(run?.run).toContain(
      'bun scripts/test-shard.ts run --shard="$HACK_TEST_SHARD" --layout="$HACK_TEST_LAYOUT"'
    );
    const commands = steps.map((step) => step.run ?? step.uses ?? "");
    expect(commands.indexOf("bun run build:config-compiler")).toBeLessThan(
      steps.findIndex((step) => step.name === "Tests (shard)")
    );
    for (const command of [
      "bun install --frozen-lockfile",
      "bun run turbo:typecheck",
      "bun run privacy:check",
      "bun run turbo:check",
      "bun run build",
    ]) {
      expect(commands).toContain(command);
    }
    const plan = await buildVerifiedPlan({ repoRoot, count });
    expect(plan.shards).toHaveLength(count);
    for (let index = 1; index <= count; index += 1) {
      const pooled = pooledSelection({ index, count });
      expect(pooled.pool).toBe(
        index <= POOLED_MACOS_SHARDS ? "macos" : "linux"
      );
    }
  });

  test("the focus job always reports and runs only for a focused scope", async () => {
    const focus = (await ciWorkflow()).jobs["test-focus"];
    expect(focus?.name).toBe("test focus");
    expect(focus?.needs).toBe("changes");
    // No job-level condition: a push run must show it as a success, not a skip.
    expect(focus?.if).toBeUndefined();
    const steps = focus?.steps ?? [];
    expect(steps[0]?.if).toBeUndefined();
    for (const step of steps.slice(1)) {
      expect(step.if).toBe("${{ needs.changes.outputs.test_focus != '' }}");
    }
    const run = steps.find((step) => step.name === "Focused tests");
    expect(run?.run).toBe(
      'bun scripts/test-shard.ts run --focus="$TEST_FOCUS"'
    );
    expect(steps.map((step) => step.run ?? "")).toContain(
      "bun run privacy:check"
    );
  });

  test("test gates on the job in scope and rejects incomplete evidence", async () => {
    const workflow = await ciWorkflow();
    const fanIn = workflow.jobs.test;
    expect(fanIn?.name ?? "test").toBe("test");
    expect(fanIn?.needs).toEqual(["changes", "test-shard", "test-focus"]);
    expect(fanIn?.if).toBe("${{ always() }}");
    const gate = fanIn?.steps.find(
      (step) => step.name === "Reject failed or skipped test shards"
    );
    expect(gate?.env?.SHARD_RESULT).toBe("${{ needs.test-shard.result }}");
    expect(gate?.env?.FOCUS_RESULT).toBe("${{ needs.test-focus.result }}");
    expect(gate?.env?.CHANGES_RESULT).toBe("${{ needs.changes.result }}");
    expect(gate?.run).toContain('if [ "$SHARD_RESULT" != "success" ]; then');
    expect(gate?.run).toContain("exit 1");
    if (!gate?.run) {
      throw new Error("Missing aggregate shell gate");
    }
    // [scope result, suite, focus, shard result, focus result, exit code]
    for (const [changes, suite, focus, shards, focused, exitCode] of [
      ["success", "true", "", "success", "success", 0],
      ["success", "true", "", "cancelled", "success", 1],
      ["success", "true", "", "failure", "success", 1],
      ["success", "true", "", "skipped", "success", 1],
      ["success", "true", "", "", "success", 1],
      ["success", "true", "", "unexpected", "success", 1],
      // The no-op focus job must still succeed when the suite runs.
      ["success", "true", "", "success", "skipped", 1],
      ["success", "true", "", "success", "failure", 1],
      // Focused scopes gate on the focus job; skipped shards are expected.
      ["success", "false", "docs", "skipped", "success", 0],
      ["success", "false", "docs", "skipped", "cancelled", 1],
      ["success", "false", "docs", "skipped", "failure", 1],
      ["success", "false", "docs", "skipped", "skipped", 1],
      ["success", "false", "", "skipped", "success", 1],
      ["success", "", "", "skipped", "success", 1],
      // A failed or skipped scope fails closed; cancelled runs fail too.
      ["failure", "", "", "skipped", "skipped", 1],
      ["skipped", "", "", "skipped", "skipped", 1],
      ["", "", "", "skipped", "skipped", 1],
      ["cancelled", "", "", "skipped", "skipped", 1],
    ] as const) {
      const run = Bun.spawnSync(["bash", "-e", "-c", gate.run], {
        env: {
          ...process.env,
          CHANGES_RESULT: changes,
          SCOPE: "fixture",
          SUITE: suite,
          TEST_FOCUS: focus,
          SHARD_RESULT: shards,
          FOCUS_RESULT: focused,
        },
        stdout: "ignore",
        timeout: 5000,
      });
      expect(
        run.exitCode,
        `changes=${changes} suite=${suite} focus=${focus} shards=${shards} focused=${focused}`
      ).toBe(exitCode);
    }
    const named = Object.entries(workflow.jobs).filter(
      ([key, job]) => (job.name ?? key) === "test"
    );
    expect(named.map(([key]) => key)).toEqual(["test"]);
  });

  test("the prerelease gate requires the fan-in and every shard job by name", async () => {
    const count = JSON.parse(fullPushPlan().test_shards).length;
    const required: readonly string[] = CI_JOBS;
    expect(required).toContain("test");
    for (let shard = 1; shard <= count; shard += 1) {
      expect(required).toContain(`test shard ${shard}/${count}`);
    }
    expect(
      required.filter((name) => name.startsWith("test shard "))
    ).toHaveLength(count);
  });
});
