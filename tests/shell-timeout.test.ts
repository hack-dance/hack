import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { exec, run } from "../src/lib/shell.ts";

const tempDirs: string[] = [];
const childPids: number[] = [];

afterEach(async () => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped by the timeout cleanup under test.
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

test("exec timeout terminates the subprocess group and reports 124", async () => {
  const startedAt = Date.now();
  const result = await exec(["/bin/sh", "-c", "sleep 5"], {
    stdin: "ignore",
    timeoutMs: 50,
  });

  expect(result.exitCode).toBe(124);
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

test("run timeout kills descendants after the direct child exits on SIGTERM", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "hack-shell-timeout-"));
  tempDirs.push(dir);
  const pidFile = resolve(dir, "child.pid");

  const exitCode = await run(
    [
      "/bin/sh",
      "-c",
      `trap 'exit 0' TERM; (trap '' TERM; sleep 30) & echo $! > '${pidFile}'; wait`,
    ],
    { stdin: "ignore", timeoutMs: 50 }
  );
  expect(exitCode).toBe(124);

  const childPid = Number.parseInt(
    (await readFile(pidFile, "utf8")).trim(),
    10
  );
  childPids.push(childPid);
  await Bun.sleep(50);
  expect(isProcessAlive(childPid)).toBe(false);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
