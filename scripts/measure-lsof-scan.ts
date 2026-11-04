#!/usr/bin/env bun
/**
 * Time the disk-handle scan the native stop and release paths run
 * (`lsof -n -P -t -- storage.raw overlay.raw`, see
 * `packages/runtime-core/src/provider/lifecycle/disk_handles.rs`), so the bounds
 * `STOP_HANDLE_WAIT` and `RELEASE_HANDLE_WAIT` can be checked against the host.
 *
 * `lsof` walks every process's descriptors, so its time grows with the process
 * count and with CPU contention. The scan targets two fresh sparse files in a
 * temporary directory; nothing holds them, so a healthy scan exits 1 with no
 * output, exactly the stop path's success case.
 *
 * Usage: bun scripts/measure-lsof-scan.ts [--runs N] [--concurrency C] [--burn B]
 *                                          [--scan-timeout SECONDS] [--lsof PATH]
 *   --runs          scans per round (default 20)
 *   --concurrency   scans started at once in the concurrent round (default 8)
 *   --burn          busy-loop processes to run during both rounds (default 0),
 *                   to add CPU contention on an otherwise idle host
 *   --scan-timeout  bound on one scan, its exit and its output (default 120)
 *   --lsof          the lsof to time (default /usr/sbin/lsof, the runtime's)
 *
 * Prints one JSON report: host platform, process count, load averages and
 * min/median/p95/max seconds for a sequential and a concurrent round. It
 * prints no paths, hostnames or process names.
 *
 * Every child (scan and burner) is registered the moment it is spawned and is
 * killed and awaited on every exit path: success, a failed spawn part-way
 * through launching burners, a scan that exceeds its bound, or SIGINT/SIGTERM.
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The fixed `lsof` the runtime invokes on both platforms. */
export const HOST_LSOF = "/usr/sbin/lsof";

type Child = {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | number | undefined | null;
  readonly stderr: ReadableStream<Uint8Array> | number | undefined | null;
  kill(signal?: number | NodeJS.Signals): void;
};

export type Spawn = (
  command: string[],
  options: {
    env?: Record<string, string>;
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
  }
) => Child;

export type MeasureOptions = {
  runs: number;
  concurrency: number;
  burn: number;
  scanTimeoutMs: number;
  lsof?: string;
  spawn?: Spawn;
};

export type Scan = {
  seconds: number;
  exitCode: number | null;
  clean: boolean;
  timedOut: boolean;
};

/** Children this run owns; each is killed and awaited before the run returns. */
class Owned {
  readonly #children = new Set<Child>();
  readonly #spawn: Spawn;

  constructor(spawn: Spawn) {
    this.#spawn = spawn;
  }

  spawn(...args: Parameters<Spawn>): Child {
    const child = this.#spawn(...args);
    this.#children.add(child);
    return child;
  }

  async release(child: Child): Promise<void> {
    this.#children.delete(child);
    await stop(child);
  }

  async stopAll(): Promise<void> {
    const children = [...this.#children];
    this.#children.clear();
    await Promise.all(children.map(stop));
  }
}

async function stop(child: Child): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  await child.exited;
}

/** Read a stream to its end, or stop reading when `abort` settles. */
async function drain(
  stream: Child["stdout"],
  abort: Promise<unknown>
): Promise<string> {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  // Cancelling ends the pending read, so a descendant holding the pipe cannot
  // keep this loop (or the run) waiting past the scan's bound.
  abort.then(() => reader.cancel().catch(() => undefined));
  while (true) {
    const { done, value } = await reader.read().catch(() => ({
      done: true as const,
      value: undefined,
    }));
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString();
}

class Aborted extends Error {
  constructor() {
    super("aborted");
  }
}

/**
 * One bounded scan. It ends at the first of: the scan completing (exit and
 * both streams closed), its bound, or `run` aborting. On every path its timer
 * and abort listener are removed, its child is killed and awaited and both
 * reads are cancelled and awaited, so nothing of it outlives the call.
 */
async function scan(
  owned: Owned,
  lsof: string,
  disks: string[],
  timeoutMs: number,
  run: AbortSignal
): Promise<Scan> {
  if (run.aborted) {
    throw new Aborted();
  }
  const started = performance.now();
  const child = owned.spawn([lsof, "-n", "-P", "-t", "--", ...disks], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<"timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    onAbort = () => resolve("aborted");
    run.addEventListener("abort", onAbort, { once: true });
  });
  // The bound covers the exit and both streams closing, as in the runtime.
  const stdoutRead = drain(child.stdout, stopped);
  const stderrRead = drain(child.stderr, stopped);
  const finished = Promise.all([stdoutRead, stderrRead, child.exited]);
  let outcome: Awaited<typeof finished> | "timeout" | "aborted" = "aborted";
  let seconds = 0;
  try {
    outcome = await Promise.race([finished, stopped]);
    seconds = (performance.now() - started) / 1000;
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      run.removeEventListener("abort", onAbort);
    }
    await owned.release(child);
    // A stopped scan cancelled both reads, so this settles at once even when
    // a descendant still holds a pipe; no read outlives the scan.
    await Promise.allSettled([stdoutRead, stderrRead]);
  }
  if (outcome === "aborted") {
    throw new Aborted();
  }
  if (outcome === "timeout") {
    return { seconds, exitCode: null, clean: false, timedOut: true };
  }
  const [stdout, stderr, exitCode] = outcome;
  return {
    seconds,
    exitCode,
    clean: exitCode === 1 && stdout === "" && stderr === "",
    timedOut: false,
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
    timedOut: scans.filter((s) => s.timedOut).length,
    min: round(seconds[0] ?? 0),
    median: round(at(0.5) ?? 0),
    p95: round(at(0.95) ?? 0),
    max: round(seconds.at(-1) ?? 0),
  };
}

