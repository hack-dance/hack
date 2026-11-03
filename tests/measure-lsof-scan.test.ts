import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MeasureOptions,
  measure,
  type Spawn,
} from "../scripts/measure-lsof-scan.ts";

let scratch = "";

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "measure-lsof-scan-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A stand-in `lsof` running `body` as a shell script. */
async function fakeLsof(body: string): Promise<string> {
  const path = join(scratch, "lsof");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o700);
  return path;
}

type Started = { pid: number; command: string[] };

/** Spawn through Bun, recording every child; optionally fail one spawn. */
function recordingSpawn(failAt?: number): {
  spawn: Spawn;
  started: Started[];
} {
  const started: Started[] = [];
  let calls = 0;
  const spawn: Spawn = (command, options) => {
    calls += 1;
    if (calls === failAt) {
      throw new Error("spawn refused: resource pressure");
    }
    const child = Bun.spawn(command, options);
    started.push({ pid: child.pid, command });
    return child;
  };
  return { spawn, started };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const base: MeasureOptions = {
  runs: 1,
  concurrency: 1,
  burn: 0,
  scanTimeoutMs: 300,
};

describe("measure-lsof-scan", () => {
  test("reports a clean no-holder scan and leaves no child running", async () => {
    const { spawn, started } = recordingSpawn();
    const report = await measure({
      ...base,
      runs: 2,
      concurrency: 2,
      burn: 2,
      scanTimeoutMs: 10_000,
      lsof: await fakeLsof("exit 1"),
      spawn,
    });
    expect(report.sequential).toMatchObject({
      scans: 2,
      unclean: 0,
      timedOut: 0,
    });
    expect(report.concurrent).toMatchObject({
      scans: 2,
      unclean: 0,
      timedOut: 0,
    });
    expect(started).toHaveLength(6);
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("bounds a hung scan, kills it and still stops the burners", async () => {
    const { spawn, started } = recordingSpawn();
    const begun = performance.now();
    const report = await measure({
      ...base,
      burn: 2,
      lsof: await fakeLsof("exec sleep 600"),
      spawn,
    });
    expect(performance.now() - begun).toBeLessThan(10_000);
    expect(report.sequential).toMatchObject({ unclean: 1, timedOut: 1 });
    expect(report.concurrent).toMatchObject({ unclean: 1, timedOut: 1 });
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("bounds a scan whose output a descendant keeps open", async () => {
    const { spawn, started } = recordingSpawn();
    // The scan exits at once; its background child holds stdout past the bound.
    const begun = performance.now();
    const report = await measure({
      ...base,
      lsof: await fakeLsof("sleep 5 &\nexit 1"),
      spawn,
    });
    // Both rounds return at their bounds, not when the descendant lets go.
    expect(performance.now() - begun).toBeLessThan(4000);
    expect(report.sequential).toMatchObject({ unclean: 1, timedOut: 1 });
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("stops burners already started when a later spawn fails", async () => {
    const { spawn, started } = recordingSpawn(3);
    await expect(
      measure({ ...base, burn: 4, lsof: await fakeLsof("exit 1"), spawn })
    ).rejects.toThrow("spawn refused");
    expect(started).toHaveLength(2);
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("an abort during a hung scan stops every child", async () => {
    const { spawn, started } = recordingSpawn();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      measure(
        {
          ...base,
          burn: 1,
          scanTimeoutMs: 60_000,
          lsof: await fakeLsof("exec sleep 600"),
          spawn,
        },
        controller.signal
      )
    ).rejects.toThrow("aborted");
    expect(started).toHaveLength(2);
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("an already-aborted signal starts nothing", async () => {
    const { spawn, started } = recordingSpawn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      measure(
        { ...base, burn: 2, lsof: await fakeLsof("exit 1"), spawn },
        controller.signal
      )
    ).rejects.toThrow("aborted");
    expect(started).toEqual([]);
  });

  test("a failed spawn in the concurrent round stops its sibling scan", async () => {
    // Spawns 1-2 are the sequential round (quick scans); spawn 3 is a sibling
    // that hangs and spawn 4 fails.
    const { spawn, started } = recordingSpawn(4);
    const count = join(scratch, "count");
    await writeFile(count, "0");
    const lsof = await fakeLsof(
      `n=$(cat '${count}'); echo $((n + 1)) > '${count}'\n` +
        '[ "$n" -ge 2 ] && exec sleep 600\nexit 1'
    );
    const begun = performance.now();
    await expect(
      measure({
        ...base,
        runs: 2,
        concurrency: 2,
        scanTimeoutMs: 60_000,
        lsof,
        spawn,
      })
    ).rejects.toThrow("spawn refused");
    expect(performance.now() - begun).toBeLessThan(5000);
    expect(started).toHaveLength(3);
    expect(started.filter((child) => alive(child.pid))).toEqual([]);
  });

  test("SIGINT during a scan whose pipe a descendant holds exits promptly", async () => {
    // The scan exits at once; its background child holds the scan's stdout
    // far past the time the runner may take to exit.
    const lsof = await fakeLsof("sleep 8 &\nexit 1");
    const runner = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../scripts/measure-lsof-scan.ts"),
        "--runs",
        "1",
        "--scan-timeout",
        "60",
        "--lsof",
        lsof,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    await Bun.sleep(700);
    const signalled = performance.now();
    runner.kill("SIGINT");
    const exitCode = await runner.exited;
    expect(performance.now() - signalled).toBeLessThan(4000);
    expect(exitCode).toBe(130);
    expect(await new Response(runner.stderr).text()).toContain("aborted");
  });
});
