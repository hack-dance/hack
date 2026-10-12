import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateCensus,
  type CensusOptions,
  type GhReader,
  type JobRecord,
  parseCensusArguments,
  renderCensus,
  runCensus,
  workflowJobBunVersion,
} from "../scripts/ci-bun-crash-census.ts";
import {
  classifyHostedJobLog,
  hostedJobBunVersion,
  hostedJobExitCode,
} from "../scripts/lib/bun-crash-classify.ts";

const stamp = (line: string) => `2026-09-30T21:01:25.1622680Z ${line}`;

function hostedLog(opts: {
  readonly bunVersion: string;
  readonly body: readonly string[];
  readonly exitCode: number | null;
}): string {
  return [
    stamp("##[group]Run oven-sh/setup-bun@v1"),
    stamp("with:"),
    stamp(`  bun-version: ${opts.bunVersion}`),
    stamp("##[endgroup]"),
    ...opts.body.map(stamp),
    ...(opts.exitCode === null
      ? []
      : [stamp(`##[error]Process completed with exit code ${opts.exitCode}.`)]),
  ].join("\n");
}

const CRASH_LOG = hostedLog({
  bunVersion: "1.3.9",
  body: [
    "\u001b[0m\u001b[2mBun v1.3.9 (cf6cdbbb) macOS Silicon\u001b[0m",
    "\u001b[31mpanic(main thread)\u001b[0m: Segmentation fault at address 0x80",
    "oh no: Bun has crashed. This indicates a bug in Bun, not your code.",
    " https://bun.report/1.3.9/Mt1cf6cdbbAAAA",
    "SECRET_LOOKING_VALUE=do-not-print",
  ],
  exitCode: 133,
});
const TEST_FAILURE_LOG = hostedLog({
  bunVersion: "1.4.2",
  body: ["(fail) owner starts [5.00ms]", " 1 fail"],
  exitCode: 1,
});
const TYPECHECK_LOG = hostedLog({
  bunVersion: "1.4.2",
  body: ["src/index.ts(1,1): error TS2304: Cannot find name 'x'."],
  exitCode: 2,
});
const SIGNAL_EXIT_LOG = hostedLog({
  bunVersion: "1.3.9",
  body: ["/bin/bash: line 1:  1243 Trace/BPT trap: 5       bun test"],
  exitCode: 133,
});

describe("hosted job logs", () => {
  test("a hosted crash transcript with timestamps and ANSI escapes is a crash", () => {
    expect(classifyHostedJobLog(CRASH_LOG)).toEqual({
      outcome: "crash",
      reason: "banner",
    });
    expect(hostedJobExitCode(CRASH_LOG)).toBe(133);
    expect(hostedJobBunVersion(CRASH_LOG)).toBe("1.3.9");
  });

  test("exit 133 without a banner is a signal crash", () => {
    expect(classifyHostedJobLog(SIGNAL_EXIT_LOG)).toEqual({
      outcome: "crash",
      reason: "signal_exit",
    });
  });

  test("test failures and typecheck exit 2 are non-crash failures", () => {
    expect(classifyHostedJobLog(TEST_FAILURE_LOG)).toEqual({
      outcome: "failure",
      reason: "test_failure",
    });
    expect(classifyHostedJobLog(TYPECHECK_LOG)).toEqual({
      outcome: "failure",
      reason: "exit_code",
    });
  });

  test("a log without an exit annotation is not a pass", () => {
    expect(
      classifyHostedJobLog(
        hostedLog({ bunVersion: "1.4.2", body: [], exitCode: null })
      )
    ).toEqual({ outcome: "failure", reason: "missing_exit" });
  });
});

test("the test job's Bun version is read from its own workflow block", () => {
  const workflow = [
    "jobs:",
    "  state-models:",
    "    steps:",
    "      - uses: oven-sh/setup-bun@v1",
    "        with:",
    '          bun-version: "1.0.0"',
    "  test:",
    "    runs-on: blacksmith-6vcpu-macos-15",
    "    steps:",
    "      - uses: oven-sh/setup-bun@v1",
    "        with:",
    '          bun-version: "1.3.9"',
    "  linux-process-lifetime:",
    '          bun-version: "1.4.2"',
  ].join("\n");
  expect(workflowJobBunVersion(workflow, "test")).toBe("1.3.9");
  expect(workflowJobBunVersion(workflow, "missing")).toBeNull();
  expect(
    workflowJobBunVersion(
      "jobs:\n  test:\n  other:\n    bun-version: 1.4.2",
      "test"
    )
  ).toBeNull();
});

