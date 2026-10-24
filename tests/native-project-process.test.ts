import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveNativeProjectGraph } from "../src/backends/native-project-process.ts";
import { NATIVE_EXIT_DRAIN_BOUND_MS } from "../src/backends/native-runtime-client.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";

const roots: string[] = [];
const run = "a".repeat(32);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(program: string) {
  const root = await mkdtemp(join(tmpdir(), "native-process-"));
  roots.push(root);
  const script = join(root, "fake.ts"),
    binary = join(root, "fake-native");
  await writeFile(script, program);
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`
  );
  await chmod(binary, 0o700);
  return {
    runtime: { binary, home: root },
    projectRoot: root,
    run,
    args: ["--project", root],
    startupTimeoutMs: 2000,
  };
}
test("foreground owner receives private stdin, reports readiness once and returns completion", async () => {
  const opts = await fixture(`
    const input = JSON.parse(await Bun.stdin.text());
    if (input.value !== "synthetic-private-input" || process.argv.some(a => a.includes("synthetic-private-input"))) process.exit(19);
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(30);
    console.log(JSON.stringify({phase:"cleaned"}));
  `);
  let ready = 0;
  const code = await serveNativeProjectGraph({
    ...opts,
    privateInput: new TextEncoder().encode(
      JSON.stringify({ value: "synthetic-private-input" })
    ),
    onReady: async () => {
      ready++;
    },
  });
  expect(code).toBe(0);
  expect(ready).toBe(1);
});
test("wrong readiness identity never publishes a mapping and stops the owned child", async () => {
  const opts = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${"b".repeat(32)}"})); await Bun.sleep(10000);`
  );
  let ready = false;
  await expectClosedRefusal(
    serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        ready = true;
      },
    }),
    "identity"
  );
  expect(ready).toBe(false);
});
test("startup timeout and pre-cancellation do not become readiness", async () => {
  const opts = await fixture("await Bun.sleep(10000)");
  let ready = false;
  await expectClosedRefusal(
    serveNativeProjectGraph({
      ...opts,
      startupTimeoutMs: 30,
      onReady: async () => {
        ready = true;
      },
    }),
    "interrupted"
  );
  const controller = new AbortController();
  controller.abort();
  await expectClosedRefusal(
    serveNativeProjectGraph({
      ...opts,
      signal: controller.signal,
      onReady: async () => {
        ready = true;
      },
    }),
    "canceled"
  );
  expect(ready).toBe(false);
});
test("failed owner preserves nonzero completion and callback failure terminates ownership", async () => {
  const opts = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"})); await Bun.sleep(20); process.exit(23);`
  );
  expect(
    await serveNativeProjectGraph({ ...opts, onReady: async () => {} })
  ).toBe(23);
  const waiting = await fixture(
    `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"})); await Bun.sleep(10000);`
  );
  await expect(
    serveNativeProjectGraph({
      ...waiting,
      onReady: async () => {
        throw new Error("mapping refused");
      },
    })
  ).rejects.toThrow("mapping refused");
});

test("structured startup failure exposes its code without stderr values", async () => {
  const opts = await fixture(
    'console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));process.exit(2);'
  );
  let failure = "";
  try {
    await serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        throw new Error("must not become ready");
      },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("graph_budget");
  expect(failure).not.toContain("synthetic-private-detail");
});

test("cancellation preserves the owner's graceful cleanup beyond five seconds", async () => {
  const opts = await fixture(`
    process.on("SIGTERM", async () => {
      await Bun.sleep(6000);
      await Bun.write(${JSON.stringify("PLACEHOLDER")}, "cleaned");
      process.exit(0);
    });
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(30000);
  `);
  const marker = join(opts.projectRoot, "cleanup-complete");
  const file = join(opts.projectRoot, "fake.ts");
  await Bun.write(
    file,
    (await Bun.file(file).text()).replace("PLACEHOLDER", marker)
  );
  const controller = new AbortController();
  await expectClosedRefusal(
    serveNativeProjectGraph({
      ...opts,
      signal: controller.signal,
      onReady: async () => {
        setTimeout(() => controller.abort(), 20);
      },
    }),
    "interrupted"
  );
  expect(await Bun.file(marker).text()).toBe("cleaned");
}, 15_000);

