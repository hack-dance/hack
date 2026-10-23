import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { closedFileWriteError, ensureDirForWrite } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "./projects-registry-lock.ts";

/** Default bounded wait for another writer of the same env layer. */
export const ENV_LAYER_LOCK_WAIT_MS = 10_000;

/**
 * Another `hack env` writer held the layer's lock for the whole bounded wait
 * (or an interrupted lock recovery needs offline inspection). Closed and
 * retryable: nothing was read or written, and the message names only the
 * layer path, never a key or value.
 */
export class EnvLayerLockTimeoutError extends ClosedCliError {
  constructor(opts: { readonly path: string; readonly waitMs: number }) {
    super(
      `Another hack env command is writing ${opts.path}; gave up after waiting ${formatWait(opts.waitMs)} for it. Nothing was written. Retry when it finishes.`
    );
    this.name = "EnvLayerLockTimeoutError";
  }
}

/**
 * A `.internal` entry next to the layer that is a symlink or not a directory.
 * The lock is never created through it.
 */
export class EnvLayerLockRefusedError extends ClosedCliError {
  constructor(opts: { readonly path: string }) {
    super(
      `Refused to update ${opts.path}: the .internal entry beside it is a symlink or not a directory, so its write lock cannot be taken safely. Replace it with a regular directory and retry. Nothing was written.`
    );
    this.name = "EnvLayerLockRefusedError";
  }
}

/**
 * Lock path for one env layer file: `<layer dir>/.internal/<layer name>.lock`.
 * `.internal/` is in Hack's managed `.hack/.gitignore`, so the lock and its
 * short-lived `.owner` staging names never show up in `git status`.
 */
export function resolveEnvLayerLockPath(opts: {
  readonly layerPath: string;
}): string {
  return join(
    dirname(opts.layerPath),
    ".internal",
    `${basename(opts.layerPath)}.lock`
  );
}

/**
 * Serializes one read-modify-write of an env layer file (`hack.env*.yaml`,
 * `.hack/.env*`) across processes.
 *
 * Contract:
 * - `run` must read the layer, compute the change and write it; it runs while
 *   this process exclusively holds the layer's cooperative lock, so two
 *   writers that both use this helper never lose each other's update (the
 *   second reads what the first wrote).
 * - The lock is the projects-registry owner protocol: an exclusive hard-link
 *   publish of a complete `pid + nonce` receipt, released only by its owner,
 *   reclaimed only after `kill(pid, 0)` reports the owner gone (ESRCH).
 * - The wait is bounded (`timeoutMs`, default {@link ENV_LAYER_LOCK_WAIT_MS})
 *   with jittered polling. When it runs out, {@link EnvLayerLockTimeoutError}
 *   is thrown and `run` never starts, so nothing is written.
 * - A symlinked or non-directory `.internal` beside the layer is refused with
 *   {@link EnvLayerLockRefusedError}; a filesystem failure while taking the
 *   lock (permission, full disk) is refused as the layer it blocked, never as
 *   the lock's random staging name. Errors from `run` propagate unchanged.
 * - Exception: when the lock cannot be taken and the layer's own directory is
 *   not writable (a read-only checkout or mount), `run` runs without the lock.
 *   No Hack writer can replace that layer, so nothing can be lost, a no-op
 *   set or unset still succeeds and a real change is refused by the write.
 * - Writers that do not take this lock (Hack v4, editors) are not excluded;
 *   callers additionally compare-and-swap against the bytes they read.
 */
export async function withEnvLayerLock<T>(opts: {
  readonly layerPath: string;
  readonly run: () => Promise<T>;
  /** Bounded wait override; tests only. */
  readonly timeoutMs?: number;
}): Promise<T> {
  const lockPath = resolveEnvLayerLockPath(opts);
  const waitMs = opts.timeoutMs ?? ENV_LAYER_LOCK_WAIT_MS;
  let started = false;
  try {
    await ensureEnvLayerLockDirectory({
      layerPath: opts.layerPath,
      lockDir: dirname(lockPath),
    });
    return await withProjectsRegistryLock({
      lockPath,
      label: "env layer",
      timeoutMs: waitMs,
      run: async () => {
        started = true;
        return await opts.run();
      },
    });
  } catch (error: unknown) {
    if (started || error instanceof EnvLayerLockRefusedError) {
      throw error;
    }
    if (error instanceof ProjectsRegistryLockTimeoutError) {
      throw new EnvLayerLockTimeoutError({ path: opts.layerPath, waitMs });
    }
    if (!(await directoryWritable(dirname(opts.layerPath)))) {
      // No Hack writer can replace a layer whose directory it cannot write
      // (every replace stages a sibling and renames it), so there is nothing
      // to serialize: run unlocked, so a no-op set or unset still succeeds
      // and a real change is refused by the writer itself, as before.
      return await opts.run();
    }
    throw closedFileWriteError({
      error,
      path: opts.layerPath,
      operation: "write",
    });
  }
}

async function directoryWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureEnvLayerLockDirectory(opts: {
  readonly layerPath: string;
  readonly lockDir: string;
}): Promise<void> {
  if (!(await lockDirectoryState(opts)).absent) {
    return;
  }
  await ensureDirForWrite(opts.lockDir);
  // Re-check: something other than a directory may have raced the mkdir.
  await lockDirectoryState(opts);
}

async function lockDirectoryState(opts: {
  readonly layerPath: string;
  readonly lockDir: string;
}): Promise<{ readonly absent: boolean }> {
  let isDirectory: boolean;
  try {
    isDirectory = (await lstat(opts.lockDir)).isDirectory();
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { absent: true };
    }
    throw closedFileWriteError({
      error,
      path: opts.layerPath,
      operation: "write",
    });
  }
  if (!isDirectory) {
    throw new EnvLayerLockRefusedError({ path: opts.layerPath });
  }
  return { absent: false };
}

function formatWait(waitMs: number): string {
  return waitMs >= 1000 && waitMs % 1000 === 0
    ? `${waitMs / 1000}s`
    : `${waitMs}ms`;
}
