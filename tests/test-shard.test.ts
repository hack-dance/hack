import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CI_JOBS } from "../scripts/prerelease-plan.ts";
import {
  bunFilesRan,
  bunTestFile,
  classifyFileRun,
  type FileResult,
  formatDuration,
  formatDurationTable,
  measuredDurations,
  mergeDurationTables,
  type RunFile,
  runShardFiles,
  type ShardState,
  stopReport,
  summaryReport,
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
  parseDurationTable,
  parseShardSelection,
  partitionTestFiles,
  plannedSeconds,
  shardCoverage,
  suiteForFile,
  type TestSuite,
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
  readonly fileTimeoutMs?: number;
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
        readonly matrix?: { readonly shard?: readonly number[] };
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
  test("the shard matrix covers 1..n, keeps the suite setup and runs its own slice", async () => {
    const shardJob = (await ciWorkflow()).jobs["test-shard"];
    const matrix = shardJob?.strategy?.matrix?.shard ?? [];
    const count = matrix.length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(matrix).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(shardJob?.strategy?.["fail-fast"]).toBe(false);
    expect(shardJob?.name).toBe(`test shard \${{ matrix.shard }}/${count}`);
    expect(shardJob?.["runs-on"]).toBe("blacksmith-6vcpu-macos-15");
    expect(shardJob?.["timeout-minutes"]).toBeLessThan(60);
    const steps = shardJob?.steps ?? [];
    const run = steps.find((step) => step.name === "Tests (shard)");
    expect(run?.env?.HACK_TEST_SHARD).toBe(`\${{ matrix.shard }}/${count}`);
    expect(run?.run).toContain(
      'bun scripts/test-shard.ts run --shard="$HACK_TEST_SHARD"'
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
  });

  test("test passes only when every shard succeeded and never skips", async () => {
    const workflow = await ciWorkflow();
    const fanIn = workflow.jobs.test;
    expect(fanIn?.name ?? "test").toBe("test");
    expect(fanIn?.needs).toBe("test-shard");
    expect(fanIn?.if).toBe("${{ always() }}");
    const gate = fanIn?.steps.find(
      (step) => step.name === "Require every test shard to succeed"
    );
    expect(gate?.env?.SHARD_RESULT).toBe("${{ needs.test-shard.result }}");
    expect(gate?.run).toContain('if [ "$SHARD_RESULT" != "success" ]; then');
    expect(gate?.run).toContain("exit 1");
    const named = Object.entries(workflow.jobs).filter(
      ([key, job]) => (job.name ?? key) === "test"
    );
    expect(named.map(([key]) => key)).toEqual(["test"]);
  });

  test("the prerelease gate requires the fan-in and every shard job by name", async () => {
    const count =
      (await ciWorkflow()).jobs["test-shard"]?.strategy?.matrix?.shard
        ?.length ?? 0;
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
