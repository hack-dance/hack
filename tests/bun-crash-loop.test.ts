import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDiagnosticReports,
  type ExecutedRun,
  executeWithLog,
  type LoopCommand,
  loopCommands,
  parseLoopArguments,
  planNextCommand,
  renderLoopSummary,
  runBunCrashLoop,
} from "../scripts/bun-crash-loop.ts";
import {
  classifyBunRun,
  hasBunCrashBanner,
  stripAnsi,
} from "../scripts/lib/bun-crash-classify.ts";

const CRASH_TRANSCRIPT = [
  "tests/native-https-owner.test.ts:",
  "(pass) owner starts [12.00ms]",
  "Bun v1.3.9 (cf6cdbbb) macOS Silicon",
  "panic(main thread): Segmentation fault at address 0x80",
  "oh no: Bun has crashed. This indicates a bug in Bun, not your code.",
  " https://bun.report/1.3.9/Mt1cf6cdbbAAAA",
].join("\n");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-bun-crash-loop-"));
  roots.push(root);
  return root;
}

describe("classifyBunRun", () => {
  test("a crash-banner transcript is a crash even when the exit looks ordinary", () => {
    expect(
      classifyBunRun({ exitCode: 1, signal: null, output: CRASH_TRANSCRIPT })
    ).toEqual({ outcome: "crash", reason: "banner" });
    expect(
      classifyBunRun({ exitCode: 0, signal: null, output: CRASH_TRANSCRIPT })
    ).toEqual({ outcome: "crash", reason: "banner" });
  });

  test("exit 133 or 139 without a banner is a signal crash", () => {
    for (const exitCode of [133, 139]) {
      expect(classifyBunRun({ exitCode, signal: null, output: "" })).toEqual({
        outcome: "crash",
        reason: "signal_exit",
      });
    }
  });

  test("a signal is a crash", () => {
    expect(
      classifyBunRun({ exitCode: null, signal: "SIGSEGV", output: "" })
    ).toEqual({ outcome: "crash", reason: "signal" });
  });

  test("(fail) with exit 1 is a non-crash test failure", () => {
    expect(
      classifyBunRun({
        exitCode: 1,
        signal: null,
        output: "(fail) owner starts [5.00ms]\n\n 3 pass\n 1 fail\n",
      })
    ).toEqual({ outcome: "failure", reason: "test_failure" });
  });

  test("a typecheck exit 2 is a non-crash failure", () => {
    expect(
      classifyBunRun({
        exitCode: 2,
        signal: null,
        output: "src/index.ts(1,1): error TS2304: Cannot find name 'x'.\n",
      })
    ).toEqual({ outcome: "failure", reason: "exit_code" });
  });

  test("exit 0 is a pass", () => {
    expect(
      classifyBunRun({
        exitCode: 0,
        signal: null,
        output: " 12 pass\n 0 fail\n",
      })
    ).toEqual({ outcome: "pass", reason: "exit_zero" });
  });

  test("no exit status and no signal is a failure, not a pass", () => {
    expect(
      classifyBunRun({ exitCode: null, signal: null, output: "" })
    ).toEqual({ outcome: "failure", reason: "missing_exit" });
  });

  test("ANSI-escaped banners and failure markers still match", () => {
    const colored =
      "\u001b[31mpanic\u001b[0m(main thread): Segmentation fault\n\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007\n";
    expect(stripAnsi(colored)).toContain("panic(main thread)");
    expect(hasBunCrashBanner(colored)).toBe(true);
    expect(
      classifyBunRun({ exitCode: 1, signal: null, output: colored })
    ).toEqual({ outcome: "crash", reason: "banner" });
    expect(
      classifyBunRun({
        exitCode: 1,
        signal: null,
        output: "\u001b[0m\u001b[31m(fail)\u001b[0m owner starts\n",
      })
    ).toEqual({ outcome: "failure", reason: "test_failure" });
  });
});

const commands: readonly LoopCommand[] = [
  { id: "focused", argv: ["focused"], initialEstimateMs: 100_000 },
  { id: "full", argv: ["full"], initialEstimateMs: 300_000 },
];

