import { afterEach, test as bunTest, expect, spyOn } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  invokeNativeRuntime,
  isNativeRuntimeNotRunning,
  NATIVE_EXIT_DRAIN_BOUND_MS,
  NativeRuntimeRequestError,
  nativeCodesReportRuntimeNotRunning,
  resolveNativeRuntimeSelection,
} from "../src/backends/native-runtime-client.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  expectClosedRefusal,
  expectCodedRefusal,
} from "./helpers/closed-refusal.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

/**
 * Request deadline for cases that are not about the deadline itself. Spawning
 * the stand-in runtime (and its descendants) on a loaded host can take seconds.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/** Budget for a fixture handshake file to appear. */
const HANDSHAKE_BUDGET_MS = 30_000;
/**
 * A keeper its case never releases still exits after this cap. That bounds the
 * orphan rather than preventing it: the cap outlasts the case's Bun timeout.
 */
const KEEPER_RELEASE_CAP_MS = 120_000;
/** Bun timeout for every case here: most spawn the stand-in runtime. */
const CASE_TIMEOUT_MS = 2 * HANDSHAKE_BUDGET_MS;
/**
 * Slack for host load between the stand-in's recorded exit (or the caller's
 * abort) and the request settling. Added to the named drain bound, the sum
 * stays far below the request timeout, so an unbounded drain still fails.
 */
const DRAIN_SETTLE_MARGIN_MS = 5000;
/**
 * Fixed delay before a descendant writes the closed code on the stand-in's
 * inherited stderr, measured from the test observing the stand-in reaped. It
 * is well above the former 250 ms window, which dropped such a code.
 */
const LATE_CODE_DELAY_MS = 1000;
/**
 * Injected drain bound for the late-writer cases: wide enough that host load
 * cannot push the delayed write past it, so those cases prove that EOF, not a
 * fixed window, ends the drain. The held-descendant cases keep the production
 * bound and prove that it still ends a drain EOF cannot.
 */
const LATE_WRITER_DRAIN_BOUND_MS = 25_000;
/**
 * The production exit drain bound's documented floor (the doc comment on
 * NATIVE_EXIT_DRAIN_BOUND_MS). Every other case reads the constant itself, so
 * without this pin a smaller production bound would pass them all (HACK-1425).
 */
const DOCUMENTED_EXIT_DRAIN_BOUND_MS = 5000;
/**
 * How much earlier than its delay a timer may appear to fire when measured
 * with whole-millisecond wall clocks in two processes.
 */
const TIMER_CLOCK_TOLERANCE_MS = 50;
/**
 * Gap between creating a stand-in's pid file and writing its digits. It makes
 * the empty-file window that a loaded host opens by chance happen on every
 * run, so a reader that only waits for existence fails every time.
 */
const TORN_HANDSHAKE_GAP_MS = 50;

/** Every case gets a named budget; none relies on Bun's 5 s default. */
function test(
  name: string,
  body: Parameters<typeof bunTest>[1],
  timeoutMs = CASE_TIMEOUT_MS
): void {
  bunTest(name, body, timeoutMs);
}

/** Wait for a fixture to write `path`; replaces fixed windows before acting. */
async function waitForFile(
  path: string,
  budgetMs = HANDSHAKE_BUDGET_MS
): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) {
      throw new Error(
        `Fixture handshake did not appear within ${budgetMs} ms.`
      );
    }
    await Bun.sleep(10);
  }
}

/**
 * Wait until a fixture's pid handshake holds a complete pid. A fixture's
 * writeFileSync creates the file before it writes the digits, so a read that
 * only waited for existence can see "": Number("") is 0, and kill(0, 0)
 * always succeeds, so an absence wait on it would never end.
 */
async function waitForPid(
  path: string,
  budgetMs = HANDSHAKE_BUDGET_MS
): Promise<number> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const pid = Number(await file.text());
      if (Number.isSafeInteger(pid) && pid > 1) {
        return pid;
      }
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `Fixture pid handshake did not complete within ${budgetMs} ms.`
      );
    }
    await Bun.sleep(10);
  }
}

function processPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "hack-native-client-"));
  roots.push(home);
  const binary = join(home, "native");
  await Bun.write(
    binary,
    `#!${process.execPath}
if (process.argv.includes("hang")) await Bun.sleep(60_000);
if (process.argv.includes("structured")) { console.error(JSON.stringify({code:"source_conflict",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("foreground-stopped")) { console.error(JSON.stringify({code:"native_graph_foreground",cause_code:"runtime_not_running",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("foreground-other")) { console.error(JSON.stringify({code:"native_graph_foreground",cause_code:"engine_protocol",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("one-off-fail")) { console.error(JSON.stringify({code:"graph_one_off_failed",cause_code:"graph_one_off_cancelled",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("one-off-unsafe")) { console.error(JSON.stringify({code:"graph_one_off_failed",cause_code:"synthetic-secret-diagnostic",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("owner-fail")) { const {appendFileSync}=await import("node:fs"); appendFileSync("attempts","attempt"); console.error(JSON.stringify({code:"graph_owner_recovery",cause_code:"graph_relay_identity",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("owner-unsafe")) { console.error(JSON.stringify({code:"graph_owner_recovery",cause_code:"synthetic-secret-diagnostic",message:"synthetic-secret-diagnostic"})); process.exit(23); }
if (process.argv.includes("fail")) { console.error("synthetic-secret-diagnostic"); process.exit(23); }
if (process.argv.includes("garbage")) { process.stdout.write("not-json"); process.exit(0); }
if (process.argv.includes("overflow")) { process.stdout.write("x".repeat(17 * 1024 * 1024)); }
else {
 const input = await Bun.stdin.text();
 console.log(JSON.stringify({ args:process.argv.slice(2), inputBytes:Buffer.byteLength(input), inherited:process.env.HACK_RUNTIME_CLIENT_CANARY ?? null }));
}
`
  );
  await chmod(binary, 0o700);
  return { home, binary };
}

test("native selection is explicit and requires an isolated absolute home", () => {
  expect(resolveNativeRuntimeSelection({})).toBeNull();
  expect(() =>
    resolveNativeRuntimeSelection({ HACK_RUNTIME_BACKEND: "native" })
  ).toThrow();
  expect(() =>
    resolveNativeRuntimeSelection({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "hack-native",
      HACK_NATIVE_HOME: "/tmp/home",
    })
  ).toThrow();
  // The refusal is closed: the CLI prints this one line without a stack.
  let refusal: unknown;
  try {
    resolveNativeRuntimeSelection({ HACK_RUNTIME_BACKEND: "native" });
  } catch (error: unknown) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(ClosedCliError);
  expect(String(refusal)).toContain(
    "Native runtime requires absolute HACK_NATIVE_BINARY and HACK_NATIVE_HOME paths."
  );
  expect(
    resolveNativeRuntimeSelection({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/tmp/hack-native",
      HACK_NATIVE_HOME: "/tmp/home",
    })
  ).toEqual({ binary: "/tmp/hack-native", home: "/tmp/home" });
});

test("bounded native status draining cannot select another action or legacy command", async () => {
  const runtime = {
    home: "/absent-native-status-home",
    binary: "/absent-native-status-binary",
  };
  for (const args of [
    [
      "graph",
      "native",
      "control",
      "--run-id",
      "a".repeat(32),
      "--action",
      "cleanup",
      "--json",
    ],
    [
      "graph",
      "control",
      "--run-id",
      "a".repeat(32),
      "--action",
      "status",
      "--json",
    ],
    [
      "graph",
      "native",
      "control",
      "--run-id",
      "../foreign",
      "--action",
      "status",
      "--json",
    ],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args,
        boundNativeStatusDrain: true,
      })
    ).rejects.toThrow("budget");
  }
});

test("native authored read draining admits only exact public plan and inspect requests", async () => {
  const runtime = await fixture();
  for (const args of [
    [
      "graph",
      "native",
      "plan",
      "--source-file",
      join(runtime.home, "source.json"),
      "--json",
    ],
    ["graph", "native", "inspect", "--run-id", "a".repeat(32), "--json"],
  ]) {
    expect(
      await invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args,
        boundNativeAuthoredReadDrain: true,
      })
    ).toMatchObject({ args: ["--candidate-root", runtime.home, ...args] });
  }
  const absent = {
    home: "/absent-native-read-home",
    binary: "/absent-native-read-binary",
  };
  for (const args of [
    ["graph", "native", "plan", "--source-file", "relative", "--json"],
    ["graph", "native", "inspect", "--run-id", "../foreign", "--json"],
    ["graph", "native", "cleanup", "--run-id", "a".repeat(32), "--json"],
    ["graph", "inspect", "--run-id", "a".repeat(32), "--json"],
    [
      "graph",
      "native",
      "inspect",
      "--run-id",
      "a".repeat(32),
      "--json",
      "--json",
    ],
  ]) {
    await expect(
      invokeNativeRuntime({
        runtime: absent,
        cwd: absent.home,
        args,
        boundNativeAuthoredReadDrain: true,
      })
    ).rejects.toThrow("budget");
  }
  await expect(
    invokeNativeRuntime({
      runtime: absent,
      cwd: absent.home,
      args: [
        "graph",
        "native",
        "inspect",
        "--run-id",
        "a".repeat(32),
        "--json",
      ],
      privateInput: new Uint8Array([1]),
      boundNativeAuthoredReadDrain: true,
    })
  ).rejects.toThrow("budget");
});

