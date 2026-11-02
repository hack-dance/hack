import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLoopSummary,
  collectDiagnosticReports,
  countIterations,
  type ExecutedRun,
  executeWithLog,
  type LoopCommand,
  loopCommands,
  nextEstimateMs,
  parseLoopArguments,
  planNextIteration,
  renderLoopSummary,
  renderVerdict,
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

  test("a trap, abort, bus-error or segfault exit status without a banner is a signal crash", () => {
    for (const exitCode of [133, 134, 138, 139]) {
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

  test("every signal shape Bun.spawn reports is a crash, whatever the signal", () => {
    // Bun.spawn reports a signal death as exitCode null plus the signal name.
    // These shapes are fed directly, so no test process ever receives a crash
    // signal (which would make macOS write a real crash report).
    for (const signal of [
      "SIGSEGV",
      "SIGABRT",
      "SIGBUS",
      "SIGILL",
      "SIGTRAP",
      "SIGTERM",
      "SIGKILL",
    ]) {
      expect(classifyBunRun({ exitCode: null, signal, output: "" })).toEqual({
        outcome: "crash",
        reason: "signal",
      });
      expect(
        classifyBunRun({ exitCode: null, signal, output: " 3 pass\n 0 fail\n" })
      ).toEqual({ outcome: "crash", reason: "signal" });
    }
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

const PASS: ExecutedRun = {
  exitCode: 0,
  signal: null,
  output: " 3 pass\n 0 fail\n",
  stoppedAtDeadline: false,
};

/**
 * An injected executor on an injected clock. A run that would end past the
 * deadline is stopped at the deadline, as the real executor does, so starting an
 * iteration that cannot fit shows up as an overrun.
 */
function simulatedExecutor(opts: {
  readonly clock: { now: number };
  readonly durationMs: (command: LoopCommand) => number;
  readonly run?: (command: LoopCommand, index: number) => ExecutedRun;
  readonly starts?: { id: string; at: number; argv: readonly string[] }[];
}) {
  return async (
    command: LoopCommand,
    context: { readonly index: number; readonly deadlineMs: number }
  ): Promise<ExecutedRun> => {
    opts.starts?.push({
      id: command.id,
      at: opts.clock.now,
      argv: command.argv,
    });
    const end = opts.clock.now + opts.durationMs(command);
    if (end > context.deadlineMs) {
      opts.clock.now = context.deadlineMs;
      return {
        exitCode: null,
        signal: "SIGTERM",
        output: "",
        stoppedAtDeadline: true,
      };
    }
    opts.clock.now = end;
    return opts.run?.(command, context.index) ?? PASS;
  };
}

describe("planNextIteration deadline arithmetic", () => {
  const estimatesMs = { focused: 100_000, full: 300_000 };

  test("a command that ends exactly at the deadline may start", () => {
    expect(
      planNextIteration({
        nowMs: 700_000,
        deadlineMs: 1_000_000,
        active: commands,
        cursor: 1,
        estimatesMs,
      })
    ).toMatchObject({ action: "run", position: 1, command: { id: "full" } });
  });

  test("a command that would end past the deadline is skipped, not started", () => {
    expect(
      planNextIteration({
        nowMs: 700_001,
        deadlineMs: 1_000_000,
        active: commands,
        cursor: 1,
        estimatesMs,
      })
    ).toMatchObject({ action: "skip", position: 1, command: { id: "full" } });
  });

  test("nothing starts once the deadline is reached, and an empty rotation ends", () => {
    expect(
      planNextIteration({
        nowMs: 1_000_000,
        deadlineMs: 1_000_000,
        active: commands,
        cursor: 0,
        estimatesMs: { focused: 0, full: 0 },
      })?.action
    ).toBe("skip");
    expect(
      planNextIteration({
        nowMs: 0,
        deadlineMs: 1_000_000,
        active: [],
        cursor: 0,
        estimatesMs,
      })
    ).toBeNull();
  });

  test("the estimate is the prior until a run completes, then the longest run with headroom", () => {
    expect(
      nextEstimateMs({ priorMs: 2_400_000, longestCompletedMs: null })
    ).toBe(2_400_000);
    expect(
      nextEstimateMs({ priorMs: 120_000, longestCompletedMs: 16_500 })
    ).toBe(19_800);
  });
});

describe("runBunCrashLoop", () => {
  test("a 30-minute alternating budget never starts the 35-minute suite and records the skip", async () => {
    // The hosted shape: focused ~16.5 s, full suite ~35 min, 30-minute budget.
    const clock = { now: 0 };
    const starts: { id: string; at: number; argv: readonly string[] }[] = [];
    const budgetMs = 1_800_000;
    const result = await runBunCrashLoop({
      budgetMs,
      commands: loopCommands({
        bunExecutable: "/bin/bun",
        mode: "alternate",
        focusedEstimateSeconds: 120,
        fullEstimateSeconds: 2400,
      }),
      now: () => clock.now,
      execute: simulatedExecutor({
        clock,
        starts,
        durationMs: (command) => (command.id === "full" ? 2_100_000 : 16_500),
      }),
    });
    expect(starts.some((start) => start.id === "full")).toBe(false);
    expect(starts).toHaveLength(108);
    for (const start of starts) {
      expect(start.at + 16_500).toBeLessThanOrEqual(budgetMs);
    }
    expect(result.iterations.every((record) => record.outcome === "pass")).toBe(
      true
    );
    expect(result.skippedForBudget).toEqual([
      {
        command: "full",
        reason: "budget",
        atMs: 16_500,
        remainingMs: 1_783_500,
        estimateMs: 2_400_000,
      },
      {
        command: "focused",
        reason: "budget",
        atMs: 1_782_000,
        remainingMs: 18_000,
        estimateMs: 19_800,
      },
    ]);
    expect(countIterations(result)).toEqual({
      focused: {
        iterations: 108,
        passes: 108,
        crashes: 0,
        failures: 0,
        overruns: 0,
        skippedForBudget: 1,
      },
      full: {
        iterations: 0,
        passes: 0,
        crashes: 0,
        failures: 0,
        overruns: 0,
        skippedForBudget: 1,
      },
    });
  });

  test("estimates follow measured durations and no start overruns the deadline", async () => {
    const clock = { now: 0 };
    const starts: { id: string; at: number; argv: readonly string[] }[] = [];
    const result = await runBunCrashLoop({
      budgetMs: 1_000_000,
      commands,
      now: () => clock.now,
      execute: simulatedExecutor({
        clock,
        starts,
        durationMs: (command) => (command.id === "full" ? 500_000 : 90_000),
      }),
    });
    // The full suite fits its 300 s prior once; measured at 500 s (600 s with
    // headroom) it no longer fits at 680 s and leaves the rotation. Focused runs
    // (108 s estimate after the first) continue until 950 s + 108 s > 1000 s.
    expect(starts.map(({ id, at }) => ({ id, at }))).toEqual([
      { id: "focused", at: 0 },
      { id: "full", at: 90_000 },
      { id: "focused", at: 590_000 },
      { id: "focused", at: 680_000 },
      { id: "focused", at: 770_000 },
      { id: "focused", at: 860_000 },
    ]);
    expect(result.estimatesMs).toEqual({ focused: 108_000, full: 600_000 });
    expect(
      result.skippedForBudget.map(({ command, atMs }) => [command, atMs])
    ).toEqual([
      ["full", 680_000],
      ["focused", 950_000],
    ]);
    expect(result.iterations.map((record) => record.outcome)).toEqual(
      new Array(6).fill("pass")
    );
  });

  test("focused mode only ever runs the owner test file", async () => {
    const clock = { now: 0 };
    const starts: { id: string; at: number; argv: readonly string[] }[] = [];
    const result = await runBunCrashLoop({
      budgetMs: 600_000,
      commands: loopCommands({
        bunExecutable: "/bin/bun",
        mode: "focused",
        focusedEstimateSeconds: 120,
        fullEstimateSeconds: 2400,
      }),
      now: () => clock.now,
      execute: simulatedExecutor({ clock, starts, durationMs: () => 20_000 }),
    });
    expect(starts.length).toBeGreaterThan(20);
    for (const start of starts) {
      expect(start.argv).toEqual([
        "/bin/bun",
        "test",
        "tests/native-https-owner.test.ts",
      ]);
    }
    expect(result.commands).toEqual(["focused"]);
    expect(Object.keys(countIterations(result))).toEqual(["focused"]);
    expect(result.skippedForBudget.map((skip) => skip.command)).toEqual([
      "focused",
    ]);
  });

  test("full mode with a budget below the prior starts nothing and says so", async () => {
    const clock = { now: 0 };
    const starts: { id: string; at: number; argv: readonly string[] }[] = [];
    const result = await runBunCrashLoop({
      budgetMs: 1_800_000,
      commands: loopCommands({
        bunExecutable: "/bin/bun",
        mode: "full",
        focusedEstimateSeconds: 120,
        fullEstimateSeconds: 2400,
      }),
      now: () => clock.now,
      execute: simulatedExecutor({ clock, starts, durationMs: () => 1 }),
    });
    expect(starts).toEqual([]);
    expect(result.skippedForBudget).toHaveLength(1);
    expect(
      renderVerdict({ result, role: "candidate", bunVersion: "1.4.2" })
    ).toBe("candidate 0/0 full crashes; no iteration fit the budget");
  });

  test("injected crashes count as crashes, other non-zero exits as other failures", async () => {
    const clock = { now: 0 };
    const injected: ExecutedRun[] = [
      PASS,
      // Bun's own banner, whatever the exit status.
      {
        exitCode: 0,
        signal: null,
        output: CRASH_TRANSCRIPT,
        stoppedAtDeadline: false,
      },
      // Signal deaths as Bun.spawn reports them; no real process gets a signal.
      {
        exitCode: null,
        signal: "SIGSEGV",
        output: "",
        stoppedAtDeadline: false,
      },
      {
        exitCode: null,
        signal: "SIGBUS",
        output: "",
        stoppedAtDeadline: false,
      },
      // Shell-style abort exit status without a banner.
      { exitCode: 134, signal: null, output: "", stoppedAtDeadline: false },
      {
        exitCode: 1,
        signal: null,
        output: "(fail) owner starts [5.00ms]\n 3 pass\n 1 fail\n",
        stoppedAtDeadline: false,
      },
      { exitCode: 2, signal: null, output: "", stoppedAtDeadline: false },
    ];
    const result = await runBunCrashLoop({
      budgetMs: 200_000,
      commands: [commands[0] as LoopCommand],
      now: () => clock.now,
      execute: simulatedExecutor({
        clock,
        durationMs: () => 10_000,
        run: (_command, index) => injected[index - 1] ?? PASS,
      }),
    });
    expect(
      result.iterations
        .slice(0, 7)
        .map((record) => [record.outcome, record.reason])
    ).toEqual([
      ["pass", "exit_zero"],
      ["crash", "banner"],
      ["crash", "signal"],
      ["crash", "signal"],
      ["crash", "signal_exit"],
      ["failure", "test_failure"],
      ["failure", "exit_code"],
    ]);
    // 10 s runs, 12 s estimate after the first: starts at 0..180 s, then 190 s + 12 s > 200 s.
    expect(countIterations(result)).toEqual({
      focused: {
        iterations: 19,
        passes: 13,
        crashes: 4,
        failures: 2,
        overruns: 0,
        skippedForBudget: 1,
      },
    });
    expect(
      renderVerdict({ result, role: "baseline", bunVersion: "1.3.9" })
    ).toBe("baseline 4/19 focused crashes");
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
      budgetMs: 250_000,
      commands: [commands[0] as LoopCommand],
      now: () => clock,
      execute: async () => {
        clock += 100_000;
        return runs.shift() ?? PASS;
      },
    });
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0]).toMatchObject({
      outcome: "overrun",
      reason: "deadline",
      signal: null,
    });
    expect(result.iterations[1]).toMatchObject({
      outcome: "crash",
      reason: "banner",
    });
    // A stopped run is not a measured duration, so the prior stays in force.
    expect(result.estimatesMs.focused).toBe(100_000);
    expect(countIterations(result).focused?.overruns).toBe(1);
    expect(renderVerdict({ result, role: null, bunVersion: "1.3.9" })).toBe(
      "Bun 1.3.9 1/2 focused crashes; 1 overrun"
    );
  });

  test("a signal death from the executor is recorded as a crash with its closed signal name", async () => {
    let clock = 0;
    const runs: ExecutedRun[] = [
      {
        exitCode: null,
        signal: "SIGSEGV",
        output: "",
        stoppedAtDeadline: false,
      },
      {
        exitCode: null,
        signal: "SIGABRT",
        output: "",
        stoppedAtDeadline: false,
      },
      {
        exitCode: null,
        signal: "not a signal name",
        output: "",
        stoppedAtDeadline: false,
      },
    ];
    const result = await runBunCrashLoop({
      budgetMs: 400_000,
      commands: [commands[0] as LoopCommand],
      now: () => clock,
      execute: async () => {
        clock += 100_000;
        return runs.shift() ?? PASS;
      },
    });
    expect(
      result.iterations.map((record) => [
        record.outcome,
        record.reason,
        record.exitCode,
        record.signal,
      ])
    ).toEqual([
      ["crash", "signal", null, "SIGSEGV"],
      ["crash", "signal", null, "SIGABRT"],
      ["crash", "signal", null, null],
    ]);
  });

  test("the summaries are closed and value-free", async () => {
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
    const report = {
      result,
      mode: "alternate" as const,
      role: null,
      bunVersion: "1.3.9",
      sourceRevision: "2b8057c1ae6f4311150b6e139a9a919bbc7788d4",
      diagnosticReports: 1,
    };
    const summary = renderLoopSummary(report);
    expect(summary).toContain(
      "Verdict: Bun 1.3.9 2/2 focused crashes, 0/0 full crashes"
    );
    expect(summary).toContain("| focused | 2 | 0 | 2 | 0 | 0 | 1 | 120.0 |");
    expect(summary).toContain("| full | 0 | 0 | 0 | 0 | 0 | 1 | 300.0 |");
    expect(summary).toContain("| 1 | focused | crash | banner | 133 | - |");
    expect(summary).toContain("| - | full | skipped | budget |");
    const json = JSON.stringify(buildLoopSummary(report));
    expect(JSON.parse(json)).toMatchObject({
      verdict: "Bun 1.3.9 2/2 focused crashes, 0/0 full crashes",
      mode: "alternate",
      role: null,
      counts: {
        focused: { iterations: 2, crashes: 2, skippedForBudget: 1 },
        full: { iterations: 0, skippedForBudget: 1 },
      },
    });
    for (const text of [summary, json]) {
      expect(text).not.toContain("do-not-print");
      expect(text).not.toContain("bun.report");
      expect(text).not.toContain("native-https-owner");
    }
  });
});

const BUN_CRASH_REPORT = /^bun.*\.ips$/i;

/** The `bun*.ips` names in the user's crash-report directory (read-only; empty when absent). */
async function bunCrashReportNames(): Promise<string[]> {
  try {
    const names = await readdir(
      join(homedir(), "Library", "Logs", "DiagnosticReports")
    );
    return names.filter((name) => BUN_CRASH_REPORT.test(name)).sort();
  } catch {
    return [];
  }
}

describe("executeWithLog", () => {
  test("keeps each run's log, reports signals and stops a run at the deadline", async () => {
    // Real children here must never die from a crash signal (SIGSEGV, SIGABRT,
    // SIGBUS, SIGILL, SIGTRAP): macOS ReportCrash would write a bun-*.ips into
    // the user's real DiagnosticReports, whatever HOME is set to.
    const reportsBefore = await bunCrashReportNames();
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

    // SIGTERM is a non-crash signal, so no crash report is written; it still
    // exercises the path where a run dies from a signal the harness did not send.
    const signaled = await execute(
      {
        id: "focused",
        argv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
        initialEstimateMs: 1000,
      },
      { index: 2, deadlineMs: far }
    );
    expect(signaled).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      stoppedAtDeadline: false,
    });
    expect(classifyBunRun(signaled)).toEqual({
      outcome: "crash",
      reason: "signal",
    });

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
    expect(await bunCrashReportNames()).toEqual(reportsBefore);
  });
});

