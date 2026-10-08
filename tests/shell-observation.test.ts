import { expect, test } from "bun:test";
import { type RunExitEvent, run } from "../src/lib/shell.ts";
import { runWithTerminalGroup } from "../src/lib/tty-run.ts";

test("slow diagnostics preserve an already-completed command's exit and callback order", async () => {
  const calls: string[] = [];
  let outcome: RunExitEvent | undefined;
  let setupFinishedAt = 0;
  const code = await run([process.execPath, "-e", "process.exit(7)"], {
    stdin: "ignore",
    timeoutMs: 1000,
    onSpawn: async () => {
      await Bun.sleep(1500);
      setupFinishedAt = Date.now();
      calls.push("spawn");
    },
    onExit: async (event) => {
      outcome = event;
      calls.push("exit");
    },
  });
  expect(code).toBe(7);
  expect(outcome).toMatchObject({
    exitCode: 7,
    timedOut: false,
    cancelled: false,
  });
  expect(calls).toEqual(["spawn", "exit"]);
  expect(Date.parse(outcome?.finishedAt ?? "")).toBeLessThan(setupFinishedAt);
});

test("completed process peak RSS is recorded in bytes on the executing platform", async () => {
  let peakBytes: number | null = null;
  const code = await run(
    [
      process.execPath,
      "-e",
      "const bytes = Buffer.alloc(64 * 1024 * 1024, 1); await Bun.sleep(50); if (bytes[bytes.length - 1] !== 1) process.exit(1);",
    ],
    {
      stdin: "ignore",
      onExit: async (event) => {
        peakBytes = event.maxRssBytes;
      },
    }
  );
  expect(code).toBe(0);
  expect(peakBytes).not.toBeNull();
  expect(Number(peakBytes)).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  expect(Number(peakBytes)).toBeLessThan(2 * 1024 * 1024 * 1024);
});
test("synchronous spawn admission refusal creates no owned child or exit observation", async () => {
  let spawned = false;
  let exited = false;
  const command = [process.execPath, "-e", "process.exit(0)"];
  const options = {
    stdin: "ignore",
    forwardSignals: true,
    beforeSpawn: () => {
      throw new Error("synthetic admission revoked after awaited setup");
    },
    onSpawn: () => {
      spawned = true;
      return Promise.resolve();
    },
    onExit: () => {
      exited = true;
      return Promise.resolve();
    },
  } as const;
  for (const effect of [
    () => run(command, options),
    () => runWithTerminalGroup({ ...options, command, env: {} }),
  ]) {
    await expect(effect()).rejects.toThrow(
      "synthetic admission revoked after awaited setup"
    );
    expect(spawned).toBe(false);
    expect(exited).toBe(false);
  }
});