test("native recovery draining requires exact independent selectors and refuses private stdin before spawn", async () => {
  const runtime = await fixture();
  const run = "a".repeat(32);
  const selection = [
    "graph",
    "native",
    "recovery-selection",
    "--run-id",
    run,
    "--json",
  ];
  const cleanup = [
    "graph",
    "native",
    "recover-live-owner",
    "--run-id",
    run,
    "--expect-receipt",
    "b".repeat(64),
    "--expect-owner",
    "c".repeat(64),
    "--json",
  ];
  for (const [mode, args] of [
    ["selection", selection],
    ["cleanup", cleanup],
  ] as const) {
    expect(
      await invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args,
        boundNativeAuthoredRecoveryDrain: mode,
      })
    ).toMatchObject({
      args: ["--candidate-root", runtime.home, ...args],
      inputBytes: 0,
    });
  }
  const absent = {
    home: "/absent-native-recovery-home",
    binary: "/absent-native-recovery-binary",
  };
  for (const [mode, args] of [
    ["cleanup", selection],
    ["selection", cleanup],
    ["selection", [...selection, "--json"]],
    ["selection", ["graph", "recovery-selection", "--run-id", run, "--json"]],
    [
      "cleanup",
      cleanup.map((arg) => (arg === "--expect-owner" ? "--source-file" : arg)),
    ],
    [
      "cleanup",
      cleanup.map((arg) => (arg === "c".repeat(64) ? "../foreign" : arg)),
    ],
    ["cleanup", cleanup.map((arg) => (arg === run ? run.toUpperCase() : arg))],
  ] as const) {
    await expect(
      invokeNativeRuntime({
        runtime: absent,
        cwd: absent.home,
        args,
        boundNativeAuthoredRecoveryDrain: mode,
      })
    ).rejects.toThrow("budget");
  }
  for (const [mode, args] of [
    ["selection", selection],
    ["cleanup", cleanup],
  ] as const) {
    await expect(
      invokeNativeRuntime({
        runtime: absent,
        cwd: absent.home,
        args,
        privateInput: new Uint8Array(),
        boundNativeAuthoredRecoveryDrain: mode,
      })
    ).rejects.toThrow("budget");
  }
});

test("the production exit drain bound keeps its documented floor and outlasts a late writer", () => {
  expect(NATIVE_EXIT_DRAIN_BOUND_MS).toBeGreaterThanOrEqual(
    DOCUMENTED_EXIT_DRAIN_BOUND_MS
  );
  // A closed code written this long after the exit must still be read under
  // the production bound, not only under the late-writer cases' wide seam.
  expect(NATIVE_EXIT_DRAIN_BOUND_MS).toBeGreaterThan(
    LATE_CODE_DELAY_MS + TIMER_CLOCK_TOLERANCE_MS
  );
});

