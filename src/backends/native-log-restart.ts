import { createHash, randomUUID } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../lib/guards.ts";
import {
  holdDirectory,
  privateDirectory,
  readPrivate,
  recheckDirectories,
  writeExclusive,
} from "../lib/native-compose-private-state.ts";
import type { NativeLogFollowSelection } from "./native-log-follow.ts";

type Scope = {
  readonly nativeHome: string;
  readonly projectRoot: string;
  readonly branch: string | null;
};
function markerPath(scope: Scope) {
  const key = createHash("sha256")
    .update(JSON.stringify([scope.projectRoot, scope.branch]))
    .digest("hex");
  return {
    directory: join(scope.nativeHome, "log-restart-notices"),
    name: `${key}.json`,
  };
}
/** Advisory only: failures must never change the lifecycle owner's result. */
export async function publishLogRestart(
  scope: Scope,
  lifetimeMs = 30_000
): Promise<() => Promise<void>> {
  try {
    return await publish(
      scope,
      Math.min(Math.max(lifetimeMs, 30_000), 330_000)
    );
  } catch {
    return async () => undefined;
  }
}
async function publish(scope: Scope, lifetimeMs: number) {
  const { directory, name } = markerPath(scope);
  const held = await privateDirectory(directory);
  const token = randomUUID();
  const temporary = join(directory, token);
  const path = join(directory, name);
  const createdAt = Date.now();
  const text = JSON.stringify({
    version: 1,
    token,
    createdAt,
    expiresAt: createdAt + lifetimeMs,
  });
  try {
    await writeExclusive(temporary, text);
    await recheckDirectories([held]);
    await rename(temporary, path);
    await held.file.sync();
  } finally {
    await unlink(temporary).catch(() => undefined);
    await held.file.close();
  }
  return async () => {
    try {
      const held = await holdDirectory(directory, true);
      try {
        const current = await readPrivate(path, 256);
        await recheckDirectories([held]);
        if (current.text === text) {
          await unlink(path);
          await held.file.sync();
        }
      } finally {
        await held.file.close();
      }
    } catch {
      /* A stale notice expires; retirement cannot mask restart's outcome. */
    }
  };
}
export async function hasLogRestart(scope: Scope): Promise<boolean> {
  const { directory, name } = markerPath(scope);
  try {
    await lstat(directory);
    const held = await holdDirectory(directory, true);
    try {
      const { text } = await readPrivate(join(directory, name), 256);
      const marker: unknown = JSON.parse(text);
      await recheckDirectories([held]);
      return (
        isRecord(marker) &&
        marker.version === 1 &&
        typeof marker.createdAt === "number" &&
        Number.isSafeInteger(marker.createdAt) &&
        marker.createdAt <= Date.now() &&
        typeof marker.expiresAt === "number" &&
        Number.isSafeInteger(marker.expiresAt) &&
        marker.expiresAt - marker.createdAt <= 330_000 &&
        Date.now() < marker.expiresAt
      );
    } finally {
      await held.file.close();
    }
  } catch {
    return false;
  }
}

/** Read-only work may settle after abort, but cannot hold the CLI or authorize effects. */
export function abortableLogRead<T>(
  read: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(read)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Compare admitted compute, never the run ID retained across adopted restores. */
export function isNewLogContainer(
  previous: NativeLogFollowSelection,
  next: NativeLogFollowSelection
): boolean {
  // Adopted restore retains the run and provider owner, but recreates compute.
  // Same-container Engine restarts remain a named refusal, never a replay.
  return (
    next.namespace === previous.namespace &&
    next.native === previous.native &&
    previous.container !== undefined &&
    next.container !== undefined &&
    next.container !== previous.container
  );
}

/** Re-admission supplies all authority. No mutation lease is held while waiting. */
export async function resumeNativeLogs(input: {
  readonly previous: NativeLogFollowSelection;
  readonly signal: AbortSignal;
  readonly restarting: () => Promise<boolean>;
  readonly select: (signal: AbortSignal) => Promise<NativeLogFollowSelection>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<NativeLogFollowSelection | null> {
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs ?? 30_000),
  ]);
  const fresh = async () => {
    input.signal.throwIfAborted();
    try {
      const next = await abortableLogRead(() => input.select(signal), signal);
      return isNewLogContainer(input.previous, next) ? next : null;
    } catch {
      input.signal.throwIfAborted();
      if (signal.aborted) {
        throw new NativeLogRestartUnavailable();
      }
      return null;
    }
  };
  // The marker may already be retired when the old Engine transport ends.
  const next = await fresh();
  if (next) {
    return next;
  }
  if (!(await abortableLogRead(input.restarting, signal))) {
    return null;
  }
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await delay(
      Math.min(input.intervalMs ?? 1000, Math.max(1, deadline - Date.now())),
      undefined,
      { signal: input.signal }
    );
    const next = await fresh();
    if (next) {
      return next;
    }
  }
  throw new NativeLogRestartUnavailable();
}
export class NativeLogRestartUnavailable extends Error {
  readonly reason = "native_log_restart_unavailable";
}
