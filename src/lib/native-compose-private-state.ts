import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import { beginNativeCpuChild } from "./native-cpu-diagnostics.ts";

const TOKEN = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BOOT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const BIRTH =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const PROCESS_BIRTH_ROW = /^(\d+)\s+(.+)$/;
const LOCK_OWNER_LIMIT = 1024;
const RECEIPT_LIMIT = 64 * 1024;
export type HeldDirectory = {
  readonly path: string;
  readonly file: FileHandle;
  readonly info: Stats;
  readonly private: boolean;
};
/** Private identity of the actual held mutation lock; an identity is not authority. */
export type NativeComposeMutationLease = {
  readonly token: string;
  readonly directory: { readonly dev: number; readonly ino: number };
  readonly owner: { readonly dev: number; readonly ino: number };
  /** Private copied owner/inode metadata; this snapshot alone is not a lease. */
  readonly selection: NativeComposeInterruptedLockSelection;
  readonly assertActive: () => undefined;
  readonly assertHeld: () => Promise<void>;
};
const mutationLeases = new WeakSet<NativeComposeMutationLease>();
type LockOwner = {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly uid: number;
  readonly bootId: string;
  readonly birth: string;
};
/** Private current snapshot, independently re-admitted before explicit unlink.
 * This is neither a historical inode witness nor permission to take a live lock. */
export type NativeComposeInterruptedLockSelection = {
  readonly version: 1;
  readonly kind: "native-private-interrupted-lock";
  readonly directory: { readonly dev: number; readonly ino: number };
  readonly file: {
    readonly dev: number;
    readonly ino: number;
    readonly sha256: string;
  };
  readonly owner: LockOwner;
};
/** A bounded candidate publication, not an issued mutation lease. The callback
 * must durably bind both selectors before this owner promotes the candidate. */
export type NativeComposePreparedLockReservation = {
  readonly previous: NativeComposeInterruptedLockSelection;
  readonly previousAbsent: boolean;
  readonly next: NativeComposeInterruptedLockSelection;
  readonly assertHeld: () => Promise<void>;
  readonly assertActive: () => undefined;
};

function fileIdentity(value: unknown): value is Record<string, unknown> & {
  readonly dev: number;
  readonly ino: number;
} {
  return (
    isRecord(value) &&
    typeof value.dev === "number" &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    typeof value.ino === "number" &&
    Number.isSafeInteger(value.ino) &&
    value.ino > 0
  );
}
export function parseNativeComposeInterruptedLockSelection(
  value: unknown
): NativeComposeInterruptedLockSelection {
  if (
    !(isRecord(value) && keys(value, "directory,file,kind,owner,version")) ||
    value.version !== 1 ||
    value.kind !== "native-private-interrupted-lock" ||
    !fileIdentity(value.directory) ||
    !keys(value.directory, "dev,ino") ||
    !fileIdentity(value.file) ||
    !keys(value.file, "dev,ino,sha256") ||
    typeof value.file.sha256 !== "string" ||
    !SHA256.test(value.file.sha256)
  ) {
    return refuse();
  }
  const owner = parseLockOwner(JSON.stringify(value.owner));
  return Object.freeze({
    version: 1,
    kind: "native-private-interrupted-lock",
    directory: Object.freeze({
      dev: value.directory.dev,
      ino: value.directory.ino,
    }),
    file: Object.freeze({
      dev: value.file.dev,
      ino: value.file.ino,
      sha256: value.file.sha256,
    }),
    owner: Object.freeze(owner),
  });
}
function interruptedSelection(
  lock: HeldDirectory,
  original: { readonly info: Stats; readonly text: string }
): NativeComposeInterruptedLockSelection {
  return parseNativeComposeInterruptedLockSelection({
    version: 1,
    kind: "native-private-interrupted-lock",
    directory: { dev: lock.info.dev, ino: lock.info.ino },
    file: {
      dev: original.info.dev,
      ino: original.info.ino,
      sha256: createHash("sha256").update(original.text).digest("hex"),
    },
    owner: parseLockOwner(original.text),
  });
}
function requireInterruptedSelection(
  expected: NativeComposeInterruptedLockSelection | undefined,
  current: NativeComposeInterruptedLockSelection
): void {
  if (
    expected !== undefined &&
    JSON.stringify(current) !== JSON.stringify(expected)
  ) {
    refuse();
  }
}

