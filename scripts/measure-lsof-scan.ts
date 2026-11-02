#!/usr/bin/env bun
/**
 * Time the disk-handle scan the native stop and release paths run
 * (`lsof -n -P -t -- storage.raw overlay.raw`, see
 * `packages/runtime-core/src/provider/lifecycle.rs`), so the bounds
 * `STOP_HANDLE_WAIT` and `RELEASE_HANDLE_WAIT` can be checked against the host.
 *
 * `lsof` walks every process's descriptors, so its time grows with the process
 * count and with CPU contention. The scan targets two fresh sparse files in a
 * temporary directory; nothing holds them, so a healthy scan exits 1 with no
 * output, exactly the stop path's success case.
 *
 * Usage: bun scripts/measure-lsof-scan.ts [--runs N] [--concurrency C] [--burn B]
 *   --runs         scans per round (default 20)
 *   --concurrency  scans started at once in the concurrent round (default 8)
 *   --burn         busy-loop processes to run during both rounds (default 0),
 *                  to add CPU contention on an otherwise idle host
 *
 * Prints one JSON report: host platform, process count, load averages and
 * min/median/p95/max seconds for a sequential and a concurrent round. It
 * prints no paths, hostnames or process names.
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "20" },
    concurrency: { type: "string", default: "8" },
    burn: { type: "string", default: "0" },
  },
});
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const burn = Number(values.burn);
for (const [name, value] of [
  ["--runs", runs],
  ["--concurrency", concurrency],
] as const) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}
if (!Number.isInteger(burn) || burn < 0) {
  throw new Error("--burn must be a non-negative integer");
}

// The runtime invokes this fixed path on both platforms.
const LSOF = "/usr/sbin/lsof";
const directory = mkdtempSync(join(tmpdir(), "lsof-scan-"));
const disks = ["storage.raw", "overlay.raw"].map((name) => {
  const path = join(directory, name);
  writeFileSync(path, "");
  truncateSync(path, 1024 * 1024 * 1024);
  return path;
});

type Scan = { seconds: number; exitCode: number | null; clean: boolean };

async function scan(): Promise<Scan> {
  const started = performance.now();
  const child = Bun.spawn([LSOF, "-n", "-P", "-t", "--", ...disks], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    seconds: (performance.now() - started) / 1000,
    exitCode,
    clean: exitCode === 1 && stdout === "" && stderr === "",
  };
}

function summary(scans: Scan[]) {
  const seconds = scans.map((s) => s.seconds).sort((a, b) => a - b);
  const at = (q: number) =>
    seconds[Math.min(seconds.length - 1, Math.ceil(q * seconds.length) - 1)];
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    scans: scans.length,
    unclean: scans.filter((s) => !s.clean).length,
    min: round(seconds[0]),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(seconds.at(-1) ?? 0),
  };
}

function processCount(): number {
  const ps = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid="]);
  return ps.stdout.toString().split("\n").filter(Boolean).length;
}

const burners = Array.from({ length: burn }, () =>
  Bun.spawn(["/bin/sh", "-c", "while :; do :; done"], {
    stdout: "ignore",
    stderr: "ignore",
  })
);

try {
  const before = { processes: processCount(), load: loadavg() };
  const sequential: Scan[] = [];
  for (let i = 0; i < runs; i++) {
    sequential.push(await scan());
  }
  const concurrent: Scan[] = [];
  for (let done = 0; done < runs; done += concurrency) {
    const batch = Math.min(concurrency, runs - done);
    concurrent.push(
      ...(await Promise.all(Array.from({ length: batch }, () => scan())))
    );
  }
  const report = {
    platform: platform(),
    cpus: cpus().length,
    burn,
    before,
    after: { processes: processCount(), load: loadavg() },
    sequential: summary(sequential),
    concurrent: { concurrency, ...summary(concurrent) },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const burner of burners) {
    burner.kill();
  }
  rmSync(directory, { recursive: true, force: true });
}
