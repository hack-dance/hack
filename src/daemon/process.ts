import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { readTextFile, writeTextFile } from "../lib/fs.ts";
import { readObservedProcesses } from "../lib/host-command-observation.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";
import {
  isLinuxZombie,
  type ProcessImage,
  readLinuxProcessStartTicks,
  readProcessImage,
} from "./process-image.ts";

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

/**
 * True when `pid` exists and has not exited. A Linux zombie (exited, not yet
 * reaped by a parent such as a non-reaping container init) has exited:
 * `kill(pid, 0)` alone would call it running.
 */
export async function isProcessAlive({
  pid,
}: {
  readonly pid: number;
}): Promise<boolean> {
  return isProcessRunning({ pid }) && !(await isLinuxZombie(pid));
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
    if (!(await isProcessAlive({ pid }))) {
      return true;
    }
    await sleep({ ms: pollMs });
  }
  return !(await isProcessAlive({ pid }));
}

function sleep({ ms }: { readonly ms: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A daemon start candidate in `ps` text: only a cheap pre-filter. */
const CANDIDATE_WORDS = ["daemon", "start", "--foreground"] as const;
const WHITESPACE_PATTERN = /\s+/;

/** A process the orphan sweep found but may not signal, and why. */
export interface RefusedDaemonProcess {
  readonly pid: number;
  readonly reason: DaemonProcessRefusal;
}

export interface OrphanDaemonScan {
  /** Proven to be this state root's hackd and not tracked by the pid file. */
  readonly orphans: readonly OwnedDaemonProof[];
  /**
   * Looked like a daemon start but failed the proof (another state root's
   * daemon, another program, unknown identity). Never signalled; callers
   * report them.
   */
  readonly refused: readonly RefusedDaemonProcess[];
}

/**
 * Finds hackd processes that the pid file does not track ("orphans").
 *
 * Orphans appear when a daemon keeps running after its pid/socket files were
 * replaced or cleared (e.g. a launchd-managed instance surviving a manual
 * restart). They are invisible to status/start/clear, which only consult the
 * pid file — the root cause of "daemon starts then exits" contradictions:
 * the orphan holds the API while every newly spawned daemon exits.
 *
 * `ps` text only nominates candidates; every candidate must pass
 * {@link proveOwnedDaemonProcess} (exact argv, resolved executable, a socket
 * in `daemonRoot`, start time) before it is returned as an orphan (HACK-2052).
 * A text match never authorizes a signal.
 *
 * @param opts.trackedPid - pid currently recorded in the pid file, if any.
 * @param opts.psLines - injectable `ps -axo pid=,command=` lines for tests.
 */
export async function findOrphanDaemonProcesses(opts: {
  readonly trackedPid: number | null;
  readonly daemonRoot: string;
  readonly psLines?: readonly string[];
  readonly probe?: DaemonProcessProbe;
  readonly expectation?: DaemonIdentityExpectation;
}): Promise<OrphanDaemonScan> {
  const lines = opts.psLines ?? (await listProcessTable());
  const orphans: OwnedDaemonProof[] = [];
  const refused: RefusedDaemonProcess[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) {
      continue;
    }
    const pid = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    if (pid === opts.trackedPid || pid === process.pid) {
      continue;
    }
    const words = new Set(
      trimmed.slice(spaceIdx + 1).split(WHITESPACE_PATTERN)
    );
    if (!CANDIDATE_WORDS.every((word) => words.has(word))) {
      continue;
    }
    const proof = await proveOwnedDaemonProcess({
      pid,
      daemonRoot: opts.daemonRoot,
      probe: opts.probe,
      expectation: opts.expectation,
      socketRetries: 0,
    });
    if (proof.kind === "owned") {
      orphans.push(proof);
    } else if (proof.reason !== "not-running") {
      refused.push({ pid, reason: proof.reason });
    }
  }
  return { orphans, refused };
}

/**
 * Parses `lsof -Fpn` output: the pids holding one of `daemonRoot`'s
 * sockets.
 */
export async function parseLsofDaemonSocketOwners(opts: {
  readonly daemonRoot: string;
  readonly lines: readonly string[];
}): Promise<ReadonlySet<number>> {
  return await findDaemonSocketOwners(opts);
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

export type DaemonProcessRefusal =
  | "invalid-pid"
  | "not-running"
  | "identity-unknown"
  | "not-hackd"
  | "foreign-socket"
  | "identity-changed";

/** A process proven to be this state root's hackd, as observed. */
export interface OwnedDaemonProof {
  readonly kind: "owned";
  readonly pid: number;
  readonly birth: string;
  readonly image: ProcessImage;
}

export type DaemonProcessProof =
  | OwnedDaemonProof
  | { readonly kind: "refused"; readonly reason: DaemonProcessRefusal };

/** The observations a proof uses; injectable so tests can model each refusal. */
export interface DaemonProcessProbe {
  /**
   * Process start time, or null when unknown. Linux: clock ticks since boot
   * (`/proc/<pid>/stat`); elsewhere `ps -o lstart=` (whole seconds).
   */
  readonly birth: (pid: number) => Promise<string | null>;
  /** Exact argv and resolved executable ({@link readProcessImage}). */
  readonly image: (pid: number) => Promise<ProcessImage | null>;
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
    if (process.platform === "linux") {
      const ticks = await readLinuxProcessStartTicks(pid);
      return ticks === null ? null : `ticks:${ticks}`;
    }
    const rows = await readObservedProcesses([pid]);
    return rows?.find((row) => row.pid === pid)?.birth ?? null;
  },
  image: readProcessImage,
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
 * Which programs count as hackd. A compiled Hack binary (resolved
 * executable named `hack` or `hack-*`) always qualifies. A source run
 * qualifies only as `bun <entry> ...` where `<entry>` is one of
 * `entryFiles`: this checkout's entry file, so `bun /other/index.ts daemon
 * start --foreground` is not this CLI's daemon.
 */
export interface DaemonIdentityExpectation {
  readonly entryFiles: ReadonlySet<string>;
  /**
   * Accept a source run of any entry file (still a foreground daemon
   * start). Only for a process whose identity comes from elsewhere, such
   * as hackd.service's main process as systemd reports it: the unit may run
   * another install or checkout than this CLI (a Bun launcher, the dev
   * shim), and the socket proves which home it serves (HACK-2052).
   */
  readonly anyBunEntry?: boolean;
}

let defaultExpectation: Promise<DaemonIdentityExpectation> | null = null;

/**
 * The running CLI's own entry file (as given and resolved) when it runs
 * from source; none for a compiled binary, whose entry is a virtual path.
 */
export function defaultDaemonIdentityExpectation(): Promise<DaemonIdentityExpectation> {
  defaultExpectation ??= (async () => {
    const main = Bun.main;
    if (!isAbsolute(main) || main.startsWith("/$bunfs/")) {
      return { entryFiles: new Set<string>() };
    }
    const entries = new Set([main]);
    try {
      entries.add(await realpath(main));
    } catch {
      // The entry was removed; its spelling still matches a daemon's argv.
    }
    return { entryFiles: entries };
  })();
  return defaultExpectation;
}

/**
 * Proves that `pid` is this state root's hackd before anything signals it.
 *
 * Liveness is not identity: a pid file can name a recycled pid, another
 * HACK_HOME's daemon, or `0` (the caller's own process group). The proof
 * requires all of: a positive pid other than this process; a known start
 * time; an exact argv and resolved executable that
 * {@link isHackDaemonImage} accepts; and an open socket in `daemonRoot`.
 * The start time is read again at the end and must not have changed, so
 * the pid was not reused while it was checked. Missing evidence refuses; it
 * never authorizes a signal.
 */
export async function proveOwnedDaemonProcess(opts: {
  readonly pid: number;
  readonly daemonRoot: string;
  readonly probe?: DaemonProcessProbe;
  readonly expectation?: DaemonIdentityExpectation;
  /**
   * Retry a `foreign-socket` refusal this many times, 250 ms apart (default
   * 4): a hackd that just wrote its pid file may not have bound its socket
   * yet. Other refusals are final.
   */
  readonly socketRetries?: number;
}): Promise<DaemonProcessProof> {
  const retries = opts.socketRetries ?? 4;
  const expectation =
    opts.expectation ?? (await defaultDaemonIdentityExpectation());
  let proof = await proveOwnedDaemonProcessOnce({ ...opts, expectation });
  for (
    let attempt = 0;
    attempt < retries &&
    proof.kind === "refused" &&
    proof.reason === "foreign-socket";
    attempt += 1
  ) {
    await sleep({ ms: 250 });
    proof = await proveOwnedDaemonProcessOnce({ ...opts, expectation });
  }
  return proof;
}

async function proveOwnedDaemonProcessOnce(opts: {
  readonly pid: number;
  readonly daemonRoot: string;
  readonly probe?: DaemonProcessProbe;
  readonly expectation: DaemonIdentityExpectation;
}): Promise<DaemonProcessProof> {
  const probe = opts.probe ?? defaultDaemonProcessProbe;
  const { pid } = opts;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return { kind: "refused", reason: "invalid-pid" };
  }
  // A zombie (exited, not yet reaped) is not running.
  if (!(await isProcessAlive({ pid }))) {
    return { kind: "refused", reason: "not-running" };
  }
  const birth = await probe.birth(pid);
  if (birth === null) {
    return {
      kind: "refused",
      reason: (await isProcessAlive({ pid }))
        ? "identity-unknown"
        : "not-running",
    };
  }
  const image = await probe.image(pid);
  if (image === null) {
    // Unreadable is not "not hackd": stop would then drop a real hackd's
    // pid file. Refuse without a conclusion.
    return {
      kind: "refused",
      reason: (await isProcessAlive({ pid }))
        ? "identity-unknown"
        : "not-running",
    };
  }
  if (!isHackDaemonImage({ image, expectation: opts.expectation })) {
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
  return { kind: "owned", pid, birth, image };
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
      return "that process is not this hack's daemon";
    case "foreign-socket":
      return "it does not hold this HACK_HOME's daemon socket (another state root's daemon, or a reused pid)";
    default:
      return "the process changed while it was checked (pid reused)";
  }
}

function sameImage(a: ProcessImage, b: ProcessImage): boolean {
  return (
    a.executable === b.executable &&
    a.argv.length === b.argv.length &&
    a.argv.every((arg, index) => arg === b.argv[index])
  );
}

/**
 * What became of a proven hackd that {@link terminateProvenDaemon} was
 * asked to stop. Only `exited` confirms it is gone.
 */
export type DaemonTermination =
  | { readonly kind: "exited" }
  | {
      readonly kind: "not-confirmed";
      /**
       * `still-running`: the same hackd is alive after SIGKILL.
       * `changed`: the pid now runs something that fails the proof (another
       * program after `exec`, or hackd without its socket); not signalled.
       * `identity-unknown`: its identity could not be read; not signalled.
       */
      readonly reason: "still-running" | "changed" | "identity-unknown";
    };

/** Plain-language outcome for a termination that was not confirmed. */
export function describeDaemonTermination(
  pid: number,
  termination: Extract<DaemonTermination, { kind: "not-confirmed" }>
): string {
  switch (termination.reason) {
    case "still-running":
      return `hackd (pid ${pid}) is still running after SIGTERM and SIGKILL`;
    case "changed":
      return `pid ${pid} no longer passes the hackd identity check, so it was not signalled again; it is still running`;
    default:
      return `the identity of pid ${pid} could not be read again, so it was not signalled; it is still running`;
  }
}

/**
 * Stops a proven hackd: SIGTERM, a bounded wait, then SIGKILL. Immediately
 * before each signal the whole proof runs again (exact argv, resolved
 * executable, socket in `daemonRoot`, start time) and must match the
 * original proof: a pid that was reused, or a process that `exec`ed another
 * program (same pid and start time), is never signalled (HACK-2052).
 */
export async function terminateProvenDaemon(opts: {
  readonly proof: OwnedDaemonProof;
  readonly daemonRoot: string;
  readonly timeoutMs?: number;
  readonly killTimeoutMs?: number;
  readonly probe?: DaemonProcessProbe;
  readonly expectation?: DaemonIdentityExpectation;
  /** Defaults to `process.kill`; tests model a process that will not die. */
  readonly sendSignal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}): Promise<DaemonTermination> {
  const probe = opts.probe ?? defaultDaemonProcessProbe;
  const expectation =
    opts.expectation ?? (await defaultDaemonIdentityExpectation());
  const { proof } = opts;
  const { pid } = proof;

  /** "same" authorizes the next signal; "gone" confirms the exit. */
  const recheck = async (): Promise<
    "same" | "gone" | "changed" | "identity-unknown"
  > => {
    if (!(await isProcessAlive({ pid }))) {
      return "gone";
    }
    const birth = await probe.birth(pid);
    if (birth === null) {
      return (await isProcessAlive({ pid })) ? "identity-unknown" : "gone";
    }
    if (birth !== proof.birth) {
      // A different process now has the pid: the proven one exited.
      return "gone";
    }
    const again = await proveOwnedDaemonProcessOnce({
      pid,
      daemonRoot: opts.daemonRoot,
      probe,
      expectation,
    });
    if (again.kind === "owned") {
      return again.birth === proof.birth && sameImage(again.image, proof.image)
        ? "same"
        : "changed";
    }
    switch (again.reason) {
      case "not-running":
        return "gone";
      case "identity-changed":
        return "gone";
      case "identity-unknown":
        return "identity-unknown";
      default:
        return "changed";
    }
  };
  const notConfirmed = (
    reason: "still-running" | "changed" | "identity-unknown"
  ): DaemonTermination => ({ kind: "not-confirmed", reason });

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const state = await recheck();
    if (state === "gone") {
      return { kind: "exited" };
    }
    if (state !== "same") {
      return notConfirmed(state);
    }
    try {
      (opts.sendSignal ?? ((target, name) => process.kill(target, name)))(
        pid,
        signal
      );
    } catch {
      // ESRCH: it exited between the check and the signal.
      if (!(await isProcessAlive({ pid }))) {
        return { kind: "exited" };
      }
      return notConfirmed("still-running");
    }
    const exited = await waitForProcessExit({
      pid,
      timeoutMs:
        signal === "SIGTERM"
          ? (opts.timeoutMs ?? 2000)
          : (opts.killTimeoutMs ?? 1000),
      pollMs: 100,
    });
    if (exited) {
      return { kind: "exited" };
    }
  }
  return notConfirmed("still-running");
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
 * - The socket is removed only if, immediately before removal, the pid file
 *   is still the observed stale one (or the one this call removed), the
 *   socket is the same directory entry that was checked, and nothing
 *   accepts connections on it. Any change means a newer owner.
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
  /** Test hook: runs after the first checks, before anything is removed. */
  readonly beforeRemove?: () => Promise<void>;
}): Promise<{
  readonly removedPid: boolean;
  readonly removedSocket: boolean;
  readonly newerOwner: boolean;
}> {
  const newer = { removedPid: false, removedSocket: false, newerOwner: true };
  const current = await readDaemonPid({ pidPath: opts.pidPath });
  if (current !== opts.observedPid) {
    return newer;
  }
  if (
    current !== null &&
    opts.observedPidIsDaemon !== false &&
    (await isProcessAlive({ pid: current }))
  ) {
    return newer;
  }
  const isAccepting = opts.isAccepting ?? isUnixSocketAccepting;
  const socketBefore = await entryIdentity(opts.socketPath);
  if (await isAccepting(opts.socketPath)) {
    return newer;
  }
  await opts.beforeRemove?.();

  // Re-read right before removal: the narrowest window this check allows.
  if ((await readDaemonPid({ pidPath: opts.pidPath })) !== opts.observedPid) {
    return newer;
  }
  const removedPid = await entryExists(opts.pidPath);
  if (removedPid) {
    await removeFileIfExists({ path: opts.pidPath });
  }
  // A starter that wrote a pid file after the removal owns the socket.
  const pidAfter = await readDaemonPid({ pidPath: opts.pidPath });
  if (pidAfter !== null && pidAfter !== opts.observedPid) {
    return { removedPid, removedSocket: false, newerOwner: true };
  }
  const socketNow = await entryIdentity(opts.socketPath);
  if (socketNow === null) {
    return { removedPid, removedSocket: false, newerOwner: false };
  }
  if (socketNow !== socketBefore || (await isAccepting(opts.socketPath))) {
    return { removedPid, removedSocket: false, newerOwner: true };
  }
  // hackd writes its pid file before it binds the socket, so a starter that
  // could own this socket shows up here. Checked last, right before unlink.
  const pidLast = await readDaemonPid({ pidPath: opts.pidPath });
  if (pidLast !== null && pidLast !== opts.observedPid) {
    return { removedPid, removedSocket: false, newerOwner: true };
  }
  await removeFileIfExists({ path: opts.socketPath });
  return { removedPid, removedSocket: true, newerOwner: false };
}

/**
 * Device, inode and change time (ns) of a directory entry, or null when it
 * does not exist. The change time tells a new entry apart when the
 * filesystem reuses the inode number at once (tmpfs does).
 */
async function entryIdentity(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.ctimeNs}`;
  } catch {
    return null;
  }
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
const PROC_NET_UNIX_ROW = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+) (.+)$/;
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
    // Seven fixed columns, then the path verbatim (it can contain runs of
    // spaces), separated by exactly one space.
    const match = PROC_NET_UNIX_ROW.exec(line);
    const inode = match?.[1];
    const path = match?.[2];
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
 * True when `pid` runs this CLI's hack daemon. A pid file that survived an
 * unclean shutdown can name a pid that now belongs to another program;
 * treating that as "hackd already running" would keep hackd from starting.
 * Unknown (the image cannot be read) counts as hackd, so the caller stays
 * on its cautious path. This decides only whether to start; it never
 * authorizes a signal ({@link proveOwnedDaemonProcess} does).
 */
