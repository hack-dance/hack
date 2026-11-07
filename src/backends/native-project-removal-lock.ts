import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeProjectRunScope,
  nativeRestartOperationLock,
} from "./native-project-run.ts";

const OWNER_FILE = "owner";
const OWNER_LIMIT = 128;
const OWNER_PATTERN = /^remove-data\n([1-9]\d{0,9})\n[a-f0-9-]{36}\n$/;

function busy(): Error {
  return new ClosedCliError(
    "Native data removal refused: a native restart, recovery or removal holds the operation lock, or an interrupted one left it without proof that its owner exited; inspect it before recovery. Nothing was removed."
  );
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Only ESRCH proves exit; live, reused or inaccessible pids keep the lock. */
function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

/** Exclusive `mkdir`; EEXIST reports an occupied path, anything else refuses. */
async function enter(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      return false;
    }
    throw busy();
  }
}

/**
 * The complete removal owner inside a private lock directory, or null for
 * anything else: no owner (restart, filesystem recovery, an interrupted
 * publish), a foreign or malformed record, or an unsafe path.
 */
async function readOwner(
  lock: string
): Promise<{ readonly bytes: string; readonly pid: number } | null> {
  const uid = process.getuid?.();
  const held = await lstat(lock).catch(() => null);
  if (
    !held?.isDirectory() ||
    held.uid !== uid ||
    (held.mode & 0o777) !== 0o700
  ) {
    return null;
  }
  const fd = await open(
    join(lock, OWNER_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => null);
  if (!fd) {
    return null;
  }
  try {
    const info = await fd.stat();
    if (
      !info.isFile() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0 ||
      info.size < 1 ||
      info.size > OWNER_LIMIT
    ) {
      return null;
    }
    const buffer = Buffer.alloc(OWNER_LIMIT + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead).toString("utf8");
    const pid = Number(OWNER_PATTERN.exec(bytes)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? { bytes, pid } : null;
  } finally {
    await fd.close();
  }
}

/** Retire an abandoned removal lock only after its recorded owner exited. */
async function recoverExitedRemoval(lock: string): Promise<void> {
  // This observation narrows guard traffic; it never authorizes removal alone.
  const observed = await readOwner(lock);
  if (!(observed && exited(observed.pid))) {
    return;
  }
  const guard = `${lock}.recovery`;
  if (!(await enter(guard))) {
    return;
  }
  try {
    // Re-read inside the guard: another reclaimer may have retired it first.
    const owner = await readOwner(lock);
    if (owner?.bytes === observed.bytes && exited(owner.pid)) {
      await unlink(join(lock, OWNER_FILE));
      await rmdir(lock);
    }
  } finally {
    await rmdir(guard);
  }
}

async function releaseIfOwned(lock: string, bytes: string): Promise<void> {
  if ((await readOwner(lock))?.bytes === bytes) {
    await unlink(join(lock, OWNER_FILE));
    await rmdir(lock);
  }
}

async function writeOwner(path: string, bytes: string): Promise<void> {
  const fd = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

/**
 * Hold the native operation lock for data removal. It is the same directory
 * that restart and filesystem recovery take with `mkdir`, so every holder,
 * including older binaries, still excludes the others. Removal also
 * hard-links a complete owner record (operation, pid and nonce) into it.
 *
 * Recovery follows the projects-registry lock protocol: age is not
 * authority. Only ESRCH for the recorded pid permits reclamation, under a
 * separate `<lock>.recovery` guard that re-reads the owner first. A live,
 * reused or inaccessible pid, a missing or malformed owner, and a lock held by
 * restart or filesystem recovery (which record no owner) all still refuse.
 * A removal killed between `mkdir` and publishing its owner leaves an
 * owner-less lock that is never reclaimed, and the guard is never
 * age-reclaimed; both require inspection.
 *
 * Reclaiming is sound for removal because the lock guards no effect that a
 * dead owner can still be performing unseen: the runtime serializes graph
 * cleanup under its own lease and durable cleanup intent, and the rerun
 * re-inspects before requesting cleanup or retiring the mapping.
 */
export async function withNativeRemovalLock<T>(
  scope: NativeProjectRunScope,
  action: () => Promise<T>
): Promise<T> {
  const { root, lock } = await nativeRestartOperationLock(scope);
  const bytes = `remove-data\n${process.pid}\n${randomUUID()}\n`;
  const staging = join(root, `${randomUUID()}.tmp`);
  await writeOwner(staging, bytes);
  try {
    if (!(await enter(lock))) {
      await recoverExitedRemoval(lock).catch(() => undefined);
      if (!(await enter(lock))) {
        throw busy();
      }
    }
    try {
      await link(staging, join(lock, OWNER_FILE));
    } catch {
      await rmdir(lock);
      throw busy();
    }
  } finally {
    await unlink(staging).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
  try {
    return await action();
  } finally {
    await releaseIfOwned(lock, bytes);
  }
}