describe("planNextCommand deadline arithmetic", () => {
  const estimatesMs = { focused: 100_000, full: 300_000 };

  test("a command that ends exactly at the deadline may start", () => {
    expect(
      planNextCommand({
        nowMs: 700_000,
        deadlineMs: 1_000_000,
        commands,
        cursor: 1,
        estimatesMs,
      })?.command.id
    ).toBe("full");
  });

  test("a command that would end past the deadline falls back to one that fits", () => {
    const next = planNextCommand({
      nowMs: 700_001,
      deadlineMs: 1_000_000,
      commands,
      cursor: 1,
      estimatesMs,
    });
    expect(next?.command.id).toBe("focused");
    expect(next?.cursor).toBe(2);
  });

  test("nothing starts when no command fits or the deadline has passed", () => {
    expect(
      planNextCommand({
        nowMs: 900_001,
        deadlineMs: 1_000_000,
        commands,
        cursor: 0,
        estimatesMs,
      })
    ).toBeNull();
    expect(
      planNextCommand({
        nowMs: 1_000_000,
        deadlineMs: 1_000_000,
        commands,
        cursor: 0,
        estimatesMs: { focused: 0, full: 0 },
      })
    ).toBeNull();
  });
});

describe("runBunCrashLoop", () => {
  test("no iteration starts past the budget and estimates grow to observed durations", async () => {
    let clock = 0;
    const durations = { focused: 90_000, full: 500_000 };
    const starts: { id: string; at: number }[] = [];
    const result = await runBunCrashLoop({
      budgetMs: 1_000_000,
      commands,
      now: () => clock,
      execute: async (command) => {
        starts.push({ id: command.id, at: clock });
        clock += durations[command.id];
        return {
          exitCode: 0,
          signal: null,
          output: "",
          stoppedAtDeadline: false,
        };
      },
    });
    // After the full suite takes 500 s, its estimate is 500 s and it no longer
    // fits; focused runs (estimate 100 s) continue until 950 s + 100 s > 1000 s.
    expect(starts).toEqual([
      { id: "focused", at: 0 },
      { id: "full", at: 90_000 },
      { id: "focused", at: 590_000 },
      { id: "focused", at: 680_000 },
      { id: "focused", at: 770_000 },
      { id: "focused", at: 860_000 },
    ]);
    for (const start of starts) {
      const estimate = start.id === "full" ? 300_000 : 100_000;
      expect(start.at + estimate).toBeLessThanOrEqual(1_000_000);
    }
    expect(result.estimatesMs).toEqual({ focused: 100_000, full: 500_000 });
    expect(result.iterations.map((record) => record.outcome)).toEqual(
      new Array(6).fill("pass")
    );
  });

  test("a run stopped at the deadline is an overrun unless it printed the crash banner", async () => {
    let clock = 0;
    const runs: ExecutedRun[] = [
      {
        exitCode: null,
        signal: "SIGTERM",
        output: "",
        stoppedAtDeadline: true,
      },
      {
        exitCode: null,
        signal: "SIGTERM",
        output: CRASH_TRANSCRIPT,
        stoppedAtDeadline: true,
      },
    ];
    const result = await runBunCrashLoop({
      budgetMs: 1_000_000,
      commands: [commands[0] as LoopCommand],
      now: () => clock,
      execute: async () => {
        clock += 100_000;
        return (
          runs.shift() ?? {
            exitCode: 0,
            signal: null,
            output: "",
            stoppedAtDeadline: false,
          }
        );
      },
    });
    expect(result.iterations[0]).toMatchObject({
      outcome: "overrun",
      reason: "deadline",
      signal: null,
    });
    expect(result.iterations[1]).toMatchObject({
      outcome: "crash",
      reason: "banner",
    });
  });

  test("the summary is closed and value-free", async () => {
    let clock = 0;
    const result = await runBunCrashLoop({
      budgetMs: 250_000,
      commands,
      now: () => clock,
      execute: async () => {
        clock += 100_000;
        return {
          exitCode: 133,
          signal: null,
          output: `TOKEN=do-not-print ${CRASH_TRANSCRIPT}`,
          stoppedAtDeadline: false,
        };
      },
    });
    const summary = renderLoopSummary({
      result,
      bunVersion: "1.3.9",
      sourceRevision: "2b8057c1ae6f4311150b6e139a9a919bbc7788d4",
      diagnosticReports: 1,
    });
    expect(summary).toContain("| focused | 2 | 0 | 0 | 2 | 0 |");
    expect(summary).toContain("| 1 | focused | crash | banner | 133 | - |");
    expect(summary).not.toContain("do-not-print");
    expect(summary).not.toContain("bun.report");
    expect(summary).not.toContain("native-https-owner");
  });
});