test("early receiver rejection drains its safe code despite a broken private-input pipe", async () => {
  const opts = await fixture(`
    import { appendFileSync, closeSync } from "node:fs";
    appendFileSync("attempts", "attempt\\n");
    closeSync(0);
    await Bun.sleep(20);
    console.error(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));
    process.exit(2);
  `);
  let failure = "";
  let ready = 0;
  try {
    await serveNativeProjectGraph({
      ...opts,
      privateInput: new TextEncoder().encode(
        "synthetic-private-payload".repeat(10_000)
      ),
      onReady: async () => {
        ready++;
      },
    });
  } catch (error) {
    failure = String(error);
  }
  expect(failure).toContain("graph_budget");
  expect(failure).not.toContain("synthetic-private");
  expect(ready).toBe(0);
  expect(await Bun.file(join(opts.projectRoot, "attempts")).text()).toBe(
    "attempt\n"
  );
});

test("readiness rejection retains identity while observing safe native cleanup code", async () => {
  const opts = await fixture(`
    process.on("SIGTERM", () => {
      console.error(JSON.stringify({code:"graph_owner_recovery",message:"synthetic-private-cleanup"}));
      process.exit(2);
    });
    console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));
    await Bun.sleep(10000);
  `);
  const failure = new Error("synthetic TLS failure");
  let diagnostic: unknown;
  await expect(
    serveNativeProjectGraph({
      ...opts,
      onReady: async () => {
        throw failure;
      },
      onExitDiagnostic: (value) => {
        diagnostic = value;
        throw new Error("observer failure");
      },
    })
  ).rejects.toBe(failure);
  expect(diagnostic).toEqual({
    exitCode: 2,
    nativeCode: "graph_owner_recovery",
  });
  expect(Bun.inspect(diagnostic)).not.toContain("synthetic-private-cleanup");
});

/** Slack for host load between the stand-in's recorded exit and settlement. */
const DRAIN_SETTLE_MARGIN_MS = 5000;
/**
 * Fixed delay before the descendant writes the closed code, measured from the
 * test observing the stand-in reaped: well above the former 250 ms window.
 */
const LATE_CODE_DELAY_MS = 1000;
/**
 * Injected drain bound for the late-writer case: wide enough that host load
 * cannot push the delayed write past it, so the case proves that EOF, not a
 * fixed window, ends the drain. The held-descendant cases keep the production
 * bound and prove that it still ends a drain EOF cannot.
 */
const LATE_WRITER_DRAIN_BOUND_MS = 25_000;
/**
 * Gap between creating the stand-in's pid file and writing its digits. It
 * makes the empty-file window that a loaded host opens by chance happen on
 * every run, so a reader that only waits for existence fails every time.
 */
const TORN_HANDSHAKE_GAP_MS = 50;
/** Budget for a handshake file (a pid) to appear on a loaded host. */
const HANDSHAKE_BUDGET_MS = 20_000;
/** The stand-in's startup deadline; exit, not readiness, ends these cases. */
const STARTUP_TIMEOUT_MS = 60_000;
/** A held descendant always retires by itself, even if this test process dies. */
const DESCENDANT_CAP_MS = 60_000;
const SETTLEMENT_WAIT_MS = DESCENDANT_CAP_MS + 5000;
const CASE_TIMEOUT_MS = SETTLEMENT_WAIT_MS + STARTUP_TIMEOUT_MS;

async function waitForFile(path: string, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) {
      return false;
    }
    await Bun.sleep(10);
  }
  return true;
}