bunTest.each([
  ["read", "exit"],
  ["read", "abort"],
  ["selection", "exit"],
  ["selection", "abort"],
  ["cleanup", "exit"],
  ["cleanup", "abort"],
] as const)(
  "authored %s %s finishes while a descendant retains stdout and stderr",
  async (selection, mode) => {
    const runtime = await fixture();
    const holding = join(runtime.home, "holding");
    const release = join(runtime.home, "release");
    const finished = join(runtime.home, "finished");
    const exiting = join(runtime.home, "exiting");
    // The keeper holds the request's stdout/stderr until the test releases it,
    // so the request can only finish by bounding its drain. The bound is
    // measured from the stand-in's own exit (or the abort), never from spawn,
    // so slow process startup under load cannot decide the outcome.
    const keeper = `import {existsSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(holding)},String(process.pid));
const cap=performance.now()+${KEEPER_RELEASE_CAP_MS};
while(!existsSync(${JSON.stringify(release)})&&performance.now()<cap)await Bun.sleep(10);
writeFileSync(${JSON.stringify(finished)},'finished');`;
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}
import {spawn} from 'node:child_process';
spawn(${JSON.stringify(process.execPath)},['--eval',${JSON.stringify(keeper)}],{detached:true,stdio:['ignore',1,2]}).unref();
const cap=performance.now()+${KEEPER_RELEASE_CAP_MS};
while(!(await Bun.file(${JSON.stringify(holding)}).exists())&&performance.now()<cap)await Bun.sleep(10);
if(!(await Bun.file(${JSON.stringify(holding)}).exists()))process.exit(2);
console.log(JSON.stringify({ready:true}));
${mode === "abort" ? "await Bun.sleep(60_000);" : `(await import('node:fs')).writeFileSync(${JSON.stringify(exiting)},String(Date.now()));process.exit(0);`}
`
    );
    const controller = new AbortController();
    const run = "a".repeat(32);
    const args =
      selection === "read"
        ? ["graph", "native", "inspect", "--run-id", run, "--json"]
        : selection === "selection"
          ? ["graph", "native", "recovery-selection", "--run-id", run, "--json"]
          : [
              "graph",
              "native",
              "recover-live-owner",
              "--run-id",
              run,
              "--expect-receipt",
              "b".repeat(64),
              "--expect-owner",
              "c".repeat(64),
              "--json",
            ];
    const request = invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args,
      timeoutMs: REQUEST_TIMEOUT_MS,
      signal: controller.signal,
      boundNativeAuthoredReadDrain: selection === "read",
      boundNativeAuthoredRecoveryDrain:
        selection === "read" ? undefined : selection,
    });
    let settledAt: number | undefined;
    const stamp = () => {
      settledAt = Date.now();
    };
    request.then(stamp, stamp);
    void request.catch(() => undefined);
    let failed: unknown;
    let completed = false;
    try {
      let endedAt: number;
      if (mode === "abort") {
        await waitForFile(holding);
        endedAt = Date.now();
        controller.abort();
        await expect(request).rejects.toThrow("canceled");
      } else {
        expect(await request).toEqual({ ready: true });
        endedAt = Number(await Bun.file(exiting).text());
      }
      // The drain is bounded: settlement follows the child's end promptly even
      // though the unreleased keeper still holds both pipes.
      expect(settledAt).toBeDefined();
      expect((settledAt ?? Number.POSITIVE_INFINITY) - endedAt).toBeLessThan(
        NATIVE_EXIT_DRAIN_BOUND_MS + DRAIN_SETTLE_MARGIN_MS
      );
      if (mode === "exit") {
        // No seam is passed, so the production bound is the one in effect:
        // the drain kept reading the held pipes for all of it (HACK-1425).
        expect((settledAt ?? 0) - endedAt).toBeGreaterThanOrEqual(
          NATIVE_EXIT_DRAIN_BOUND_MS - TIMER_CLOCK_TOLERANCE_MS
        );
      }
      expect(await Bun.file(finished).exists()).toBe(false);
      const keeperPid = await waitForPid(holding);
      expect(() => process.kill(keeperPid, 0)).not.toThrow();
    } catch (error: unknown) {
      failed = error;
    } finally {
      controller.abort();
      await request.catch(() => undefined);
      await Bun.write(release, "release");
      completed = await waitForFile(finished).then(
        () => true,
        () => false
      );
      if (!completed) {
        roots.splice(roots.indexOf(runtime.home), 1);
      }
    }
    if (!completed) {
      throw new AggregateError(
        failed === undefined ? [] : [failed],
        "owned keeper completion is unconfirmed; fixture retained"
      );
    }
    if (failed !== undefined) {
      throw failed;
    }
    expect(await Bun.file(finished).text()).toBe("finished");
  },
  CASE_TIMEOUT_MS
);

const RUN_ID = "a".repeat(32);
const LATE_WRITER_SELECTIONS = {
  status: {
    args: [
      "graph",
      "native",
      "control",
      "--run-id",
      RUN_ID,
      "--action",
      "status",
      "--json",
    ],
    flags: { boundNativeStatusDrain: true },
  },
  read: {
    args: ["graph", "native", "inspect", "--run-id", RUN_ID, "--json"],
    flags: { boundNativeAuthoredReadDrain: true },
  },
  logs: {
    args: [
      "graph",
      "native",
      "logs",
      "--run-id",
      RUN_ID,
      "--service",
      "web",
      "--tail",
      "10",
      "--json",
    ],
    flags: { boundNativeAuthoredLogsDrain: true },
  },
  exec: {
    args: [
      "graph",
      "native",
      "exec",
      "--run-id",
      RUN_ID,
      "--service",
      "web",
      "--json",
      "--",
      "true",
    ],
    flags: { boundNativeAuthoredExecDrain: true },
  },
  "one-off": {
    args: [
      "graph",
      "native",
      "one-off",
      "--run-id",
      RUN_ID,
      "--service",
      "web",
      "--json",
      "--",
      "true",
    ],
    flags: { boundNativeAuthoredOneOffDrain: true },
  },
  selection: {
    args: [
      "graph",
      "native",
      "recovery-selection",
      "--run-id",
      RUN_ID,
      "--json",
    ],
    flags: { boundNativeAuthoredRecoveryDrain: "selection" },
  },
  cleanup: {
    args: [
      "graph",
      "native",
      "recover-live-owner",
      "--run-id",
      RUN_ID,
      "--expect-receipt",
      "b".repeat(64),
      "--expect-owner",
      "c".repeat(64),
      "--json",
    ],
    flags: { boundNativeAuthoredRecoveryDrain: "cleanup" },
  },
} as const;

bunTest.each(
  Object.keys(LATE_WRITER_SELECTIONS) as (keyof typeof LATE_WRITER_SELECTIONS)[]
)(
  "authored %s keeps a closed code written after the reported exit",
  async (selection) => {
    const runtime = await fixture();
    const writerPid = join(runtime.home, "writer-pid");
    const childPid = join(runtime.home, "child-pid");
    const exitObserved = join(runtime.home, "exit-observed");
    const finished = join(runtime.home, "finished");
    // The writer inherits only stderr. It writes the closed code after the
    // test has seen the stand-in reaped, i.e. after the client observed the
    // exit, and then closes the pipe. A fixed post-exit window drops the code;
    // draining to EOF keeps it. The stand-in publishes its pid as a torn
    // handshake (an empty file first), so the reader must wait for a complete
    // pid rather than for the file to exist.
    const writer = `import {existsSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(writerPid)},String(process.pid));