describe("executeWithLog", () => {
  test("keeps each run's log, reports signals and stops a run at the deadline", async () => {
    const root = await tempRoot();
    const execute = executeWithLog({ cwd: root, logDir: root });
    const far = Date.now() + 60_000;
    const pass = await execute(
      {
        id: "focused",
        argv: [process.execPath, "-e", "console.log('ok')"],
        initialEstimateMs: 1000,
      },
      { index: 1, deadlineMs: far }
    );
    expect(pass).toMatchObject({ exitCode: 0, stoppedAtDeadline: false });
    expect(pass.output).toContain("ok");

    const crashed = await execute(
      {
        id: "focused",
        argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGSEGV')"],
        initialEstimateMs: 1000,
      },
      { index: 2, deadlineMs: far }
    );
    expect(crashed.signal).toBe("SIGSEGV");
    expect(classifyBunRun(crashed).outcome).toBe("crash");

    const stopped = await execute(
      {
        id: "full",
        argv: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"],
        initialEstimateMs: 1000,
      },
      { index: 3, deadlineMs: Date.now() + 200 }
    );
    expect(stopped.stoppedAtDeadline).toBe(true);
    expect((await readdir(root)).sort()).toEqual([
      "iteration-001-focused.log",
      "iteration-002-focused.log",
      "iteration-003-full.log",
    ]);
  });
});

test("loop commands run the focused owner test and then the full suite", () => {
  expect(
    loopCommands({
      bunExecutable: "/bin/bun",
      focusedEstimateSeconds: 60,
      fullEstimateSeconds: 600,
    }).map((command) => [command.id, command.argv, command.initialEstimateMs])
  ).toEqual([
    [
      "focused",
      ["/bin/bun", "test", "tests/native-https-owner.test.ts"],
      60_000,
    ],
    ["full", ["/bin/bun", "test"], 600_000],
  ]);
});

test("loop arguments are validated and closed", () => {
  expect(
    parseLoopArguments([
      "--budget-seconds=1800",
      "--out-dir=/tmp/x",
      "--expect-bun-version=1.3.9",
      "--source-revision=2b8057c1ae6f4311150b6e139a9a919bbc7788d4",
    ])
  ).toMatchObject({
    budgetSeconds: 1800,
    outDir: "/tmp/x",
    expectBunVersion: "1.3.9",
    focusedEstimateSeconds: 120,
    fullEstimateSeconds: 600,
  });
  for (const argv of [
    [],
    ["--budget-seconds=10"],
    ["--budget-seconds=abc"],
    ["--budget-seconds=1800", "--budget-seconds=1800"],
    ["--budget-seconds=1800", "--unknown=1"],
    ["--budget-seconds=1800", "--expect-bun-version=latest"],
    ["--budget-seconds=1800", "--source-revision=main"],
  ]) {
    expect(() => parseLoopArguments(argv)).toThrow();
  }
});

test("only bun crash reports written during the loop are collected", async () => {
  const root = await tempRoot();
  const source = join(root, "DiagnosticReports");
  const destination = join(root, "out");
  await Bun.write(join(source, "bun-2026-10-12-old.ips"), "{}");
  await writeFile(join(source, "bun-2026-10-12-new.ips"), "{}");
  await writeFile(join(source, "node-2026-10-12.ips"), "{}");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(join(source, "bun-2026-10-12-old.ips"), old, old);
  const copied = await collectDiagnosticReports({
    source,
    destination,
    sinceMs: Date.now() - 60_000,
  });
  expect(copied).toBe(1);
  expect(await readdir(destination)).toEqual(["bun-2026-10-12-new.ips"]);
  expect(
    await collectDiagnosticReports({
      source: join(root, "missing"),
      destination,
      sinceMs: 0,
    })
  ).toBe(0);
});
