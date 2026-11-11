import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { parseObservedProcesses } from "../host-command-observation.ts";
import { exec } from "../shell.ts";

/**
 * Platform effects for background commands: new sessions, kernel-appended
 * output files, process identity and group signalling.
 *
 * Linux and macOS share one implementation. Both provide setsid(2) through a
 * detached spawn, O_APPEND regular files, kill(2) on a negative process-group
 * id, and `ps -o lstart=,sess=` with `LC_ALL=C`. Anything outside this module
 * that needs one of these effects goes through it, so a third platform has one
 * place to differ.
 */

/** pid plus the process's start time as `ps -o lstart=` prints it. */
export type ProcessIdentity = {
  readonly pid: number;
  readonly birth: string;
};

export type ObservedIdentity = ProcessIdentity & {
  readonly processGroupId: number;
};

/**
 * Open (creating if needed) a 0600 output file for kernel-side appends. The
 * descriptor is handed to the child as stdout or stderr, so every write lands
 * at end of file without passing through the supervisor. A symlink at the path
 * is refused (O_NOFOLLOW), so a planted link cannot redirect output.
 */
export function openAppendOnlyOutput(path: string): number {
  return openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600
  );
}

export function closeDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed.
  }
}

/** Kind of the caller's stdin: a terminal or /dev/null, a pipe, or a file with bytes. */
export function describeStdin(): "terminal_or_null" | "pipe" | "file" {
  try {
    const stats = fstatSync(0);
    if (stats.isFIFO() || stats.isSocket()) {
      return "pipe";
    }
    if (stats.isFile() && stats.size > 0) {
      return "file";
    }
    return "terminal_or_null";
  } catch {
    return "terminal_or_null";
  }
}

/**
 * Start a process in a new session (setsid), with stdin closed and stdout and
 * stderr discarded. The caller does not wait for it; it survives the
 * launching shell and its process group. A sandbox that kills by cgroup still
 * kills it; readers then report outcome `unknown`.
 */
export function spawnInNewSession(opts: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): { readonly pid: number; readonly exited: Promise<number | null> } {
  const [executable, ...rest] = opts.argv;
  if (!executable) {
    throw new Error("Missing background supervisor executable.");
  }
  const child = spawn(executable, rest, {
    cwd: opts.cwd,
    env: { ...opts.env },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error("Background supervisor did not start.");
  }
  return { pid: child.pid, exited };
}

/**
 * Snapshot pid, process group and birth for the given pids. Null when `ps`
 * is unavailable, which callers treat as "cannot tell", never as "gone".
 */
export async function observeIdentities(
  pids: readonly number[]
): Promise<ReadonlyMap<number, ObservedIdentity> | null> {
  const wanted = [...new Set(pids.filter((pid) => pid > 0))];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await readIdentityRows(wanted);
  if (rows === null) {
    return null;
  }
  return new Map(
    rows.map((row) => [
      row.pid,
      { pid: row.pid, birth: row.birth, processGroupId: row.processGroupId },
    ])
  );
}

/**
 * `ps -o lstart=` prints local time, so the time zone must be fixed: a
 * supervisor that inherits a project's `TZ` and a reader in the user's shell
 * must format the same start time identically, or a live process looks gone.
 */
export const IDENTITY_PS_ENV = Object.freeze({ LC_ALL: "C", TZ: "UTC0" });

async function readIdentityRows(
  pids: readonly number[]
): Promise<ReturnType<typeof parseObservedProcesses> | null> {
  try {
    const result = await exec(
      [
        "ps",
        "-p",
        pids.join(","),
        "-o",
        "pid=,ppid=,pgid=,etime=,time=,rss=,lstart=",
      ],
      { stdin: "ignore", timeoutMs: 2000, env: { ...IDENTITY_PS_ENV } }
    );
    // ps exits 1 when none of the pids exist: that is "all gone", not unknown.
    // An option or usage error also exits 1 with empty stdout, but says so
    // on stderr: that is "cannot tell", never "gone".
    if (
      result.exitCode !== 0 &&
      (result.stdout.trim().length > 0 || result.stderr.trim().length > 0)
    ) {
      return null;
    }
    return result.exitCode === 0 || result.exitCode === 1
      ? parseObservedProcesses(result.stdout)
      : null;
  } catch {
    return null;
  }
}

/** True only when the pid is alive with the same birth: pid reuse is not a match. */
export function identityMatches(opts: {
  readonly expected: ProcessIdentity;
  readonly snapshot: ReadonlyMap<number, ObservedIdentity>;
}): boolean {
  const row = opts.snapshot.get(opts.expected.pid);
  return row !== undefined && row.birth === opts.expected.birth;
}

/** This process's identity and session id, read from `ps`. */
export async function readOwnIdentity(): Promise<{
  readonly identity: ObservedIdentity;
  readonly sessionId: number | null;
} | null> {
  const snapshot = await observeIdentities([process.pid]);
  const row = snapshot?.get(process.pid);
  if (!row) {
    return null;
  }
  return { identity: row, sessionId: await readSessionId(process.pid) };
}

export async function readSessionId(pid: number): Promise<number | null> {
  try {
    const result = await exec(["ps", "-o", "sess=", "-p", String(pid)], {
      stdin: "ignore",
      timeoutMs: 2000,
      env: { ...IDENTITY_PS_ENV },
    });
    const value = Number.parseInt(result.stdout.trim(), 10);
    return result.exitCode === 0 && Number.isSafeInteger(value) && value > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Signal a whole process group. False when the group no longer exists. */
export function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals
): boolean {
  if (!(Number.isSafeInteger(processGroupId) && processGroupId > 1)) {
    return false;
  }
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch {
    return false;
  }
}

/** Signal one process. False when it no longer exists. */
export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  if (!(Number.isSafeInteger(pid) && pid > 1)) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
