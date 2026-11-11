import { dlopen, FFIType } from "bun:ffi";
import { readlink } from "node:fs/promises";

import { readTextFile } from "../lib/fs.ts";

/**
 * What a process runs, read exactly (HACK-2052).
 *
 * - `executable`: the resolved path of the program image the kernel runs
 *   (Linux `/proc/<pid>/exe`, macOS `proc_pidpath`). A symlink such as
 *   `~/.local/bin/hack` resolves to its target, and an interpreter script
 *   resolves to the interpreter, so a script named `hack` that runs Python
 *   is not a Hack binary.
 * - `argv`: the argument vector with its boundaries (Linux
 *   `/proc/<pid>/cmdline`, macOS `KERN_PROCARGS2`). `ps` text, which loses
 *   the boundaries, is never used for identity.
 *
 * Null when either cannot be read (another user's process, the process is
 * gone, an unsupported platform): callers treat that as unknown identity.
 */
export interface ProcessImage {
  readonly executable: string;
  readonly argv: readonly string[];
  /**
   * The working directory, so a relative argv entry (`bun index.ts ...`)
   * can be resolved. Null when unknown (macOS, or unreadable); a relative
   * entry then does not match.
   */
  readonly cwd?: string | null;
}

const LINUX_DELETED_SUFFIX = " (deleted)";
const DIGITS = /^\d+$/;

export async function readProcessImage(
  pid: number
): Promise<ProcessImage | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    return await readLinuxProcessImage(pid);
  }
  if (process.platform === "darwin") {
    return readDarwinProcessImage(pid);
  }
  return null;
}

async function readLinuxProcessImage(
  pid: number
): Promise<ProcessImage | null> {
  let executable: string;
  try {
    executable = await readlink(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  // An upgrade that replaced the binary leaves the old image running; the
  // kernel marks its path. The name still identifies the program.
  if (executable.endsWith(LINUX_DELETED_SUFFIX)) {
    executable = executable.slice(0, -LINUX_DELETED_SUFFIX.length);
  }
  const raw = await readTextFile(`/proc/${pid}/cmdline`);
  if (raw === null || raw.length === 0) {
    return null;
  }
  const argv = raw.split("\0");
  // cmdline ends with a NUL, which leaves one empty trailing element.
  if (argv.at(-1) === "") {
    argv.pop();
  }
  let cwd: string | null = null;
  try {
    cwd = await readlink(`/proc/${pid}/cwd`);
  } catch {
    // Unknown: a relative entry will not match.
  }
  return argv.length > 0 ? { executable, argv, cwd } : null;
}

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const PROC_PIDPATHINFO_MAXSIZE = 4096;

type DarwinLibc = {
  readonly sysctl: (
    mib: Int32Array,
    count: number,
    out: Uint8Array | Int32Array,
    size: BigUint64Array,
    newValue: null,
    newSize: number
  ) => number;
  readonly procPidPath: (pid: number, out: Uint8Array, size: number) => number;
  readonly procPidInfo: (
    pid: number,
    flavor: number,
    arg: bigint,
    out: Uint8Array,
    size: number
  ) => number;
};

let darwinLibc: DarwinLibc | null | undefined;

function loadDarwinLibc(): DarwinLibc | null {
  if (darwinLibc !== undefined) {
    return darwinLibc;
  }
  try {
    // Opened lazily, on macOS only.
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
        ],
        returns: FFIType.i32,
      },
      proc_pidpath: {
        args: [FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    darwinLibc = {
      sysctl: (mib, count, out, size, newValue, newSize) =>
        library.symbols.sysctl(mib, count, out, size, newValue, newSize),
      procPidPath: (pid, out, size) =>
        library.symbols.proc_pidpath(pid, out, size),
      procPidInfo: (pid, flavor, arg, out, size) =>
        library.symbols.proc_pidinfo(pid, flavor, arg, out, size),
    };
  } catch {
    darwinLibc = null;
  }
  return darwinLibc;
}

function readDarwinProcessImage(pid: number): ProcessImage | null {
  const libc = loadDarwinLibc();
  if (!libc) {
    return null;
  }
  const pathBuffer = new Uint8Array(PROC_PIDPATHINFO_MAXSIZE);
  const pathLength = libc.procPidPath(pid, pathBuffer, pathBuffer.length);
  if (pathLength <= 0) {
    return null;
  }
  const executable = new TextDecoder().decode(
    pathBuffer.subarray(0, pathLength)
  );

  const argMax = new Int32Array(1);
  const argMaxSize = new BigUint64Array([4n]);
  if (
    libc.sysctl(
      new Int32Array([CTL_KERN, KERN_ARGMAX]),
      2,
      argMax,
      argMaxSize,
      null,
      0
    ) !== 0 ||
    (argMax[0] ?? 0) <= 0
  ) {
    return null;
  }
  const buffer = new Uint8Array(argMax[0] ?? 0);
  const size = new BigUint64Array([BigInt(buffer.length)]);
  if (
    libc.sysctl(
      new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]),
      3,
      buffer,
      size,
      null,
      0
    ) !== 0
  ) {
    return null;
  }
  const argv = parseProcArgs2(buffer.subarray(0, Number(size[0] ?? 0n)));
  return argv ? { executable, argv, cwd: readDarwinCwd(libc, pid) } : null;
}

