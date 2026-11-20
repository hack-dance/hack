#!/usr/bin/env bun
/**
 * Time the disk-handle scan the native stop and release paths run (see
 * `packages/runtime-core/src/provider/lifecycle/disk_handles.rs`), so the bounds
 * `STOP_HANDLE_WAIT` and `RELEASE_HANDLE_WAIT` can be checked against the host.
 *
 * The runtime scans the host's process table in its own process. With
 * `--scan-binary` this script times that scan: it runs the runtime's ignored
 * unit-test fixture `one_timed_host_scan`, which scans for two fresh unheld
 * files and prints the scan's own time, and reports that time, without the
 * test binary's start-up. Build the binary with
 * `cargo test --lib --no-run` in `packages/runtime-core`; Cargo prints its path.
 *
 * Without `--scan-binary` it times the `lsof` child the runtime ran before and
 * still falls back to (`lsof -n -P -t -- storage.raw overlay.raw`), as a
 * baseline to compare with. `lsof` exits 1 with no output when nothing holds
 * the files.
 *
 * Either scan walks every process, so its time grows with the process count
 * and with CPU contention.
 *
 * Usage: bun scripts/measure-lsof-scan.ts [--runs N] [--concurrency C] [--burn B]
 *                                          [--scan-timeout SECONDS]
 *                                          [--scan-binary PATH | --lsof PATH]
 *   --runs          scans per round (default 20)
 *   --concurrency   scans started at once in the concurrent round (default 8)
 *   --burn          busy-loop processes to run during both rounds (default 0),
 *                   to add CPU contention on an otherwise idle host
 *   --scan-timeout  bound on one scan, its exit and its output (default 120)
 *   --scan-binary   the runtime-core unit-test binary; times the runtime's scan
 *   --lsof          the lsof to time as the baseline (default /usr/sbin/lsof)
 *
 * Prints one JSON report: host platform, which scan was timed, process count,
 * load averages and min/median/p95/max seconds for a sequential and a
 * concurrent round. It prints no paths, hostnames or process names.
 *
 * Every child (scan and burner) is registered the moment it is spawned and is
 * killed and awaited on every exit path: success, a failed spawn part-way
 * through launching burners, a scan that exceeds its bound, or SIGINT/SIGTERM.
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** The first `lsof` the runtime's fallback tries; it then tries /usr/bin/lsof. */
export const HOST_LSOF = "/usr/sbin/lsof";

/** The runtime's ignored unit-test fixture that runs and times one scan. */
export const SCAN_FIXTURE =
  "provider::lifecycle::disk_handles::tests::one_timed_host_scan";

/** The line the fixture prints: the seconds its scan took. */
const FIXTURE_SECONDS = /disk_handle_scan_seconds=(\d+(?:\.\d+)?)/;

/** What one scan runs and how its result is read. */
type Scanner = {
  readonly name: "in-process" | "lsof";
  command(disks: string[]): string[];
  /** The scan's seconds when it proved nothing holds the files, else null. */
  clean(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    wallSeconds: number;
  }): number | null;
};

/** The runtime's own scan, through its fixture, timed by the fixture itself. */
function inProcessScanner(binary: string): Scanner {
  return {
    name: "in-process",
    // The fixture scans for two files of its own, so `disks` is not passed.
    command: () => [
      binary,
      "--exact",
      SCAN_FIXTURE,
      "--ignored",
      "--nocapture",
    ],
    clean: ({ exitCode, stdout }) => {
      const seconds = FIXTURE_SECONDS.exec(stdout)?.[1];
      return exitCode === 0 && seconds !== undefined ? Number(seconds) : null;
    },
  };
}

/** The `lsof` child the runtime ran before, timed from spawn to exit. */
function lsofScanner(lsof: string): Scanner {
  return {
    name: "lsof",
    command: (disks) => [lsof, "-n", "-P", "-t", "--", ...disks],
    clean: ({ exitCode, stdout, stderr, wallSeconds }) =>
      exitCode === 1 && stdout === "" && stderr === "" ? wallSeconds : null,
  };
}

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
  /** The runtime-core unit-test binary; when set, its scan is timed. */
  scanBinary?: string;
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
  scanner: Scanner,
  disks: string[],
  timeoutMs: number,
  run: AbortSignal
): Promise<Scan> {
  if (run.aborted) {
    throw new Aborted();
  }
  const started = performance.now();
  const child = owned.spawn(scanner.command(disks), {
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
  const clean = scanner.clean({
    exitCode,
    stdout,
    stderr,
    wallSeconds: seconds,
  });
  return {
    seconds: clean ?? seconds,
    exitCode,
    clean: clean !== null,
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
  const scanner =
    options.scanBinary === undefined
      ? lsofScanner(options.lsof ?? HOST_LSOF)
      : inProcessScanner(options.scanBinary);
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
        scanner,
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
      scanner: scanner.name,
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
      "scan-binary": { type: "string" },
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
    scanBinary: values["scan-binary"],
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