const cap=performance.now()+${KEEPER_RELEASE_CAP_MS};
while(!existsSync(${JSON.stringify(exitObserved)})&&performance.now()<cap)await Bun.sleep(10);
if(existsSync(${JSON.stringify(exitObserved)})){
  await Bun.sleep(${LATE_CODE_DELAY_MS});
  process.stderr.write(JSON.stringify({code:"graph_budget",message:"synthetic-secret-diagnostic"}));
}
writeFileSync(${JSON.stringify(finished)},'finished');`;
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
spawn(${JSON.stringify(process.execPath)},['--eval',${JSON.stringify(writer)}],{detached:true,stdio:['ignore','ignore',2]}).unref();
const cap=performance.now()+${HANDSHAKE_BUDGET_MS};
while(!existsSync(${JSON.stringify(writerPid)})&&performance.now()<cap)await Bun.sleep(10);
writeFileSync(${JSON.stringify(childPid)},'');
await Bun.sleep(${TORN_HANDSHAKE_GAP_MS});
writeFileSync(${JSON.stringify(childPid)},String(process.pid));
process.exit(existsSync(${JSON.stringify(writerPid)})?23:3);
`
    );
    const { args, flags } = LATE_WRITER_SELECTIONS[selection];
    const request = invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args,
      timeoutMs: REQUEST_TIMEOUT_MS,
      exitDrainBoundMs: LATE_WRITER_DRAIN_BOUND_MS,
      ...flags,
    });
    void request.catch(() => undefined);
    let failed: unknown;
    let completed = false;
    try {
      const child = await waitForPid(childPid);
      // Absence means the client reaped the stand-in: its exit was reported.
      const deadline = performance.now() + HANDSHAKE_BUDGET_MS;
      while (processPresent(child) && performance.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(processPresent(child)).toBe(false);
      await Bun.write(exitObserved, "observed");
      const error: unknown = await request.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeRuntimeRequestError);
      expect(error).toMatchObject({ nativeCode: "graph_budget" });
      expect(String(error)).toContain(
        "Native runtime request failed (graph_budget)"
      );
      expect(String(error)).not.toContain("synthetic-secret-diagnostic");
    } catch (error: unknown) {
      failed = error;
    } finally {
      await Bun.write(exitObserved, "observed");
      await request.catch(() => undefined);
      completed = await waitForFile(finished).then(
        () => true,
        () => false
      );
      if (!completed) {
        roots.splice(roots.indexOf(runtime.home), 1);
      }
    }
    if (!completed) {
      throw new AggregateError(
        failed === undefined ? [] : [failed],
        "owned writer completion is unconfirmed; fixture retained"
      );
    }
    if (failed !== undefined) {
      throw failed;
    }
  },
  CASE_TIMEOUT_MS
);

test("managed input uses stdin with EOF and is absent from argv and inherited env", async () => {
  const runtime = await fixture();
  const prior = process.env.HACK_RUNTIME_CLIENT_CANARY;
  process.env.HACK_RUNTIME_CLIENT_CANARY = "synthetic-private-canary";
  try {
    const reply = await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["inspect", "--json"],
      privateInput: new TextEncoder().encode("synthetic-private-canary"),
    });
    expect(reply).toEqual({
      args: ["--candidate-root", runtime.home, "inspect", "--json"],
      inputBytes: 24,
      inherited: null,
    });
    expect(JSON.stringify(reply)).not.toContain("synthetic-private-canary");
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, "HACK_RUNTIME_CLIENT_CANARY");
    } else {
      process.env.HACK_RUNTIME_CLIENT_CANARY = prior;
    }
  }
});

