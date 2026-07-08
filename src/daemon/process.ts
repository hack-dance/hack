import { readTextFile, writeTextFile } from "../lib/fs.ts";

export async function readDaemonPid({
  pidPath,
}: {
  readonly pidPath: string;
}): Promise<number | null> {
  const text = await readTextFile(pidPath);
  if (!text) {
    return null;
  }
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

export async function writeDaemonPid({
  pidPath,
  pid,
}: {
  readonly pidPath: string;
  readonly pid: number;
}): Promise<void> {
  await writeTextFile(pidPath, `${pid}\n`);
}

export async function removeFileIfExists({
  path,
}: {
  readonly path: string;
}): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    // ignore missing file
  }
}

export function isProcessRunning({ pid }: { readonly pid: number }): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit({
  pid,
  timeoutMs,
  pollMs,
}: {
  readonly pid: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning({ pid })) {
      return true;
    }
    await sleep({ ms: pollMs });
  }
  return !isProcessRunning({ pid });
}

function sleep({ ms }: { readonly ms: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DAEMON_COMMAND_MARKER = "daemon start --foreground";

/**
 * Finds hackd processes that the pid file does not track ("orphans").
 *
 * Orphans appear when a daemon keeps running after its pid/socket files were
 * replaced or cleared (e.g. a launchd-managed instance surviving a manual
 * restart). They are invisible to status/start/clear, which only consult the
 * pid file — the root cause of "daemon starts then exits" contradictions:
 * the orphan holds the API while every newly spawned daemon exits.
 *
 * @param opts.trackedPid - pid currently recorded in the pid file, if any.
 * @param opts.psLines - injectable `ps -axo pid=,command=` lines for tests.
 */
export async function findOrphanDaemonProcesses(opts: {
  readonly trackedPid: number | null;
  readonly psLines?: readonly string[];
}): Promise<readonly number[]> {
  const lines = opts.psLines ?? (await listProcessTable());
  const orphans: number[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) {
      continue;
    }
    const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
    const command = trimmed.slice(spaceIdx + 1);
    if (!Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    if (!command.includes(DAEMON_COMMAND_MARKER)) {
      continue;
    }
    if (!isHackDaemonCommand({ command })) {
      continue;
    }
    if (pid === opts.trackedPid || pid === process.pid) {
      continue;
    }
    orphans.push(pid);
  }
  return orphans;
}

/**
 * True when the process command line is actually a hack daemon: the
 * executable's basename must be `hack`/`hack-*` (or a `bun .../hack`
 * dev-tree invocation). A bare substring match on the daemon arguments
 * would also kill unrelated processes that merely mention them.
 */
function isHackDaemonCommand(opts: { readonly command: string }): boolean {
  const firstToken = opts.command.trim().split(/\s+/)[0] ?? "";
  const base = firstToken.split("/").pop()?.toLowerCase() ?? "";
  if (base === "hack" || base.startsWith("hack-")) {
    return true;
  }
  if (base === "bun") {
    const secondToken = opts.command.trim().split(/\s+/)[1] ?? "";
    const secondBase = secondToken.split("/").pop()?.toLowerCase() ?? "";
    return secondBase === "index.ts" || secondBase.startsWith("hack");
  }
  return false;
}

async function listProcessTable(): Promise<readonly string[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.split("\n");
}

/**
 * Terminates orphan daemon processes (SIGTERM, bounded wait). Returns the
 * pids that were actually terminated.
 */
export async function terminateOrphanDaemonProcesses(opts: {
  readonly pids: readonly number[];
  readonly timeoutMs?: number;
}): Promise<readonly number[]> {
  const terminated: number[] = [];
  for (const pid of opts.pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    const exited = await waitForProcessExit({
      pid,
      timeoutMs: opts.timeoutMs ?? 3000,
      pollMs: 100,
    });
    if (exited) {
      terminated.push(pid);
    }
  }
  return terminated;
}