async function inspection(
  command: readonly string[]
): Promise<{ readonly output: string; readonly code: number }> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin",
      LANG: "C",
      LC_ALL: "C",
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  const observeCpu = beginNativeCpuChild(child, "other");
  try {
    const chunks: Uint8Array[] = [];
    const reader = child.stdout.getReader();
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        total += next.value.byteLength;
        if (total > LOCK_OWNER_LIMIT) {
          child.kill("SIGKILL");
          refuse();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      output: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(Buffer.concat(chunks))
        .trim(),
      code: await child.exited,
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    observeCpu(await child.exited);
  }
}
async function bootId(): Promise<string> {
  let value: string;
  if (process.platform === "darwin") {
    const result = await inspection([
      "/usr/sbin/sysctl",
      "-n",
      "kern.bootsessionuuid",
    ]);
    if (result.code !== 0) {
      refuse();
    }
    value = result.output.toLowerCase();
  } else if (process.platform === "linux") {
    const file = await open(
      "/proc/sys/kernel/random/boot_id",
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const bytes = Buffer.alloc(128);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      value = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, bytesRead))
        .trim();
    } finally {
      await file.close();
    }
  } else {
    return refuse();
  }
  if (!BOOT_ID.test(value)) {
    refuse();
  }
  return value;
}
async function processBirth(
  pid: number
): Promise<{ readonly uid: number; readonly birth: string } | null> {
  const result = await inspection([
    "/bin/ps",
    "-p",
    String(pid),
    "-o",
    "uid=,lstart=",
  ]);
  if (result.code === 1 && result.output === "") {
    return null;
  }
  const match = PROCESS_BIRTH_ROW.exec(result.output);
  const birth = match?.[2]?.replace(/\s+/g, " ");
  const uid = Number(match?.[1]);
  if (
    result.code !== 0 ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    birth === undefined ||
    !BIRTH.test(birth)
  ) {
    refuse();
  }
  return { uid, birth };
}
async function captureLockOwner(): Promise<LockOwner> {
  const birth = await processBirth(process.pid);
  const uid = process.getuid?.();
  if (!birth || uid === undefined || birth.uid !== uid) {
    return refuse();
  }
  return {
    version: 1,
    token: token(),
    pid: process.pid,
    uid,
    bootId: await bootId(),
    birth: birth.birth,
  };
}
function parseLockOwner(text: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return refuse();
  }
  if (
    !(
      isRecord(value) &&
      keys(value, "birth,bootId,pid,token,uid,version") &&
      value.version === 1 &&
      typeof value.token === "string" &&
      TOKEN.test(value.token) &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.uid === "number" &&
      value.uid === process.getuid?.() &&
      typeof value.bootId === "string" &&
      BOOT_ID.test(value.bootId) &&
      typeof value.birth === "string" &&
      BIRTH.test(value.birth)
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    token: value.token,
    pid: value.pid,
    uid: value.uid,
    bootId: value.bootId,
    birth: value.birth,
  };
}
function absentProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}
async function requireDeadOwner(owner: LockOwner): Promise<void> {
  if (
    owner.bootId !== (await bootId()) ||
    owner.uid !== process.getuid?.() ||
    !absentProcess(owner.pid) ||
    (await processBirth(owner.pid)) !== null ||
    !absentProcess(owner.pid)
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
  }
}

