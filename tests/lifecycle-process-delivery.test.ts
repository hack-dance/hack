import { afterEach, test as bunTest, expect } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  LIFECYCLE_PROCESS_CLIENT,
  serveLifecycleProcessDelivery,
} from "../src/lib/lifecycle-process-delivery.ts";
import { run } from "../src/lib/shell.ts";

const roots = new Set<string>();
let unknown = false;
let active = false;
let unconfirmed = false;
function test(name: string, body: () => Promise<void>, timeout?: number) {
  bunTest(
    name,
    async () => {
      if (active || unknown || unconfirmed) {
        throw new Error("Prior owned child is unconfirmed");
      }
      active = true;
      try {
        await body();
      } catch (error) {
        unconfirmed = true;
        throw error;
      } finally {
        active = false;
      }
    },
    timeout
  );
}
afterEach(async () => {
  if (active || unknown || unconfirmed) {
    unconfirmed = true;
    return;
  }
  for (const root of roots) {
    await rm(root, { recursive: true });
  }
  roots.clear();
});
async function fixture() {
  if (unknown) {
    throw new Error("Prior owned child is unconfirmed");
  }
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "hack-host-delivery-"))
  );
  roots.add(root);
  const abort = new AbortController();
  const deadline = performance.now() + 5000;
  const remaining = () => {
    const result = Math.ceil(deadline - performance.now());
    if (abort.signal.aborted || result < 1) {
      throw new Error("expired");
    }
    return result;
  };
  return { root, abort, remaining };
}
test("private delivery keeps per-process values out of mux command arguments and preserves exact exit", async () => {
  const f = await fixture();
  const canary = "synthetic-managed-handoff-canary";
  const delivery = await serveLifecycleProcessDelivery({
    root: f.root,
    launch: {
      command: [
        process.execPath,
        "--no-env-file",
        "-e",
        "process.exit(process.env.HANDOFF_VALUE === process.env.HANDOFF_EXPECT && process.env.LEAKED_PARENT === undefined ? 17 : 9)",
      ],
      cwd: f.root,
      env: { HANDOFF_VALUE: canary, HANDOFF_EXPECT: canary },
    },
    signal: f.abort.signal,
    remaining: f.remaining,
    assertFresh: () => Promise.resolve(),
  });
  const args = [
    process.execPath,
    "--no-env-file",
    resolve(import.meta.dir, "../index.ts"),
    LIFECYCLE_PROCESS_CLIENT,
    delivery.path,
  ];
  expect(JSON.stringify(args)).not.toContain(canary);
  let group: number | undefined;
  let exited = false;
  unknown = true;
  try {
    const code = await run(args, {
      env: { LEAKED_PARENT: "synthetic-inherited-value" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeoutMs: 5000,
      forwardSignals: true,
      onSpawn: (event) => {
        group = event.ownsProcessGroup
          ? (event.processGroupId ?? event.pid)
          : undefined;
        return Promise.resolve();
      },
      onExit: () => {
        exited = true;
        return Promise.resolve();
      },
    });
    expect(code).toBe(17);
    await delivery.started();
    expect(exited).toBe(true);
    expect(group).toBeDefined();
    let absent = false;
    try {
      process.kill(-(group ?? 0), 0);
    } catch (error) {
      absent =
        error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(absent).toBe(true);
    unknown = false;
  } finally {
    await delivery.close();
  }
  expect(await readdir(f.root)).toEqual([]);
}, 10_000);

test("pre-aborted delivery refuses without creating a handoff or opening values", async () => {
  const f = await fixture();
  f.abort.abort();
  await expect(
    serveLifecycleProcessDelivery({
      root: f.root,
      launch: { command: ["false"], cwd: f.root, env: {} },
      signal: f.abort.signal,
      remaining: f.remaining,
      assertFresh: () => Promise.resolve(),
    })
  ).rejects.toThrow("expired");
  expect(await readdir(f.root)).toEqual([]);
});

test("source drift at delivery claim refuses before the client command", async () => {
  const f = await fixture();
  let fresh = true;
  const delivery = await serveLifecycleProcessDelivery({
    root: f.root,
    launch: { command: ["false"], cwd: f.root, env: {} },
    signal: f.abort.signal,
    remaining: f.remaining,
    assertFresh: () =>
      fresh
        ? Promise.resolve()
        : Promise.reject(new Error("synthetic-private-canary")),
  });
  fresh = false;
  let settled = false;
  let group: number | undefined;
  unknown = true;
  try {
    const code = await run(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../index.ts"),
        LIFECYCLE_PROCESS_CLIENT,
        delivery.path,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeoutMs: 5000,
        forwardSignals: true,
        onSpawn: (event) => {
          group = event.ownsProcessGroup
            ? (event.processGroupId ?? event.pid)
            : undefined;
          return Promise.resolve();
        },
        onExit: () => {
          settled = true;
          return Promise.resolve();
        },
      }
    );
    expect(code).toBe(1);
    expect(settled).toBe(true);
    await expect(delivery.started()).rejects.toThrow("incomplete");
    expect(group).toBeDefined();
    let absent = false;
    try {
      process.kill(-(group ?? 0), 0);
    } catch (error) {
      absent =
        error instanceof Error && "code" in error && error.code === "ESRCH";
    }
    expect(absent).toBe(true);
    unknown = false;
  } finally {
    await delivery.close();
  }
});