function processCount(): number {
  const ps = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid="]);
  return ps.stdout.toString().split("\n").filter(Boolean).length;
}

const defaultSpawn: Spawn = (command, options) => Bun.spawn(command, options);

/**
 * Run both rounds and return the report. `signal` aborts the run; owned
 * children are stopped and the scratch directory removed on every path.
 */
export async function measure(options: MeasureOptions, signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Aborted();
  }
  const owned = new Owned(options.spawn ?? defaultSpawn);
  const lsof = options.lsof ?? HOST_LSOF;
  // Aborted by the caller's signal, or by teardown after any failure, so a
  // sibling scan never outlives the run.
  const run = new AbortController();
  const forward = () => run.abort();
  signal?.addEventListener("abort", forward, { once: true });
  const active = new Set<Promise<Scan>>();
  const directory = mkdtempSync(join(tmpdir(), "lsof-scan-"));
  try {
    const disks = ["storage.raw", "overlay.raw"].map((name) => {
      const path = join(directory, name);
      writeFileSync(path, "");
      truncateSync(path, 1024 * 1024 * 1024);
      return path;
    });
    for (let i = 0; i < options.burn; i++) {
      owned.spawn(["/bin/sh", "-c", "while :; do :; done"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    const one = () => {
      const pending = scan(
        owned,
        lsof,
        disks,
        options.scanTimeoutMs,
        run.signal
      );
      active.add(pending);
      pending.then(
        () => active.delete(pending),
        () => active.delete(pending)
      );
      return pending;
    };
    const before = { processes: processCount(), load: loadavg() };
    const sequential: Scan[] = [];
    for (let i = 0; i < options.runs; i++) {
      sequential.push(await one());
    }
    const concurrent: Scan[] = [];
    for (let done = 0; done < options.runs; done += options.concurrency) {
      const batch = Math.min(options.concurrency, options.runs - done);
      concurrent.push(
        ...(await Promise.all(Array.from({ length: batch }, one)))
      );
    }
    return {
      platform: platform(),
      cpus: cpus().length,
      burn: options.burn,
      scanTimeoutSeconds: options.scanTimeoutMs / 1000,
      before,
      after: { processes: processCount(), load: loadavg() },
      sequential: summary(sequential),
      concurrent: { concurrency: options.concurrency, ...summary(concurrent) },
    };
  } finally {
    run.abort();
    signal?.removeEventListener("abort", forward);
    await Promise.allSettled([...active]);
    await owned.stopAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseOptions(): MeasureOptions {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "20" },
      concurrency: { type: "string", default: "8" },
      burn: { type: "string", default: "0" },
      "scan-timeout": { type: "string", default: "120" },
      lsof: { type: "string", default: HOST_LSOF },
    },
  });
  const positive = (name: string, value: number) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  };
  const burn = Number(values.burn);
  if (!Number.isInteger(burn) || burn < 0) {
    throw new Error("--burn must be a non-negative integer");
  }
  return {
    runs: positive("--runs", Number(values.runs)),
    concurrency: positive("--concurrency", Number(values.concurrency)),
    burn,
    scanTimeoutMs:
      positive("--scan-timeout", Number(values["scan-timeout"])) * 1000,
    lsof: values.lsof,
  };
}

if (import.meta.main) {
  const options = parseOptions();
  const controller = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => controller.abort());
  }
  try {
    const report = await measure(options, controller.signal);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
}