const record = (overrides: Partial<JobRecord>): JobRecord => ({
  runId: 1,
  attempt: 1,
  jobId: 1,
  conclusion: "success",
  bunVersion: "1.4.2",
  versionSource: "workflow",
  scan: null,
  reason: null,
  ...overrides,
});

test("totals aggregate per Bun version with crashing run and job ids", () => {
  const totals = aggregateCensus([
    record({ jobId: 1 }),
    record({
      jobId: 2,
      conclusion: "failure",
      scan: "failure",
      reason: "exit_code",
      versionSource: "log",
    }),
    record({ jobId: 3, conclusion: "cancelled" }),
    record({
      runId: 7,
      attempt: 2,
      jobId: 4,
      bunVersion: "1.3.9",
      conclusion: "failure",
      scan: "crash",
      reason: "banner",
      versionSource: "log",
    }),
    record({ jobId: 5, bunVersion: "1.3.9" }),
    record({
      jobId: 6,
      bunVersion: "1.10.0",
      conclusion: "timed_out",
      scan: "unavailable",
    }),
    record({ jobId: 8, bunVersion: "unknown", versionSource: "unknown" }),
  ]);
  expect(totals.map((entry) => entry.bunVersion)).toEqual([
    "1.3.9",
    "1.4.2",
    "1.10.0",
    "unknown",
  ]);
  expect(totals[0]).toMatchObject({
    executions: 2,
    successes: 1,
    failures: 1,
    crashes: 1,
    logsScanned: 1,
    crashing: [{ runId: 7, attempt: 2, jobId: 4, reason: "banner" }],
  });
  expect(totals[1]).toMatchObject({
    executions: 3,
    successes: 1,
    failures: 1,
    cancelled: 1,
    crashes: 0,
    versionSources: { log: 1, workflow: 2, unknown: 0 },
  });
  expect(totals[2]).toMatchObject({ failures: 1, logsUnavailable: 1 });
});

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const workflowFor = (version: string) =>
  Buffer.from(
    `jobs:\n  test:\n    steps:\n      - with:\n          bun-version: "${version}"\n`
  ).toString("base64");

function fakeGh(opts: { readonly total?: number } = {}) {
  const downloads: string[] = [];
  const destinations: string[] = [];
  const logs: Record<number, string> = {
    11: CRASH_LOG,
    21: TEST_FAILURE_LOG,
    22: "passing log body",
  };
  const reader: GhReader = {
    json: async (path) => {
      if (path.includes("/runs?created=")) {
        return { total_count: opts.total ?? 2 };
      }
      if (path.endsWith(`?ref=${SHA_OLD}`)) {
        return { content: workflowFor("1.3.9") };
      }
      if (path.endsWith(`?ref=${SHA_NEW}`)) {
        return { content: workflowFor("1.4.2") };
      }
      throw new Error("unexpected path");
    },
    lines: async (path) => {
      if (path.includes("/runs?created=")) {
        return [
          JSON.stringify({ id: 100, head_sha: SHA_OLD }),
          JSON.stringify({ id: 200, head_sha: SHA_NEW }),
        ];
      }
      if (path.includes("/runs/100/jobs?filter=all")) {
        return [
          {
            id: 11,
            name: "test",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 12,
            name: "test",
            run_attempt: 2,
            status: "completed",
            conclusion: "success",
          },
          {
            id: 13,
            name: "runtime-images",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          },
        ].map((job) => JSON.stringify(job));
      }
      if (path.includes("/runs/200/jobs?filter=all")) {
        return [
          {
            id: 21,
            name: "test",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 21,
            name: "test",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 22,
            name: "test",
            run_attempt: 2,
            status: "completed",
            conclusion: "success",
          },
          {
            id: 23,
            name: "test",
            run_attempt: 3,
            status: "in_progress",
            conclusion: null,
          },
          {
            id: 24,
            name: "test",
            run_attempt: 3,
            status: "completed",
            conclusion: "skipped",
          },
        ].map((job) => JSON.stringify(job));
      }
      throw new Error("unexpected path");
    },
    download: async (path, destination) => {
      const jobId = Number(/\/jobs\/(\d+)\/logs$/.exec(path)?.[1]);
      downloads.push(path);
      destinations.push(destination);
      await Bun.write(destination, logs[jobId] ?? "");
    },
  };
  return { reader, downloads, destinations };
}