export class NativeComposeGenerationError extends Error {
  readonly code:
    | "E_NATIVE_COMPOSE_STATE"
    | "E_NATIVE_COMPOSE_BUSY"
    | "E_NATIVE_COMPOSE_UNCERTAIN"
    | "E_NATIVE_COMPOSE_STALE";
  constructor(
    code:
      | "E_NATIVE_COMPOSE_STATE"
      | "E_NATIVE_COMPOSE_BUSY"
      | "E_NATIVE_COMPOSE_UNCERTAIN"
      | "E_NATIVE_COMPOSE_STALE"
  ) {
    super(
      {
        E_NATIVE_COMPOSE_STATE:
          "Native Compose state is unsafe or changed; values omitted. Inspect owned state before recovery.",
        E_NATIVE_COMPOSE_BUSY:
          "Native Compose instance is busy or has an interrupted lock; explicit ownership recovery is required.",
        E_NATIVE_COMPOSE_UNCERTAIN:
          "Native Compose operation has an uncertain outcome; inspect the saved generation or explicitly stop its owned resources before retrying.",
        E_NATIVE_COMPOSE_STALE:
          "Native Compose inputs changed before execution; prepare a fresh generation. Values omitted.",
      }[code]
    );
    this.code = code;
    // Private one-shot diagnosis only. Preserve this exact exception and expose
    // source frames, never input values, messages, environment or material.
    if (code === "E_NATIVE_COMPOSE_STATE") {
      try {
        console.error(JSON.stringify({
          privateDiagnostic: "ordinary-up-d0",
          stage: "state-factory",
          code,
          frames: (this.stack ?? "").split("\n").filter((line) => line.includes("/src/lib/")).slice(0, 8).map((line) => line.slice(0, 512)),
        }));
      } catch { /* Diagnostics cannot replace the original throw. */ }
    }
  }
}
function refuse(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}
export function token(): string {
  return randomUUID().replaceAll("-", "");
}
export function keys(
  value: Record<string, unknown>,
  expected: string
): boolean {
  return Object.keys(value).sort().join() === expected;
}
export function sameFile(
  left: Stats,
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
async function requireAbsentGuard(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
}
function fileSafe(info: Stats, limit: number): boolean {
  return (
    info.isFile() &&
    info.nlink === 1 &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o777) === 0o600 &&
    info.size > 0 &&
    info.size <= limit
  );
}
export async function holdDirectory(
  path: string,
  privateDirectory: boolean
): Promise<HeldDirectory> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => refuse());
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !(info.isDirectory() && sameFile(info, named)) ||
      named.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (privateDirectory && (info.mode & 0o777) !== 0o700) ||
      (await realpath(path)) !== path
    ) {
      refuse();
    }
    return { path, file, info, private: privateDirectory };
  } catch (error) {
    await file.close();
    throw error;
  }
}
export async function recheckDirectories(
  directories: readonly HeldDirectory[]
): Promise<void> {
  for (const held of directories) {
    const named = await lstat(held.path);
    if (
      !(named.isDirectory() && sameFile(named, held.info)) ||
      named.uid !== process.getuid?.() ||
      (named.mode & 0o022) !== 0 ||
      (held.private && (named.mode & 0o777) !== 0o700) ||
      (await realpath(held.path)) !== held.path
    ) {
      refuse();
    }
  }
}
export async function privateDirectory(path: string): Promise<HeldDirectory> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }
  return await holdDirectory(path, true);
}
export async function readPrivate(
  path: string,
  limit: number
): Promise<{ readonly text: string; readonly info: Stats }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      throw error;
    }
    return refuse();
  });
  try {
    const before = await file.stat();
    if (!fileSafe(before, limit)) {
      refuse();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const named = await lstat(path);
    if (
      bytesRead !== before.size ||
      !fileSafe(after, limit) ||
      !sameFile(before, after) ||
      !sameFile(before, named) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      refuse();
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, bytesRead)
      ),
      info: before,
    };
  } catch {
    return refuse();
  } finally {
    await file.close();
  }
}
export async function jsonPrivate(path: string): Promise<unknown> {
  const read = await readPrivate(path, RECEIPT_LIMIT);
  return parsePrivateJson(read.text);
}
export function parsePrivateJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuse();
  }
}
export async function writeExclusive(
  path: string,
  text: string
): Promise<Stats> {
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(text);
    await file.sync();
    const info = await file.stat();
    if (!fileSafe(info, Buffer.byteLength(text))) {
      refuse();
    }
    return info;
  } finally {
    await file.close();
  }
}
export async function privateIgnore(path: string, create: boolean) {
  if (create) {
    try {
      await writeExclusive(path, "*\n");
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
  }
  const read = await readPrivate(path, 2);
  if (read.text !== "*\n") {
    refuse();
  }
  return read;
}
export async function synchronizeDirectories(
  directories: readonly HeldDirectory[]
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    await directory.file.sync();
  }
}