test("native failure preserves only its validated structured code", async () => {
  const runtime = await fixture();
  try {
    await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["structured"],
    });
    throw new Error("expected structured native refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(NativeRuntimeRequestError);
    expect(error).toMatchObject({ nativeCode: "source_conflict" });
    expect(String(error)).not.toContain("synthetic-secret-diagnostic");
  }
});

test("failures omit subprocess diagnostics and timeouts are bounded", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["fail"] })
  ).rejects.toThrow(
    "Native runtime request failed; inspect owned state before retrying."
  );
  await expect(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["hang"],
      timeoutMs: 100,
    })
  ).rejects.toThrow("Native runtime request timed out");
});

test(
  "cancellation starts at most one native request and reaps only its owned child",
  async () => {
    for (const mode of ["before", "running", "timeout"]) {
      const runtime = await fixture();
      const marker = join(runtime.home, "attempts");
      const pidFile = join(runtime.home, "pid");
      await Bun.write(
        runtime.binary,
        `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
${mode === "timeout" ? "await Bun.sleep(60_000);" : ""}
appendFileSync(${JSON.stringify(marker)}, "attempt\\n");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await Bun.sleep(60_000);
`
      );
      const controller = new AbortController();
      if (mode === "before") {
        controller.abort();
      }
      // Pass through every real spawn; observe only this unique fixture binary.
      const spawn = spyOn(Bun, "spawn");
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        const attempt = invokeNativeRuntime({
          runtime,
          cwd: runtime.home,
          args: ["runtime", "up", "--json"],
          signal: controller.signal,
          // Only the timeout mode is about the deadline; the others must reach
          // their cancellation, however slowly the child starts.
          timeoutMs: mode === "timeout" ? 250 : REQUEST_TIMEOUT_MS,
        });
        void attempt.catch(() => undefined);
        const ownCalls = () =>
          spawn.mock.calls.flatMap(([argv], index) =>
            Array.isArray(argv) && argv[0] === runtime.binary ? [index] : []
          );
        let exited = false;
        if (mode !== "before") {
          expect(ownCalls()).toHaveLength(1);
          const result = spawn.mock.results[ownCalls()[0] ?? -1];
          if (result?.type !== "return") {
            throw new Error("fixture spawn did not return its owned child");
          }
          child = result.value;
          void child.exited.then(() => {
            exited = true;
          });
        }
        if (mode === "running") {
          await waitForFile(pidFile);
          controller.abort();
        }
        await expect(attempt).rejects.toThrow(
          mode === "timeout" ? "timed out" : "canceled"
        );
        expect(ownCalls()).toHaveLength(mode === "before" ? 0 : 1);
        if (mode === "running") {
          if (!child) {
            throw new Error("running fixture lost its parent-owned child");
          }
          expect(await Bun.file(marker).text()).toBe("attempt\n");
          expect(Number(await Bun.file(pidFile).text())).toBe(child.pid);
        } else {
          expect(await Bun.file(marker).exists()).toBe(false);
          expect(await Bun.file(pidFile).exists()).toBe(false);
        }
        // Timeout deliberately precedes the child marker. Parent identity and exit
        // completion must still prove reaping before the request rejects.
        if (child) {
          expect(exited).toBe(true);
          expect(child.signalCode).toBe("SIGKILL");
          let probeFailure: unknown;
          try {
            process.kill(child.pid, 0);
          } catch (error) {
            probeFailure = error;
          }
          expect(probeFailure).toMatchObject({ code: "ESRCH" });
        }
      } finally {
        spawn.mockRestore();
        if (child?.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
    }
  },
  CASE_TIMEOUT_MS
);

test("private-input and response bounds reject instead of truncating", async () => {
  const runtime = await fixture();
  // A managed environment or a selected timeout can exceed the bounds: a
  // coded configuration refusal, not an unexpected exception.
  await expectCodedRefusal(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: [],
      privateInput: new Uint8Array(256 * 1024 + 1),
    }),
    "E_CONFIG_INVALID",
    "input or time budget"
  );
  await expectCodedRefusal(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: [],
      timeoutMs: 600_001,
    }),
    "E_CONFIG_INVALID",
    "input or time budget"
  );
  await expectClosedRefusal(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["overflow"] }),
    "output budget"
  );
});

test("an unparseable control response is a closed refusal", async () => {
  const runtime = await fixture();
  await expectClosedRefusal(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["garbage"] }),
    "Native runtime returned an invalid control response."
  );
});

test("structured failures expose only a bounded code, never their message", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["structured"] })
  ).rejects.toThrow(
    "Native runtime request failed (source_conflict); inspect owned state before retrying."
  );
});

