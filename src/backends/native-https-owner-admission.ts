/** Short shared-owner admission lock. It covers config creation/read/spawn and explicit archival,
 * never a lease or long-lived HTTPS session. An interrupted owner retains the lock for review.
 */
import { lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import { nativeHttpsOwnerRefused } from "./native-https-owner-protocol.ts";
import { nativeHttpsPrivateDirectory } from "./native-https-owner-storage.ts";

export const NATIVE_HTTPS_OWNER_ADMISSION = "shared-owner-admission.lock";

async function identity(
  path: string
): Promise<{ readonly dev: number; readonly ino: number }> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const after = await lstat(path);
  if (after.dev !== stat.dev || after.ino !== stat.ino) {
    throw nativeHttpsOwnerRefused();
  }
  return { dev: stat.dev, ino: stat.ino };
}

/** Existing private locks are waited on only by normal admission; recovery fails closed. */
export async function acquireNativeHttpsOwnerAdmission(opts: {
  readonly home: string;
  readonly waitMs: 0 | 15_000;
}): Promise<{ readonly path: string; release(): Promise<void> }> {
  await nativeHttpsPrivateDirectory(opts.home);
  const storage = join(opts.home, "native-https");
  await nativeHttpsPrivateDirectory(storage);
  const path = join(storage, NATIVE_HTTPS_OWNER_ADMISSION);
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      const mine = await identity(path);
      let released = false;
      return {
        path,
        async release() {
          if (released) {
            throw nativeHttpsOwnerRefused();
          }
          const current = await identity(path);
          if (
            current.dev !== mine.dev ||
            current.ino !== mine.ino ||
            (await readdir(path)).length !== 0
          ) {
            throw nativeHttpsOwnerRefused();
          }
          await rmdir(path);
          released = true;
        },
      };
    } catch (error) {
      if (!(isRecord(error) && error.code === "EEXIST")) {
        throw error;
      }
      // A foreign or malformed entry is never waited on, adopted, or removed.
      try {
        await identity(path);
      } catch (identityError) {
        if (isRecord(identityError) && identityError.code === "ENOENT") {
          continue;
        }
        throw identityError;
      }
      if (Date.now() >= deadline) {
        throw nativeHttpsOwnerRefused();
      }
      await Bun.sleep(25);
    }
  }
}