/** Shared generation file/lock owner. Resource admission and receipt policy remain with each generation owner. */
export function createNativeComposePrivateMutationLock(opts: {
  readonly lockPath: string;
  readonly recoveryPath: string;
  readonly parent: HeldDirectory | undefined;
  readonly check: () => Promise<void>;
}) {
  const { lockPath, recoveryPath, parent, check } = opts;
  const withLock = async <T>(
    run: (lease: NativeComposeMutationLease) => Promise<T>,
    beforeRetire?: (lease: NativeComposeMutationLease) => Promise<void>
  ) => {
    await check();
    await requireAbsentGuard(recoveryPath);
    const lockOwner = await captureLockOwner();
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
      }
      throw error;
    }
    const lock = await holdDirectory(lockPath, true);
    const ownerPath = join(lockPath, "owner");
    const lockToken = JSON.stringify(lockOwner);
    let ownerInfo: Stats | undefined;
    let issued: NativeComposeMutationLease | undefined;
    let active = true;
    const assertHeld = async () => {
      if (!active) {
        refuse();
      }
      await check();
      await requireAbsentGuard(recoveryPath);
      await recheckDirectories([lock]);
      const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
      if (
        !active ||
        ownerInfo === undefined ||
        !sameFile(latest.info, ownerInfo) ||
        latest.text !== lockToken
      ) {
        refuse();
      }
    };
    try {
      ownerInfo = await writeExclusive(ownerPath, lockToken);
      await lock.file.sync();
      await assertHeld();
      const lease = Object.freeze({
        token: lockOwner.token,
        directory: Object.freeze({ dev: lock.info.dev, ino: lock.info.ino }),
        owner: Object.freeze({ dev: ownerInfo.dev, ino: ownerInfo.ino }),
        selection: interruptedSelection(lock, {
          info: ownerInfo,
          text: lockToken,
        }),
        assertActive: () => {
          if (issued === undefined || !mutationLeases.has(issued) || !active) {
            return refuse();
          }
          return undefined;
        },
        assertHeld,
      });
      mutationLeases.add(lease);
      issued = lease;
      return await run(lease);
    } finally {
      try {
        try {
          if (issued !== undefined && beforeRetire !== undefined) {
            await beforeRetire(issued);
          }
        } finally {
          if (issued !== undefined) {
            mutationLeases.delete(issued);
          }
        }
        await assertHeld();
        await unlink(ownerPath);
        await rmdir(lockPath);
        await parent?.file.sync();
      } finally {
        active = false;
        await lock.file.close();
      }
    }
  };

  const selectInterruptedLock = async () => {
    await check();
    await requireAbsentGuard(recoveryPath);
    const lock = await holdDirectory(lockPath, true);
    try {
      const ownerPath = join(lockPath, "owner");
      const original = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
      const selected = interruptedSelection(lock, original);
      await requireDeadOwner(selected.owner);
      await check();
      await requireAbsentGuard(recoveryPath);
      await recheckDirectories([lock]);
      const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
      if (
        !sameFile(original.info, latest.info) ||
        latest.text !== original.text ||
        JSON.stringify(await readdir(lockPath)) !== '["owner"]'
      ) {
        return refuse();
      }
      await requireDeadOwner(selected.owner);
      await recheckDirectories([lock]);
      return selected;
    } finally {
      await lock.file.close();
    }
  };

  const withPreparedRecoveryLock = async <T>(
    input: {
      readonly expected: unknown;
      readonly successor?: unknown;
      /** Only a pre-existing committed release phase may permit absence. */
      readonly allowOwnerAbsent: boolean;
      readonly reserve: (
        reservation: NativeComposePreparedLockReservation
      ) => Promise<void>;
      readonly release: (lease: NativeComposeMutationLease) => Promise<void>;
    },
    run: (lease: NativeComposeMutationLease) => Promise<T>
  ): Promise<T> => {
    const expected = parseNativeComposeInterruptedLockSelection(input.expected);
    const successor =
      input.successor === undefined
        ? undefined
        : parseNativeComposeInterruptedLockSelection(input.successor);
    const allowOwnerAbsent = input.allowOwnerAbsent;
    const reserve = input.reserve;
    const release = input.release;
    if (typeof allowOwnerAbsent !== "boolean") {
      return refuse();
    }
    await check();
    await requireAbsentGuard(recoveryPath);
    if ((await bootId()) !== expected.owner.bootId) {
      return refuse();
    }
    const prepareDirectory = async () => {
      try {
        await lstat(lockPath);
        return true;
      } catch (error) {
        if (
          !(hasCode(error, "ENOENT") && allowOwnerAbsent) ||
          successor !== undefined
        ) {
          throw error;
        }
        await mkdir(lockPath, { mode: 0o700 });
        return false;
      }
    };
    const directoryExists = await prepareDirectory();
    const lock = await holdDirectory(lockPath, true);
    const ownerPath = join(lockPath, "owner");
    const pendingPath = join(lockPath, "owner.pending");
    let active = true;
    let reservationActive = false;
    let issued: NativeComposeMutationLease | undefined;
    const checkDirectory = async () => {
      if (!active) {
        return refuse();
      }
      await check();
      await requireAbsentGuard(recoveryPath);
      await recheckDirectories([lock]);
      if (!active) {
        return refuse();
      }
    };
    const readOwner = async () => {
      try {
        return interruptedSelection(
          lock,
          await readPrivate(ownerPath, LOCK_OWNER_LIMIT)
        );
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }
    };
    const sameSelection = (
      left: NativeComposeInterruptedLockSelection,
      right: NativeComposeInterruptedLockSelection
    ) => JSON.stringify(left) === JSON.stringify(right);
    const matchesAdmitted = (value: NativeComposeInterruptedLockSelection) =>
      sameSelection(value, expected) ||
      (successor !== undefined && sameSelection(value, successor));
    const promoteSavedCandidate = async (
      current: NativeComposeInterruptedLockSelection | undefined
    ) => {
      if (
        !successor ||
        (current !== undefined && !sameSelection(current, expected))
      ) {
        return refuse();
      }
      const pending = interruptedSelection(
        lock,
        await readPrivate(pendingPath, LOCK_OWNER_LIMIT)
      );
      requireInterruptedSelection(successor, pending);
      await requireDeadOwner(successor.owner);
      await checkDirectory();
      if (JSON.stringify(await readOwner()) !== JSON.stringify(current)) {
        return refuse();
      }
      requireInterruptedSelection(
        successor,
        interruptedSelection(
          lock,
          await readPrivate(pendingPath, LOCK_OWNER_LIMIT)
        )
      );
      if (!active) {
        return refuse();
      }
      await rename(pendingPath, ownerPath);
      await lock.file.sync();
      const promoted = await readOwner();
      if (!(promoted && sameSelection(promoted, successor))) {
        return refuse();
      }
      return promoted;
    };
    const admitDirectory = async () => {
      if (
        directoryExists &&
        !sameFile(lock.info, expected.directory) &&
        !(successor && sameFile(lock.info, successor.directory))
      ) {
        return refuse();
      }
      const names = (await readdir(lockPath)).sort();
      if (names.some((name) => name !== "owner" && name !== "owner.pending")) {
        return refuse();
      }
      return names;
    };
    const admitOwner = async () => {
      const names = await admitDirectory();
      const current = await readOwner();
      if (current && !matchesAdmitted(current)) {
        return refuse();
      }
      if (!(current || allowOwnerAbsent)) {
        return refuse();
      }
      if (current) {
        await requireDeadOwner(current.owner);
      }
      if (names.includes("owner.pending")) {
        return await promoteSavedCandidate(current);
      }
      if (successor && !(current && sameSelection(current, successor))) {
        // A reserved candidate may neither disappear nor become an empty dir.
        return refuse();
      }
      return current;
    };
    const runIssuedLease = async (lease: NativeComposeMutationLease) => {
      const result = await run(lease).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
      // Failed release publication retains this exact owner and directory.
      // Issuance spans the awaited release callback, then ends synchronously.
      try {
        await release(lease);
      } finally {
        mutationLeases.delete(lease);
      }
      await lease.assertHeld();
      if (!active) {
        return refuse();
      }
      await unlink(ownerPath);
      await checkDirectory();
      if ((await readdir(lockPath)).length !== 0 || !active) {
        return refuse();
      }
      await rmdir(lockPath);
      await parent?.file.sync();
      if (result.ok) {
        return result.value;
      }
      throw result.error;
    };
    try {
      const current = await admitOwner();
      const previous = current ?? expected;
      await checkDirectory();
      if (JSON.stringify(await readOwner()) !== JSON.stringify(current)) {
        return refuse();
      }
      const owner = await captureLockOwner();
      const text = JSON.stringify(owner);
      const info = await writeExclusive(pendingPath, text);
      await lock.file.sync();
      const next = interruptedSelection(lock, { info, text });
      reservationActive = true;
      const assertReserved = async () => {
        if (!reservationActive) {
          return refuse();
        }
        await checkDirectory();
        if (JSON.stringify(await readOwner()) !== JSON.stringify(current)) {
          return refuse();
        }
        const pending = await readPrivate(pendingPath, LOCK_OWNER_LIMIT);
        if (
          !sameFile(pending.info, info) ||
          pending.text !== text ||
          !reservationActive
        ) {
          return refuse();
        }
      };
      await reserve(
        Object.freeze({
          previous,
          previousAbsent: current === undefined,
          next,
          assertHeld: assertReserved,
          assertActive: () => {
            if (!(active && reservationActive)) {
              return refuse();
            }
            return undefined;
          },
        })
      );
      await assertReserved();
      if (current) {
        await requireDeadOwner(current.owner);
      }
      await assertReserved();
      if (!(active && reservationActive)) {
        return refuse();
      }
      await rename(pendingPath, ownerPath);
      reservationActive = false;
      await lock.file.sync();
      const assertHeld = async () => {
        await checkDirectory();
        if (JSON.stringify(await readdir(lockPath)) !== '["owner"]') {
          return refuse();
        }
        const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
        if (!sameFile(latest.info, info) || latest.text !== text || !active) {
          return refuse();
        }
      };
      await assertHeld();
      const lease: NativeComposeMutationLease = Object.freeze({
        token: owner.token,
        directory: Object.freeze({ dev: lock.info.dev, ino: lock.info.ino }),
        owner: Object.freeze({ dev: info.dev, ino: info.ino }),
        selection: next,
        assertHeld,
        assertActive: () => {
          if (!active || issued === undefined || !mutationLeases.has(issued)) {
            return refuse();
          }
          return undefined;
        },
      });
      issued = lease;
      mutationLeases.add(lease);
      return await runIssuedLease(lease);
    } finally {
      if (issued) {
        mutationLeases.delete(issued);
      }
      reservationActive = false;
      active = false;
      await lock.file.close();
    }
  };

  const retireInterruptedLock = async (
    recovery: HeldDirectory,
    expected: NativeComposeInterruptedLockSelection | undefined
  ) => {
    const lock = await holdDirectory(lockPath, true);
    try {
      const ownerPath = join(lockPath, "owner");
      const original = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
      const owner = parseLockOwner(original.text);
      if (expected !== undefined) {
        requireInterruptedSelection(
          expected,
          interruptedSelection(lock, original)
        );
      }
      await requireDeadOwner(owner);
      await check();
      await recheckDirectories([recovery, lock]);
      const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
      if (
        !sameFile(original.info, latest.info) ||
        latest.text !== original.text ||
        JSON.stringify(await readdir(lockPath)) !== '["owner"]'
      ) {
        return refuse();
      }
      await requireDeadOwner(owner);
      await recheckDirectories([recovery, lock]);
      if (expected !== undefined) {
        await check();
        await recheckDirectories([recovery, lock]);
        const final = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
        if (
          !sameFile(original.info, final.info) ||
          final.text !== original.text
        ) {
          return refuse();
        }
      }
      await unlink(ownerPath);
      await rmdir(lockPath);
      await parent?.file.sync();
    } finally {
      await lock.file.close();
    }
  };

  const recoverInterruptedLock = async (
    expected?: NativeComposeInterruptedLockSelection
  ) => {
    await check();
    await requireAbsentGuard(recoveryPath);
    try {
      await lstat(lockPath);
    } catch (error) {
      if (hasCode(error, "ENOENT") && expected === undefined) {
        return;
      }
      throw error;
    }
    if (expected !== undefined) {
      requireInterruptedSelection(expected, await selectInterruptedLock());
    }
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
      }
      throw error;
    }
    const recovery = await holdDirectory(recoveryPath, true);
    try {
      await retireInterruptedLock(recovery, expected);
    } finally {
      try {
        await check();
        await recheckDirectories([recovery]);
        await rmdir(recoveryPath);
        await parent?.file.sync();
      } finally {
        await recovery.file.close();
      }
    }
  };

  return {
    withLock: <T>(run: (lease: NativeComposeMutationLease) => Promise<T>) =>
      withLock(run),
    /** Fresh recovery issuance retains its exact owner if durable release fails.
     * Existing generation callers keep the original unconditional finalizer. */
    withFreshRecoveryLock: <T>(
      opts: {
        readonly release: (lease: NativeComposeMutationLease) => Promise<void>;
      },
      run: (lease: NativeComposeMutationLease) => Promise<T>
    ) => withLock(run, opts.release),
    /** Stable-directory takeover for an exact durable successor/release protocol.
     * Unknown pending publications refuse; this never issues authority from data. */
    withPreparedRecoveryLock,
    /** Native startup admission uses the same active lease without material authority. */
    withHeldLock: <T>(run: (assertHeld: () => Promise<void>) => Promise<T>) =>
      withLock((lease) => run(lease.assertHeld)),
    recoverInterruptedLock: () => recoverInterruptedLock(),
    /** Read-only current dead/same-host-boot snapshot; no lock is created or retired. */
    selectInterruptedLock,
    /** Capture caller input before any await; absence or a changed inode never grants retirement. */
    recoverSelectedInterruptedLock(value: unknown) {
      const expected = parseNativeComposeInterruptedLockSelection(value);
      return recoverInterruptedLock(expected);
    },
    /** Retain the actual named recovery lease through caller-owned durable retirement.
     * Expected owner absence is legal only after the caller committed its exact
     * retirement intent. Neither a selector nor a fabricated lease grants this API. */
    retireSelectedUnderRecoveryLease(opts: {
      readonly selected: unknown;
      readonly lease: NativeComposeMutationLease;
      readonly allowOwnerAbsent?: boolean;
    }) {
      const expected = parseNativeComposeInterruptedLockSelection(
        opts.selected
      );
      const lease = opts.lease;
      const allowOwnerAbsent = opts.allowOwnerAbsent ?? false;
      if (!mutationLeases.has(lease) || typeof allowOwnerAbsent !== "boolean") {
        return refuse();
      }
      return (async () => {
        await lease.assertHeld();
        const recovery = await holdDirectory(recoveryPath, true);
        try {
          if (!sameFile(recovery.info, lease.directory)) {
            return refuse();
          }
          const verify = async () => {
            await lease.assertHeld();
            await check();
            await recheckDirectories([recovery]);
          };
          await verify();
          const lock = await holdDirectory(lockPath, true);
          try {
            if (!sameFile(lock.info, expected.directory)) {
              return refuse();
            }
            const ownerPath = join(lockPath, "owner");
            await requireDeadOwner(expected.owner);
            await verify();
            await recheckDirectories([lock]);
            const names = await readdir(lockPath);
            if (
              JSON.stringify(names) !== '["owner"]' &&
              !(allowOwnerAbsent && names.length === 0)
            ) {
              return refuse();
            }
            const current = await readPrivate(
              ownerPath,
              LOCK_OWNER_LIMIT
            ).catch((error: unknown) => {
              if (allowOwnerAbsent && hasCode(error, "ENOENT")) {
                return undefined;
              }
              throw error;
            });
            if (current !== undefined) {
              requireInterruptedSelection(
                expected,
                interruptedSelection(lock, current)
              );
              lease.assertActive();
              await unlink(ownerPath);
            }
            await verify();
            await recheckDirectories([lock]);
            if ((await readdir(lockPath)).length !== 0) {
              return refuse();
            }
            lease.assertActive();
            await rmdir(lockPath);
            await parent?.file.sync();
          } finally {
            await lock.file.close();
          }
        } finally {
          await recovery.file.close();
        }
      })();
    },
  };
}
