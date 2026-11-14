import { readLinuxParentPid } from "./process-image.ts";

const MAX_DEPTH = 64;
const DIGITS = /^\d+$/;

/**
 * Whether `ancestor` is this process (or `pid`) or one of its ancestors,
 * walking parent pids up to pid 1. Used before restarting a launchd job:
 * a `hack daemon start` run by a job hackd started must not restart the
 * service it runs under (HACK-2216). Null when the chain cannot be read;
 * callers then refuse.
 */
export async function hasAncestorProcess(opts: {
  readonly ancestor: number;
  readonly pid?: number;
  /** Defaults to `/proc` on Linux and `ps` on macOS. */
  readonly readParent?: (pid: number) => Promise<number | null>;
}): Promise<boolean | null> {
  const readParent = opts.readParent ?? defaultReadParent;
  let current = opts.pid ?? process.pid;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (current === opts.ancestor) {
      return true;
    }
    if (current <= 1) {
      return false;
    }
    const parent = await readParent(current);
    if (parent === null) {
      return null;
    }
    current = parent;
  }
  return null;
}

function defaultReadParent(pid: number): Promise<number | null> {
  return process.platform === "linux"
    ? readLinuxParentPid(pid)
    : readParentWithPs(pid);
}

async function readParentWithPs(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["/bin/ps", "-o", "ppid=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    try {
      const [code, text] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      const value = text.trim();
      return code === 0 && DIGITS.test(value)
        ? Number.parseInt(value, 10)
        : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
