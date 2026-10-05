import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./guards.ts";

const WAIT_MS = 10_000;
const OWNER_LIMIT = 128;
const OWNER_PATTERN = /^([1-9]\d*)\n(?:[a-f0-9-]{36}\n)?$/;

interface Owner {
  readonly info: Stats;
  readonly bytes: string;
  readonly pid: number;
}

/**
 * Serialize cooperative registry writers. A fully written owner is published by
 * an exclusive hard link, so a killed publisher never leaves an empty lock.
 * Age is not authority: only ESRCH permits reclamation, under a separate guard.
 * Live/reused/inaccessible PIDs and uncertain receipts are never reclaimed.
 *
 * The recovery guard is deliberately not age-reclaimed. A crashed reclaimer may
 * need explicit offline recovery; recursively stealing its guard recreates the
 * successor-deletion race. Legacy v4 writers do not honor this protocol.
 */
export async function withProjectsRegistryLock<T>(opts: {
  readonly lockPath: string;
  readonly run: () => Promise<T>;
  readonly waitForLock?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<T> {
  opts.signal?.throwIfAborted();
  if (opts.waitForLock === false) {
    // Advisory only: occupied optional refreshes may defer without creating an
    // owner file. Absence NEVER grants ownership; publish still uses atomic link.
    const occupied = await lockPathOccupied(opts.lockPath);
    opts.signal?.throwIfAborted();
    if (occupied) {
      throw new Error("Projects registry is busy; optional touch deferred");
    }
  }
  const candidate = `${opts.lockPath}.${randomUUID()}.owner`;
  const file = await open(candidate, "wx", 0o600);
  try {
    const bytes = `${process.pid}\n${randomUUID()}\n`;
    await file.writeFile(bytes);
    const owner: Owner = { info: await file.stat(), bytes, pid: process.pid };
    await acquire({ ...opts, candidate });
    try {
      // The descriptor stays open until release, preventing inode reuse while a
      // caller still holds its receipt. Remove the staging name before running.
      await unlink(candidate);
      opts.signal?.throwIfAborted();
      return await opts.run();
    } finally {
      await releaseIfOwned(opts.lockPath, owner);
    }
  } finally {
    await file.close();
    await removeAbsentOkay(candidate);
  }
}

async function lockPathOccupied(path: string): Promise<boolean> {
  try {
    // Include dangling symlinks and malformed receipts; optional maintenance
    // never follows, interprets, or reclaims an occupied path.
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function acquire(opts: {
  readonly lockPath: string;
  readonly candidate: string;
  readonly waitForLock?: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<void> {
  const started = performance.now();
  const timeout = opts.timeoutMs ?? WAIT_MS;
  let recoveryBusy = false;
  while (true) {
    opts.signal?.throwIfAborted();
    if (await publish(opts.candidate, opts.lockPath)) {
      return;
    }
    if (opts.waitForLock === false) {
      throw new Error("Projects registry is busy; optional touch deferred");
    }
    recoveryBusy = await recoverDeadOwner(opts.lockPath);
    const remaining = timeout - (performance.now() - started);
    if (remaining <= 0) {
      const recovery = recoveryBusy
        ? "; recovery guard is busy (interrupted recovery requires offline inspection)"
        : "";
      throw new Error(
        `Timed out waiting for projects registry lock${recovery}`
      );
    }
    // Jitter prevents a burst of CLI clients from retrying in lockstep.
    await delay(Math.min(25 + Math.random() * 75, remaining), undefined, {
      signal: opts.signal,
    });
  }
}

async function publish(candidate: string, path: string): Promise<boolean> {
  try {
    await link(candidate, path);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o022) === 0 &&
    info.size > 0 &&
    info.size <= OWNER_LIMIT
  );
}

async function readOwnerFile(file: FileHandle): Promise<Owner | null> {
  const info = await file.stat();
  if (!validFile(info)) {
    return null;
  }
  const buffer = Buffer.alloc(OWNER_LIMIT + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  const after = await file.stat();
  if (bytesRead !== info.size || after.size !== info.size) {
    return null;
  }
  const bytes = buffer.subarray(0, bytesRead).toString("utf8");
  const match = OWNER_PATTERN.exec(bytes);
  const pid = Number(match?.[1]);
  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    return null;
  }
  return { info, bytes, pid };
}

async function readOwner(path: string): Promise<Owner | null> {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) {
      return null;
    }
    throw error;
  }
  try {
    const owner = await readOwnerFile(file);
    const named = await lstat(path).catch(() => null);
    return owner && named && sameFile(owner.info, named) && named.isFile()
      ? owner
      : null;
  } finally {
    await file.close();
  }
}

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, "ESRCH");
  }
}

async function releaseIfOwned(path: string, owner: Owner): Promise<void> {
  const latest = await readOwner(path);
  if (
    latest &&
    sameFile(latest.info, owner.info) &&
    latest.bytes === owner.bytes
  ) {
    await removeAbsentOkay(path);
  }
}

/** Return true only when another reclaimer owns the guard. */
async function recoverDeadOwner(path: string): Promise<boolean> {
  // This cheap observation may avoid guard traffic, but NEVER authorizes unlink.
  const observed = await readOwner(path);
  if (!(observed && dead(observed.pid))) {
    return false;
  }
  const guard = `${path}.recovery`;
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      return true;
    }
    throw error;
  }
  try {
    // Re-read after entering the guard: the old observation may name an owner
    // replaced by another reclaimer and a new writer while we were waiting.
    const owner = await readOwner(path);
    if (owner && dead(owner.pid)) {
      await releaseIfOwned(path, owner);
    }
  } finally {
    await rmdir(guard);
  }
  return false;
}

async function removeAbsentOkay(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
}

/** Commit by rename only after the unique private staging file is complete. */
export async function writeProjectsRegistryAtomic(opts: {
  readonly path: string;
  readonly text: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  opts.signal?.throwIfAborted();
  const temporary = `${opts.path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(opts.text);
    await file.sync();
    opts.signal?.throwIfAborted();
    await rename(temporary, opts.path);
  } finally {
    await file.close();
    await removeAbsentOkay(temporary);
  }
}