/**
 * `PROC_PIDVNODEPATHINFO` returns `struct proc_vnodepathinfo`: the current
 * directory's `struct vnode_info_path` (a 152-byte `vnode_info`, then a
 * `MAXPATHLEN` path), then the root directory's. Only the cwd path is read.
 */
const PROC_PIDVNODEPATHINFO = 9;
const VNODE_INFO_SIZE = 152;
const MAXPATHLEN = 1024;
const VNODE_PATH_INFO_SIZE = 2 * (VNODE_INFO_SIZE + MAXPATHLEN);

/**
 * The process's working directory, or null when it cannot be read. A wrong
 * read can only fail to match a relative entry: the result must be an
 * absolute path, and it is used only to resolve that entry.
 */
function readDarwinCwd(libc: DarwinLibc, pid: number): string | null {
  const buffer = new Uint8Array(VNODE_PATH_INFO_SIZE);
  const written = libc.procPidInfo(
    pid,
    PROC_PIDVNODEPATHINFO,
    0n,
    buffer,
    buffer.length
  );
  if (written !== VNODE_PATH_INFO_SIZE) {
    return null;
  }
  return parseDarwinCwd(buffer);
}

/** Reads the cwd path out of a `proc_vnodepathinfo` buffer. */
export function parseDarwinCwd(buffer: Uint8Array): string | null {
  const field = buffer.subarray(VNODE_INFO_SIZE, VNODE_INFO_SIZE + MAXPATHLEN);
  const end = field.indexOf(0);
  if (end <= 0) {
    return null;
  }
  const path = new TextDecoder().decode(field.subarray(0, end));
  return path.startsWith("/") ? path : null;
}

/**
 * Parses a macOS `KERN_PROCARGS2` buffer: a native-endian `int argc`, the
 * executable path, NUL padding, then `argc` NUL-terminated arguments (the
 * environment follows and is ignored). Null when the buffer is short or
 * malformed.
 */
export function parseProcArgs2(buffer: Uint8Array): string[] | null {
  if (buffer.length < 4) {
    return null;
  }
  const argc = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  ).getInt32(0, true);
  if (argc <= 0) {
    return null;
  }
  let offset = 4;
  // Skip the executable path, then the NUL padding after it.
  while (offset < buffer.length && buffer[offset] !== 0) {
    offset += 1;
  }
  while (offset < buffer.length && buffer[offset] === 0) {
    offset += 1;
  }
  const decoder = new TextDecoder();
  const argv: string[] = [];
  while (argv.length < argc) {
    const end = buffer.indexOf(0, offset);
    if (end < 0) {
      return null;
    }
    argv.push(decoder.decode(buffer.subarray(offset, end)));
    offset = end + 1;
  }
  return argv;
}

/**
 * Linux start time in clock ticks since boot (`/proc/<pid>/stat` field 22),
 * finer than `ps -o lstart`'s whole seconds. Null when unreadable.
 */
export async function readLinuxProcessStartTicks(
  pid: number
): Promise<string | null> {
  const stat = await readTextFile(`/proc/${pid}/stat`);
  if (stat === null) {
    return null;
  }
  // The command name (field 2) is in parentheses and may contain spaces or
  // parentheses; the fields after the last `)` are fixed.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // rest[0] is field 3 (state); field 22 is rest[19].
  const ticks = rest[19];
  return ticks && DIGITS.test(ticks) ? ticks : null;
}
