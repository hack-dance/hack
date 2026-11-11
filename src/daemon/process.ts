import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { readTextFile, writeTextFile } from "../lib/fs.ts";
import { readObservedProcesses } from "../lib/host-command-observation.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";

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
  // `kill(0, ...)` targets the caller's process group and a negative pid a
  // whole group: neither is ever a daemon pid, so both read as absent.
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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
const WHITESPACE_PATTERN = /\s+/;

/**
 * Finds hackd processes that the pid file does not track ("orphans").
 *
 * Orphans appear when a daemon keeps running after its pid/socket files were
 * replaced or cleared (e.g. a launchd-managed instance surviving a manual
 * restart). They are invisible to status/start/clear, which only consult the
 * pid file — the root cause of "daemon starts then exits" contradictions:
 * the orphan holds the API while every newly spawned daemon exits.
 *
 * Only processes holding a socket in the target daemon directory are eligible.
 * A command-name match alone cannot distinguish another HOME/HACK_HOME daemon.
 * Missing ownership evidence must never authorize termination.
 *
 * @param opts.trackedPid - pid currently recorded in the pid file, if any.
 * @param opts.psLines - injectable `ps -axo pid=,command=` lines for tests.
 */
export async function findOrphanDaemonProcesses(opts: {
  readonly trackedPid: number | null;
  readonly daemonRoot: string;
  readonly psLines?: readonly string[];
  readonly lsofLines?: readonly string[];
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
  if (orphans.length === 0) {
    return [];
  }
  const owners = await findDaemonSocketOwners({
    daemonRoot: opts.daemonRoot,
    lines: opts.lsofLines ?? (await listOpenUnixSockets({ pids: orphans })),
  });
  return orphans.filter((orphan) => owners.has(orphan));
}

async function findDaemonSocketOwners(opts: {
  readonly daemonRoot: string;
  readonly lines: readonly string[];
}): Promise<ReadonlySet<number>> {
  const roots = new Set([resolve(opts.daemonRoot)]);
  try {
    roots.add(await realpath(opts.daemonRoot));
  } catch {
    // A deleted directory can still appear in an open socket's pathname.
  }
  const socketPaths = new Set(
    [...roots].flatMap((root) =>
      ["hackd.sock", "hackd.internal.sock", "gateway.internal.sock"].flatMap(
        (name) => {
          const path = resolve(root, name);
          // Linux lsof includes the Unix socket type in its machine-readable name.
          return [path, `${path} type=STREAM`];
        }
      )
    )
  );
  const owners = new Set<number>();
  let pid: number | null = null;
  for (const line of opts.lines) {
    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10);
    } else if (
      pid !== null &&
      line.startsWith("n") &&
      socketPaths.has(line.slice(1))
    ) {
      owners.add(pid);
    }
  }
  return owners;
}