bunTest.each([
  {
    argument: "foreground-stopped",
    stopped: true,
    cause: "runtime_not_running",
  },
  { argument: "foreground-other", stopped: false, cause: undefined },
])(
  "authored control failure preserves only the stopped-runtime cause: $argument",
  async ({ argument, stopped, cause }) => {
    const runtime = await fixture();
    const error: unknown = await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: [argument],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeRuntimeRequestError);
    expect(error).toHaveProperty("nativeCode", "native_graph_foreground");
    expect(error).toHaveProperty("nativeCauseCode", cause);
    expect(isNativeRuntimeNotRunning(error)).toBe(stopped);
    expect(String(error)).not.toContain("synthetic-secret-diagnostic");
    expect(
      isNativeRuntimeNotRunning(
        new NativeRuntimeRequestError({
          message: "unrelated ownership refusal",
          nativeCode: "graph_owner_recovery",
          nativeCauseCode: "runtime_not_running",
        })
      )
    ).toBe(false);
    expect(
      isNativeRuntimeNotRunning({ nativeCode: "runtime_not_running" })
    ).toBe(false);
  },
  CASE_TIMEOUT_MS
);

test("a carried code pair reports a direct or foreground-wrapped stopped runtime only", () => {
  expect(
    nativeCodesReportRuntimeNotRunning({ nativeCode: "runtime_not_running" })
  ).toBe(true);
  expect(
    nativeCodesReportRuntimeNotRunning({
      nativeCode: "native_graph_foreground",
      nativeCauseCode: "runtime_not_running",
    })
  ).toBe(true);
  for (const codes of [
    { nativeCode: "native_graph_foreground" },
    {
      nativeCode: "graph_owner_recovery",
      nativeCauseCode: "runtime_not_running",
    },
    {},
  ]) {
    expect(nativeCodesReportRuntimeNotRunning(codes)).toBe(false);
  }
});

test("one-off failures expose only a validated owner cause code", async () => {
  const runtime = await fixture();
  await expect(
    invokeNativeRuntime({ runtime, cwd: runtime.home, args: ["one-off-fail"] })
  ).rejects.toThrow("graph_one_off_failed: graph_one_off_cancelled");
  await expect(
    invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["one-off-unsafe"],
    })
  ).rejects.toThrow(
    "Native runtime request failed (graph_one_off_failed); inspect owned state before retrying."
  );
});

test("owner cleanup failures preserve a bounded cause without replay or raw diagnostics", async () => {
  const runtime = await fixture();
  const error = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["owner-fail"],
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(NativeRuntimeRequestError);
  expect(error).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: "graph_relay_identity",
  });
  expect(String(error)).toContain("graph_owner_recovery: graph_relay_identity");
  expect(String(error)).not.toContain("synthetic-secret-diagnostic");
  expect(await Bun.file(join(runtime.home, "attempts")).text()).toBe("attempt");

  const unsafe = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["owner-unsafe"],
  }).catch((failure: unknown) => failure);
  expect(unsafe).toBeInstanceOf(NativeRuntimeRequestError);
  expect(unsafe).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: undefined,
  });
  expect(String(unsafe)).not.toContain("synthetic-secret-diagnostic");
});