const options: CensusOptions = {
  repository: "hack-dance/hack",
  workflow: "ci.yml",
  job: "test",
  since: "2026-09-29T00:00:00Z",
  until: "2026-10-01T17:35:00Z",
  scanPassing: false,
  concurrency: 2,
};

const workDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    workDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-bun-census-test-"));
  workDirs.push(dir);
  return dir;
}

describe("runCensus", () => {
  test("reads every attempt's test job, downloads only failed logs and removes them", async () => {
    const dir = await workDir();
    const gh = fakeGh();
    const result = await runCensus(options, gh.reader, dir);
    expect(gh.downloads).toEqual([
      "repos/hack-dance/hack/actions/jobs/11/logs",
      "repos/hack-dance/hack/actions/jobs/21/logs",
    ]);
    expect(gh.destinations.every((path) => path.startsWith(dir))).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    expect(result.runs).toBe(2);
    expect(result.records.map((entry) => [entry.jobId, entry.attempt])).toEqual(
      [
        [11, 1],
        [12, 2],
        [21, 1],
        [22, 2],
      ]
    );
    expect(result.totals).toMatchObject([
      {
        bunVersion: "1.3.9",
        executions: 2,
        failures: 1,
        crashes: 1,
        versionSources: { log: 1, workflow: 1, unknown: 0 },
        crashing: [{ runId: 100, attempt: 1, jobId: 11, reason: "banner" }],
      },
      { bunVersion: "1.4.2", executions: 2, failures: 1, crashes: 0 },
    ]);

    const text = renderCensus({ options, result });
    expect(text).toContain(
      "bun=1.3.9 executions=2 successes=1 failures=1 cancelled=0 crashes=1"
    );
    expect(text).toContain("  crash run=100 attempt=1 job=11 reason=banner");
    expect(text).not.toContain("do-not-print");
    expect(text).not.toContain("bun.report");
    expect(text).not.toContain("Segmentation");
  });

  test("--scan-passing also classifies passing logs", async () => {
    const dir = await workDir();
    const gh = fakeGh();
    const result = await runCensus(
      { ...options, scanPassing: true },
      gh.reader,
      dir
    );
    expect(gh.downloads).toHaveLength(4);
    expect(await readdir(dir)).toEqual([]);
    expect(result.totals[1]).toMatchObject({
      bunVersion: "1.4.2",
      logsScanned: 2,
    });
  });

  test("a window beyond the runs endpoint limit is refused before any job read", async () => {
    const gh = fakeGh({ total: 1001 });
    await expect(
      runCensus(options, gh.reader, await workDir())
    ).rejects.toThrow("narrow it");
    expect(gh.downloads).toEqual([]);
  });
});

test("census arguments are validated and closed", () => {
  expect(
    parseCensusArguments([
      "--since",
      "2026-10-01T17:35:00Z",
      "--until=2026-10-11T23:43:30Z",
      "--scan-passing",
    ])
  ).toEqual({
    repository: "hack-dance/hack",
    workflow: "ci.yml",
    job: "test",
    since: "2026-10-01T17:35:00Z",
    until: "2026-10-11T23:43:30Z",
    scanPassing: true,
    json: false,
  });
  for (const argv of [
    [],
    ["--since", "2026-10-01", "--until", "2026-10-11T23:43:30Z"],
    ["--since", "2026-10-11T23:43:30Z", "--until", "2026-10-01T17:35:00Z"],
    [
      "--since",
      "2026-10-01T17:35:00Z",
      "--until",
      "2026-10-11T23:43:30Z",
      "--repo",
      "x/y/z",
    ],
    [
      "--since",
      "2026-10-01T17:35:00Z",
      "--until",
      "2026-10-11T23:43:30Z",
      "--rerun",
    ],
    [
      "--since",
      "2026-10-01T17:35:00Z",
      "--until",
      "2026-10-11T23:43:30Z",
      "--json",
      "--json",
    ],
  ]) {
    expect(() => parseCensusArguments(argv)).toThrow();
  }
});