export async function isHackDaemonProcess(opts: {
  readonly pid: number;
  readonly probe?: DaemonProcessProbe;
  readonly expectation?: DaemonIdentityExpectation;
}): Promise<boolean> {
  const image = await (opts.probe ?? defaultDaemonProcessProbe).image(opts.pid);
  if (image === null) {
    return true;
  }
  return isHackDaemonImage({
    image,
    expectation: opts.expectation ?? (await defaultDaemonIdentityExpectation()),
  });
}

function isHackExecutableName(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === "hack" || name.startsWith("hack-");
}

/**
 * True when the arguments after the program are a foreground daemon start
 * in any supported option placement: the positionals are exactly
 * `daemon start`, and `--foreground` appears among the options. The CLI
 * parser accepts options anywhere (`--no-interactive daemon start
 * --foreground`, `daemon start --no-interactive --foreground`), and every
 * option it accepts here is boolean, so no option consumes a positional.
 */
function isForegroundDaemonStartArgs(args: readonly string[]): boolean {
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  return (
    positionals.length === 2 &&
    positionals[0] === "daemon" &&
    positionals[1] === "start" &&
    args.includes("--foreground")
  );
}

/**
 * The identity rule (HACK-2052), on exact argv and the resolved executable:
 *
 * - a Hack binary: the executable is named `hack` or `hack-*` and the
 *   arguments after argv[0] are a foreground daemon start; or
 * - a source run: the executable is `bun`, argv[1] (after an optional
 *   `run` subcommand, and resolved against the
 *   process's working directory when relative) is one of this checkout's
 *   entry files ({@link DaemonIdentityExpectation}), and the arguments
 *   after it are a foreground daemon start.
 *
 * A script named `hack` that runs another interpreter resolves to that
 * interpreter and does not match.
 */
export function isHackDaemonImage(opts: {
  readonly image: ProcessImage;
  readonly expectation: DaemonIdentityExpectation;
}): boolean {
  const { executable, argv } = opts.image;
  if (isHackExecutableName(executable)) {
    return isForegroundDaemonStartArgs(argv.slice(1));
  }
  if (basename(executable).toLowerCase() !== "bun") {
    return false;
  }
  // `bun run <entry> ...` (the package `dev` script) is the same as
  // `bun <entry> ...`.
  const entryIndex = argv[1] === "run" ? 2 : 1;
  const raw = argv[entryIndex] ?? "";
  // `bun index.ts ...` from the checkout keeps the relative entry in argv;
  // resolve it against the process's own working directory.
  let entry: string | null = null;
  if (isAbsolute(raw)) {
    entry = raw;
  } else if (raw.length > 0 && opts.image.cwd) {
    entry = resolve(opts.image.cwd, raw);
  }
  return (
    entry !== null &&
    (opts.expectation.anyBunEntry === true ||
      opts.expectation.entryFiles.has(entry)) &&
    isForegroundDaemonStartArgs(argv.slice(entryIndex + 1))
  );
}