test("stop diagnostics identify admitted services and fixed stages without replaying requests", async () => {
  const runtime = await fixture();
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}
import {appendFileSync} from "node:fs";
appendFileSync("attempts", "attempt");
console.error(await Bun.file("diagnostic.json").text());
process.exit(23);
`
  );
  const diagnostic = {
    code: "graph_owner_recovery",
    cause_code: "engine_protocol",
    message: "synthetic-secret-diagnostic",
    stop_failures: {
      version: 1,
      failures: [
        { service: "web", stage: "timeout" },
        { service: "ws", stage: "connect_timeout" },
      ],
    },
  };
  await Bun.write(
    join(runtime.home, "diagnostic.json"),
    JSON.stringify(diagnostic)
  );
  const error = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["graph", "cleanup"],
  }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    nativeCode: "graph_owner_recovery",
    nativeCauseCode: "engine_protocol",
    nativeStopFailures: diagnostic.stop_failures.failures,
  });
  expect(String(error)).toContain("web (timeout), ws (connect_timeout)");
  expect(String(error)).not.toContain("synthetic-secret-diagnostic");
  expect(await Bun.file(join(runtime.home, "attempts")).text()).toBe("attempt");

  for (const stop_failures of [
    { ...diagnostic.stop_failures, version: 2 },
    ...["\n", "\r", "\u2028", "\u2029"].map((ending) => ({
      version: 1,
      failures: [{ service: `web${ending}`, stage: "timeout" }],
    })),
    { ...diagnostic.stop_failures, extra: "synthetic-secret-diagnostic" },
    {
      version: 1,
      failures: [
        { service: "/private/synthetic-secret-diagnostic", stage: "timeout" },
      ],
    },
    {
      version: 1,
      failures: [{ service: "web", stage: "synthetic-secret-diagnostic" }],
    },
    {
      version: 1,
      failures: [
        {
          service: "web",
          stage: "timeout",
          message: "synthetic-secret-diagnostic",
        },
      ],
    },
    {
      version: 1,
      failures: [
        { service: "web", stage: "timeout" },
        { service: "web", stage: "connect" },
      ],
    },
    {
      version: 1,
      failures: Array.from({ length: 33 }, (_, i) => ({
        service: `web${i}`,
        stage: "timeout",
      })),
    },
  ]) {
    await Bun.write(
      join(runtime.home, "diagnostic.json"),
      JSON.stringify({ ...diagnostic, stop_failures })
    );
    const invalid = await invokeNativeRuntime({
      runtime,
      cwd: runtime.home,
      args: ["graph", "cleanup"],
    }).catch((failure: unknown) => failure);
    expect(invalid).toMatchObject({
      nativeCode: "graph_owner_recovery",
      nativeStopFailures: undefined,
    });
    expect(Bun.inspect(invalid)).not.toContain("synthetic-secret-diagnostic");
  }
  await Bun.write(
    join(runtime.home, "diagnostic.json"),
    JSON.stringify({ ...diagnostic, code: "source_conflict" })
  );
  const unrelated = await invokeNativeRuntime({
    runtime,
    cwd: runtime.home,
    args: ["graph", "cleanup"],
  }).catch((failure: unknown) => failure);
  expect(unrelated).toMatchObject({
    nativeCode: "source_conflict",
    nativeStopFailures: undefined,
  });
});

test(
  "early structured rejection survives a full private-input pipe without replay",
  async () => {
    const runtime = await fixture();
    const marker = join(runtime.home, "attempts");
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}
import { appendFileSync, closeSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "attempt\\n");
closeSync(0);
await Bun.sleep(20);
console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-diagnostic"}));
process.exit(23);
`
    );
    let failure = "";
    try {
      await invokeNativeRuntime({
        runtime,
        cwd: runtime.home,
        args: [],
        timeoutMs: REQUEST_TIMEOUT_MS,
        privateInput: new TextEncoder().encode(
          "synthetic-private-payload".repeat(10_000)
        ),
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("Native runtime request failed (graph_budget)");
    expect(failure).not.toContain("synthetic-private");
    expect(await Bun.file(marker).text()).toBe("attempt\n");
  },
  CASE_TIMEOUT_MS
);

test("exec accepts matching nonzero completion only through its explicit transport contract", async () => {
  const runtime = await fixture();
  const reply = {
    exit_code: 7,
    stdout_base64: "AP8=",
    stderr_base64: "ZXJy",
    truncated: false,
  };
  for (const variant of ["valid", "mismatch", "malformed", "native-error"]) {
    await Bun.write(
      runtime.binary,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(variant === "malformed" ? "not-json" : JSON.stringify({ ...reply, exit_code: variant === "mismatch" ? 8 : 7 }))});\n${variant === "native-error" ? 'console.error(JSON.stringify({code:"graph_service_exec",message:"synthetic-secret"}));' : ""}process.exit(7);`
    );
    const request = {
      runtime,
      cwd: runtime.home,
      args: ["graph", "exec", "--json", "--", "true"],
      serviceExecResponse: true,
    };
    if (variant === "valid") {
      expect(await invokeNativeRuntime(request)).toEqual(reply);
      await expect(
        invokeNativeRuntime({ ...request, serviceExecResponse: false })
      ).rejects.toThrow("request failed");
      await expect(
        invokeNativeRuntime({
          ...request,
          args: ["graph", "cleanup", "--json"],
        })
      ).rejects.toThrow("budget");
    } else if (variant === "native-error") {
      await expect(invokeNativeRuntime(request)).rejects.toThrow();
    } else {
      await expectClosedRefusal(
        invokeNativeRuntime(request),
        "Native exec returned an invalid or inconsistent completion response; command effects may have occurred."
      );
    }
  }
});

test("run-service uses explicit command completion transport without accepting unrelated operations", async () => {
  const runtime = await fixture();
  const reply = {
    job: "a".repeat(32),
    cleanup_confirmed: true,
    exit_code: 19,
    stdout_base64: "AP8=",
    stderr_base64: "",
    truncated: false,
  };
  await Bun.write(
    runtime.binary,
    `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(reply))});process.exit(19);`
  );
  const request = {
    runtime,
    cwd: runtime.home,
    serviceExecResponse: true,
    args: ["graph", "run-service", "--json", "--"],
  };
  expect(await invokeNativeRuntime(request)).toEqual(reply);
  await expect(
    invokeNativeRuntime({
      ...request,
      args: ["graph", "run-selection", "--json", "--"],
    })
  ).rejects.toThrow("budget");
});