async function listOpenUnixSockets(opts: {
  readonly pids: readonly number[];
}): Promise<readonly string[]> {
  const lsof = findExecutableInPath("lsof");
  if (!lsof) {
    return [];
  }
  try {
    const result = await exec(
      // Socket names do not need filesystem stat/readlink calls, which can
      // block on unrelated mounted filesystems during daemon recovery.
      [lsof, "-nP", "-b", "-w", "-a", "-U", "-p", opts.pids.join(","), "-Fpn"],
      { stdin: "ignore", timeoutMs: 3000 }
    );
    return result.exitCode === 0 ? result.stdout.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * True when the process command line is actually a hack daemon: the
 * executable's basename must be `hack`/`hack-*` (or a `bun .../hack`
 * dev-tree invocation). A bare substring match on the daemon arguments
 * would also kill unrelated processes that merely mention them.
 */
function isHackDaemonCommand(opts: { readonly command: string }): boolean {
  const firstToken = opts.command.trim().split(WHITESPACE_PATTERN)[0] ?? "";
  const base = firstToken.split("/").pop()?.toLowerCase() ?? "";
  if (base === "hack" || base.startsWith("hack-")) {
    return true;
  }
  if (base === "bun") {
    const secondToken = opts.command.trim().split(WHITESPACE_PATTERN)[1] ?? "";
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

export type DaemonProcessRefusal =
  | "invalid-pid"
  | "not-running"
  | "identity-unknown"
  | "not-hackd"
  | "foreign-socket"
  | "identity-changed";

export type DaemonProcessProof =
  | { readonly kind: "owned"; readonly pid: number; readonly birth: string }
  | { readonly kind: "refused"; readonly reason: DaemonProcessRefusal };

/** The observations a proof uses; injectable so tests can model each refusal. */
export interface DaemonProcessProbe {
  /** Process start time (`ps -o lstart=`), or null when unknown. */
  readonly birth: (pid: number) => Promise<string | null>;
  /** Full command line, or null when unknown. */
  readonly command: (pid: number) => Promise<string | null>;
  /**
   * Pids among `pids` holding one of this daemon root's sockets; null when
   * socket ownership cannot be observed (no `lsof`).
   */
  readonly socketOwners: (opts: {
    readonly daemonRoot: string;
    readonly pids: readonly number[];
  }) => Promise<ReadonlySet<number> | null>;
}

export const defaultDaemonProcessProbe: DaemonProcessProbe = {
  birth: async (pid) => {
    const rows = await readObservedProcesses([pid]);
    return rows?.find((row) => row.pid === pid)?.birth ?? null;
  },
  command: async (pid) => {
    try {
      const result = await exec(["ps", "-o", "command=", "-p", String(pid)], {
        stdin: "ignore",
        timeoutMs: 2000,
      });
      const text = result.stdout.trim();
      return result.exitCode === 0 && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  },
  socketOwners: async ({ daemonRoot, pids }) => {
    // Linux: /proc needs no extra tool (lsof is missing on minimal installs).
    if (process.platform === "linux") {
      return await findDaemonSocketOwnersFromProc({ daemonRoot, pids });
    }
    if (!findExecutableInPath("lsof")) {
      return null;
    }
    return await findDaemonSocketOwners({
      daemonRoot,
      lines: await listOpenUnixSockets({ pids }),
    });
  },
};

/**
 * Proves that `pid` is this state root's hackd before anything signals it.
 *
 * Liveness is not identity: a pid file can name a recycled pid, another
 * HACK_HOME's daemon, or `0` (the caller's own process group). The proof
 * requires all of: a positive pid other than this process; a known start
 * time; a hack daemon command line (`... daemon start --foreground`); and an
 * open socket in `daemonRoot`. The start time is read again at the end and
 * must not have changed, so the pid was not reused while it was checked.
 * Missing evidence refuses; it never authorizes a signal.
 */
export async function proveOwnedDaemonProcess(opts: {
  readonly pid: number;
  readonly daemonRoot: string;
  readonly probe?: DaemonProcessProbe;
  /**
   * Retry a `foreign-socket` refusal this many times, 250 ms apart (default
   * 4): a hackd that just wrote its pid file may not have bound its socket
   * yet. Other refusals are final.
   */
  readonly socketRetries?: number;
}): Promise<DaemonProcessProof> {
  const retries = opts.socketRetries ?? 4;
  let proof = await proveOwnedDaemonProcessOnce(opts);
  for (
    let attempt = 0;
    attempt < retries &&
    proof.kind === "refused" &&
    proof.reason === "foreign-socket";
    attempt += 1
  ) {
    await sleep({ ms: 250 });
    proof = await proveOwnedDaemonProcessOnce(opts);
  }
  return proof;
}

async function proveOwnedDaemonProcessOnce(opts: {
  readonly pid: number;
  readonly daemonRoot: string;
  readonly probe?: DaemonProcessProbe;
}): Promise<DaemonProcessProof> {
  const probe = opts.probe ?? defaultDaemonProcessProbe;
  const { pid } = opts;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return { kind: "refused", reason: "invalid-pid" };
  }
  if (!isProcessRunning({ pid })) {
    return { kind: "refused", reason: "not-running" };
  }
  const birth = await probe.birth(pid);
  if (birth === null) {
    return { kind: "refused", reason: "identity-unknown" };
  }
  const command = await probe.command(pid);
  if (
    command === null ||
    !command.includes(DAEMON_COMMAND_MARKER) ||
    !isHackDaemonCommand({ command })
  ) {
    return { kind: "refused", reason: "not-hackd" };
  }
  const owners = await probe.socketOwners({
    daemonRoot: opts.daemonRoot,
    pids: [pid],
  });
  if (owners === null) {
    return { kind: "refused", reason: "identity-unknown" };
  }
  if (!owners.has(pid)) {
    return { kind: "refused", reason: "foreign-socket" };
  }
  if ((await probe.birth(pid)) !== birth) {
    return { kind: "refused", reason: "identity-changed" };
  }
  return { kind: "owned", pid, birth };
}

/** Plain-language reason for a refused proof, for logs. */
export function describeDaemonProcessRefusal(
  reason: DaemonProcessRefusal
): string {
  switch (reason) {
    case "invalid-pid":
      return "the pid file does not hold a valid daemon pid";
    case "not-running":
      return "no process has that pid";
    case "identity-unknown":
      return "its process identity could not be read";
    case "not-hackd":
      return "that process is not a hack daemon";
    case "foreign-socket":
      return "it does not hold this HACK_HOME's daemon socket (another state root's daemon, or a reused pid)";
    default:
      return "the process changed while it was checked (pid reused)";
  }
}

/**
 * Stops a proven hackd: SIGTERM, a bounded wait, then SIGKILL only if the
 * same process (same start time) is still there. Each signal is preceded by
 * an identity re-check, so a pid reused after the proof is never signalled.
 * Returns true when the process exited.
 */
export async function terminateProvenDaemon(opts: {
  readonly proof: { readonly pid: number; readonly birth: string };
  readonly timeoutMs?: number;
  readonly probe?: DaemonProcessProbe;
}): Promise<boolean> {
  const probe = opts.probe ?? defaultDaemonProcessProbe;
  const { pid, birth } = opts.proof;
  const same = async () =>
    isProcessRunning({ pid }) && (await probe.birth(pid)) === birth;
  if (!(await same())) {
    return true;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  if (
    await waitForProcessExit({
      pid,
      timeoutMs: opts.timeoutMs ?? 2000,
      pollMs: 100,
    })
  ) {
    return true;
  }
  if (!(await same())) {
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  return await waitForProcessExit({ pid, timeoutMs: 1000, pollMs: 100 });
}

/**
 * Removes hackd's pid and socket files only while they are still stale
 * (HACK-2052). A concurrent `hack daemon start`, autostart or a service
 * manager restart can write a new pid file and socket between the caller's
 * observation and this cleanup; deleting those would leave a live daemon
 * untracked or unreachable.
 *
 * - The pid file is removed only if it still names `observedPid` (null for
 *   "absent") and that pid is not running.
 * - The socket is removed only if the pid file is now absent or stale and no
 *   process accepts connections on the socket.
 *
 * Returns what it removed and whether it found a newer owner.
 */
export async function removeDaemonFilesIfStale(opts: {
  readonly pidPath: string;
  readonly socketPath: string;
  readonly observedPid: number | null;
  /**
   * False when `observedPid` is alive but proven not to be hackd (a pid
   * reused after an unclean shutdown): the pid file is then stale although
   * the pid runs.
   */
  readonly observedPidIsDaemon?: boolean;
  readonly isAccepting?: (socketPath: string) => Promise<boolean>;
}): Promise<{
  readonly removedPid: boolean;
  readonly removedSocket: boolean;
  readonly newerOwner: boolean;
}> {
  const current = await readDaemonPid({ pidPath: opts.pidPath });
  if (current !== opts.observedPid) {
    return { removedPid: false, removedSocket: false, newerOwner: true };
  }
  if (
    current !== null &&
    opts.observedPidIsDaemon !== false &&
    isProcessRunning({ pid: current })
  ) {
    return { removedPid: false, removedSocket: false, newerOwner: true };
  }
  const isAccepting = opts.isAccepting ?? isUnixSocketAccepting;
  if (await isAccepting(opts.socketPath)) {
    return { removedPid: false, removedSocket: false, newerOwner: true };
  }
  // Re-read right before removal: the narrowest window this check allows.
  const removedPid =
    (await entryExists(opts.pidPath)) &&
    (await readDaemonPid({ pidPath: opts.pidPath })) === opts.observedPid;
  if (removedPid) {
    await removeFileIfExists({ path: opts.pidPath });
  }
  const socketExists = await entryExists(opts.socketPath);
  if (socketExists) {
    await removeFileIfExists({ path: opts.socketPath });
  }
  return { removedPid, removedSocket: socketExists, newerOwner: false };
}

/** True when something accepts a connection on the Unix socket. */
export async function isUnixSocketAccepting(
  socketPath: string,
  timeoutMs = 500
): Promise<boolean> {
  if (!(await entryExists(socketPath))) {
    return false;
  }
  const ignore = () => undefined;
  const connecting = Bun.connect({
    unix: socketPath,
    socket: { data: ignore, error: ignore },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([connecting, timedOut]);
    if (result === "timeout") {
      // Close a connection that completes after the deadline.
      connecting.then((late) => late.end(), ignore);
      return false;
    }
    result.end();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Any directory entry, including a Unix socket (`Bun.file().exists()` is false for sockets). */
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const PROC_SOCKET_LINK = /^socket:\[(\d+)\]$/;
const DAEMON_SOCKET_NAMES = [
  "hackd.sock",
  "hackd.internal.sock",
  "gateway.internal.sock",
] as const;

/**
 * Linux socket ownership without lsof: a pid owns one of this daemon
 * root's sockets when one of its `/proc/<pid>/fd` links is `socket:[inode]`
 * and `/proc/net/unix` names that inode with a daemon socket path. Returns
 * null when `/proc/net/unix` cannot be read; a pid whose fds cannot be read
 * (another user, gone) is simply not an owner.
 */
export async function findDaemonSocketOwnersFromProc(opts: {
  readonly daemonRoot: string;
  readonly pids: readonly number[];
  readonly procRoot?: string;
}): Promise<ReadonlySet<number> | null> {
  const proc = opts.procRoot ?? "/proc";
  const table = await readTextFile(`${proc}/net/unix`);
  if (table === null) {
    return null;
  }
  const roots = new Set([resolve(opts.daemonRoot)]);
  try {
    roots.add(await realpath(opts.daemonRoot));
  } catch {
    // A deleted directory can still appear in a socket's path.
  }
  const wanted = new Set(
    [...roots].flatMap((root) =>
      DAEMON_SOCKET_NAMES.map((name) => resolve(root, name))
    )
  );
  const inodes = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(WHITESPACE_PATTERN);
    const inode = fields[6];
    // The path is the rest of the line; it can contain spaces.
    const path = fields.length > 7 ? fields.slice(7).join(" ") : undefined;
    if (inode && path && wanted.has(path)) {
      inodes.add(inode);
    }
  }
  const owners = new Set<number>();
  if (inodes.size === 0) {
    return owners;
  }
  for (const pid of opts.pids) {
    if (await pidHoldsSocketInode({ proc, pid, inodes })) {
      owners.add(pid);
    }
  }
  return owners;
}

/** Whether one of `pid`'s open fds is a socket with one of `inodes`. */
async function pidHoldsSocketInode(opts: {
  readonly proc: string;
  readonly pid: number;
  readonly inodes: ReadonlySet<string>;
}): Promise<boolean> {
  let fds: string[];
  try {
    fds = await readdir(`${opts.proc}/${opts.pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    try {
      const link = await readlink(`${opts.proc}/${opts.pid}/fd/${fd}`);
      const inode = PROC_SOCKET_LINK.exec(link)?.[1];
      if (inode && opts.inodes.has(inode)) {
        return true;
      }
    } catch {
      // The fd closed while it was read.
    }
  }
  return false;
}

/**
 * True when `pid` runs a hack daemon command line. A pid file that survived
 * an unclean shutdown can name a pid that now belongs to another program;
 * treating that as "hackd already running" would keep hackd from starting.
 * Unknown (the command line cannot be read) counts as hackd, so the caller
 * stays on its cautious path.
 */
export async function isHackDaemonProcess(opts: {
  readonly pid: number;
  readonly probe?: DaemonProcessProbe;
}): Promise<boolean> {
  const command = await (opts.probe ?? defaultDaemonProcessProbe).command(
    opts.pid
  );
  if (command === null) {
    return true;
  }
  return (
    command.includes(DAEMON_COMMAND_MARKER) && isHackDaemonCommand({ command })
  );
}
