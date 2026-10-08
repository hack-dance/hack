import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards.ts";
import { beginNativeCpuChild } from "./native-cpu-diagnostics.ts";

const TOKEN = /^[a-f0-9]{32}$/;
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
  readonly assertHeld: () => Promise<void>;
};
type LockOwner = {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly uid: number;
  readonly bootId: string;
  readonly birth: string;
};

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
    run: (lease: NativeComposeMutationLease) => Promise<T>
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
      return await run(
        Object.freeze({
          token: lockOwner.token,
          directory: Object.freeze({ dev: lock.info.dev, ino: lock.info.ino }),
          owner: Object.freeze({ dev: ownerInfo.dev, ino: ownerInfo.ino }),
          assertHeld,
        })
      );
    } finally {
      try {
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

  return {
    withLock,
    /** Native startup admission uses the same active lease without material authority. */
    withHeldLock: <T>(run: (assertHeld: () => Promise<void>) => Promise<T>) =>
      withLock((lease) => run(lease.assertHeld)),
    async recoverInterruptedLock() {
      await check();
      await requireAbsentGuard(recoveryPath);
      try {
        await lstat(lockPath);
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return;
        }
        throw error;
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
        const lock = await holdDirectory(lockPath, true);
        try {
          const ownerPath = join(lockPath, "owner");
          const original = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
          const owner = parseLockOwner(original.text);
          await requireDeadOwner(owner);
          await check();
          await recheckDirectories([recovery, lock]);
          const latest = await readPrivate(ownerPath, LOCK_OWNER_LIMIT);
          if (
            !sameFile(original.info, latest.info) ||
            latest.text !== original.text ||
            JSON.stringify(await readdir(lockPath)) !== '["owner"]'
          ) {
            refuse();
          }
          await requireDeadOwner(owner);
          await recheckDirectories([recovery, lock]);
          await unlink(ownerPath);
          await rmdir(lockPath);
          await parent?.file.sync();
        } finally {
          await lock.file.close();
        }
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
    },
  };
}
