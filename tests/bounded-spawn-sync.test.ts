import { expect, test } from "bun:test";
import {
  describeCommand,
  SyncSpawnTimeoutError,
  spawnSyncBounded,
} from "./helpers/bounded-spawn-sync.ts";

test("a child that never finishes is killed at the bound and named in the error", () => {
  const started = performance.now();
  expect(() => spawnSyncBounded(["sleep", "30"], { timeout: 200 })).toThrow(
    new SyncSpawnTimeoutError({ command: "sleep 30", timeoutMs: 200 })
  );
  expect(performance.now() - started).toBeLessThan(10_000);
});

test("a child stopped before it does any work is still killed at the bound", () => {
  // Stand-in for a child that hangs before it starts (HACK-2247): it stops
  // itself at once, and SIGKILL still ends a stopped process.
  expect(() =>
    spawnSyncBounded(["/bin/sh", "-c", "kill -STOP $$"], { timeout: 200 })
  ).toThrow(/^\/bin\/sh -c kill -STOP \$\$ did not finish within 200 ms/);
});

test("a finished child's result is returned unchanged, including a failure", () => {
  const ok = spawnSyncBounded(["/bin/sh", "-c", "echo out; exit 3"]);
  expect(ok.exitCode).toBe(3);
  expect(ok.stdout.toString()).toBe("out\n");
});

test("long commands are shortened in the name", () => {
  expect(describeCommand(["git", "commit", "-m", "message"])).toBe(
    "git commit -m …"
  );
  expect(describeCommand(["ps"])).toBe("ps");
});