test("each mode selects its commands, and focused is the owner test file alone", () => {
  const ids = (mode: "focused" | "full" | "alternate") =>
    loopCommands({
      bunExecutable: "/bin/bun",
      mode,
      focusedEstimateSeconds: 60,
      fullEstimateSeconds: 2400,
    }).map((command): unknown[] => [
      command.id,
      command.argv,
      command.initialEstimateMs,
    ]);
  const focused = [
    "focused",
    ["/bin/bun", "test", "tests/native-https-owner.test.ts"],
    60_000,
  ];
  const full = ["full", ["/bin/bun", "test"], 2_400_000];
  expect(ids("focused")).toEqual([focused]);
  expect(ids("full")).toEqual([full]);
  expect(ids("alternate")).toEqual([focused, full]);
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
    mode: "focused",
    role: null,
    expectBunVersion: "1.3.9",
    focusedEstimateSeconds: 120,
    fullEstimateSeconds: 2400,
  });
  expect(
    parseLoopArguments([
      "--budget-seconds=1800",
      "--mode=alternate",
      "--role=baseline",
    ])
  ).toMatchObject({ mode: "alternate", role: "baseline" });
  for (const argv of [
    [],
    ["--budget-seconds=10"],
    ["--budget-seconds=abc"],
    ["--budget-seconds=1800", "--budget-seconds=1800"],
    ["--budget-seconds=1800", "--unknown=1"],
    ["--budget-seconds=1800", "--expect-bun-version=latest"],
    ["--budget-seconds=1800", "--source-revision=main"],
    ["--budget-seconds=1800", "--mode=both"],
    ["--budget-seconds=1800", "--mode="],
    ["--budget-seconds=1800", "--role=dispatch"],
    ["--budget-seconds=1800", "--role="],
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