/**
 * Wait until a fixture's pid handshake holds a complete pid. A fixture's
 * writeFileSync creates the file before it writes the digits, so a read that
 * only waited for existence can see "": Number("") is 0, and kill(0, 0)
 * always succeeds, so the absence wait would never end. Returns undefined
 * when no complete pid appears within the budget.
 */
async function waitForPid(
  path: string,
  budgetMs: number
): Promise<number | undefined> {
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
      return undefined;
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

/**
 * Run `body`, then release the stand-in's descendant through `release` and
 * confirm it finished. An unconfirmed descendant retains the fixture root.
 */
async function settleDescendant(opts: {
  readonly root: string;
  readonly release: string;
  readonly finished: string;
  readonly body: () => Promise<void>;
}): Promise<void> {
  let failed: unknown;
  try {
    await opts.body();
  } catch (error: unknown) {
    failed = error;
  } finally {
    await Bun.write(join(opts.root, opts.release), "release");
  }
  const completed = await waitForFile(
    join(opts.root, opts.finished),
    SETTLEMENT_WAIT_MS
  );
  if (!completed) {
    roots.splice(roots.indexOf(opts.root), 1);
    throw new AggregateError(
      failed === undefined ? [] : [failed],
      `Owned descendant completion is unconfirmed; fixture retained at ${opts.root}.`
    );
  }
  if (failed !== undefined) {
    throw failed;
  }
}

// Keeps the stand-in's stdout and stderr open until the test releases it.
const HOLDING_KEEPER = `import {existsSync, writeFileSync} from "node:fs";
writeFileSync("keeper-pid", String(process.pid));
const end = Date.now() + ${DESCENDANT_CAP_MS};
while (!existsSync("release") && Date.now() < end) await Bun.sleep(20);
writeFileSync("keeper-finished", "finished");`;

test.each([
  ["ready", 0],
  ["early failure", 2],
] as const)(
  "%s exit settles within the named drain bound while a descendant holds stdout and stderr",
  async (mode, exitCode) => {
    const ready = mode === "ready";
    const nativeCode = ready ? "graph_owner_recovery" : "graph_budget";
    const opts = await fixture(`
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync } from "node:fs";
    spawn(process.execPath, ["--eval", ${JSON.stringify(HOLDING_KEEPER)}], {
      detached: true, stdio: ["ignore", 1, 2],
    }).unref();
    const deadline = Date.now() + ${HANDSHAKE_BUDGET_MS};
    while (!existsSync("keeper-pid") && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync("keeper-pid")) process.exit(3);
    ${ready ? `console.log(JSON.stringify({kind:"graph_foreground_ready",run:"${run}"}));` : ""}
    console.error(JSON.stringify({code:"${nativeCode}",message:"synthetic-private-detail"}));
    writeFileSync("exited-at", String(Date.now()));
    process.exit(${exitCode});
  `);
    const root = opts.projectRoot;
    await settleDescendant({
      root,
      release: "release",
      finished: "keeper-finished",
      body: async () => {
        let diagnostic: unknown;
        let readyCount = 0;
        let result: number | undefined;
        let caught: unknown;
        try {
          result = await serveNativeProjectGraph({
            ...opts,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            onReady: async () => {
              readyCount++;
            },
            onExitDiagnostic: (value) => {
              diagnostic = value;
            },
          });
        } catch (error: unknown) {
          caught = error;
        }
        const settledAt = Date.now();
        const exitedAt = Number(await Bun.file(join(root, "exited-at")).text());
        const keeper = await waitForPid(
          join(root, "keeper-pid"),
          HANDSHAKE_BUDGET_MS
        );
        expect(keeper).toBeDefined();
        // The bound, not the descendant's EOF, ended the drain: it is still holding.
        expect(processPresent(keeper ?? 0)).toBe(true);
        expect(await Bun.file(join(root, "keeper-finished")).exists()).toBe(
          false
        );
        expect(settledAt - exitedAt).toBeLessThan(
          NATIVE_EXIT_DRAIN_BOUND_MS + DRAIN_SETTLE_MARGIN_MS
        );
        if (ready) {
          expect(caught).toBeUndefined();
          expect(result).toBe(0);
          expect(readyCount).toBe(1);
        } else {
          expect(readyCount).toBe(0);
          const refusal = await expectClosedRefusal(
            Promise.reject(caught),
            nativeCode
          );
          expect(refusal.message).not.toContain("synthetic-private-detail");
        }
        expect(diagnostic).toEqual({ exitCode, nativeCode });
        expect(Bun.inspect(diagnostic)).not.toContain(
          "synthetic-private-detail"
        );
      },
    });
  },
  CASE_TIMEOUT_MS
);

// Writes the closed code on the stand-in's inherited stderr only after the
// test has observed the stand-in reaped, i.e. after its exit was reported.
const LATE_CODE_WRITER = `import {existsSync, writeFileSync} from "node:fs";
writeFileSync("writer-pid", String(process.pid));
const end = Date.now() + ${DESCENDANT_CAP_MS};
while (!existsSync("exit-observed") && Date.now() < end) await Bun.sleep(10);
if (existsSync("exit-observed")) {
  await Bun.sleep(${LATE_CODE_DELAY_MS});
  process.stderr.write(JSON.stringify({code:"graph_budget",message:"synthetic-private-detail"}));
}
writeFileSync("writer-finished", "finished");`;

test(
  "closed code written after the reported exit is kept regardless of a late reader",
  async () => {
    expect(LATE_CODE_DELAY_MS).toBeLessThan(LATE_WRITER_DRAIN_BOUND_MS);
    const opts = await fixture(`
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync } from "node:fs";
    spawn(process.execPath, ["--eval", ${JSON.stringify(LATE_CODE_WRITER)}], {
      detached: true, stdio: ["ignore", "ignore", 2],
    }).unref();
    const deadline = Date.now() + ${HANDSHAKE_BUDGET_MS};
    while (!existsSync("writer-pid") && Date.now() < deadline) await Bun.sleep(10);
    // Publish the pid in two steps, as a torn handshake: the reader must wait
    // for a complete pid, not just for the file to exist.
    writeFileSync("child-pid", "");
    await Bun.sleep(${TORN_HANDSHAKE_GAP_MS});
    writeFileSync("child-pid", String(process.pid));
    process.exit(existsSync("writer-pid") ? 2 : 3);
  `);
    const root = opts.projectRoot;
    await settleDescendant({
      root,
      release: "exit-observed",
      finished: "writer-finished",
      body: async () => {
        let diagnostic: unknown;
        let readyCount = 0;
        const outcome = serveNativeProjectGraph({
          ...opts,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          exitDrainBoundMs: LATE_WRITER_DRAIN_BOUND_MS,
          onReady: async () => {
            readyCount++;
          },
          onExitDiagnostic: (value) => {
            diagnostic = value;
          },
        });
        void outcome.catch(() => undefined);
        const child = await waitForPid(
          join(root, "child-pid"),
          HANDSHAKE_BUDGET_MS * 2
        );
        if (child === undefined) {
          throw new Error("Stand-in pid handshake did not complete.");
        }
        // Absence means the CLI reaped the stand-in: its exit has been reported.
        const deadline = performance.now() + HANDSHAKE_BUDGET_MS;
        while (processPresent(child) && performance.now() < deadline) {
          await Bun.sleep(10);
        }
        expect(processPresent(child)).toBe(false);
        await Bun.write(join(root, "exit-observed"), "observed");
        const refusal = await expectClosedRefusal(outcome, "graph_budget");
        expect(refusal.message).not.toContain("synthetic-private-detail");
        expect(readyCount).toBe(0);
        expect(diagnostic).toEqual({ exitCode: 2, nativeCode: "graph_budget" });
      },
    });
  },
  CASE_TIMEOUT_MS
);
