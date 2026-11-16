import { dlopen, FFIType, ptr } from "bun:ffi";
import type { Stats } from "node:fs";
import { closeSync, constants, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import { canonical, requireThat } from "./integrity.ts";

type DirectoryIdentity = Pick<
  Stats,
  "dev" | "ino" | "uid" | "mode" | "isDirectory"
>;
/** Only the current invocation's recorded private directory can qualify as a loser stage. */
export function isFreshInitializerStage(
  created: DirectoryIdentity,
  observed: DirectoryIdentity,
  uid: number | undefined
) {
  return (
    created.isDirectory() &&
    observed.isDirectory() &&
    created.uid === uid &&
    observed.uid === uid &&
    created.dev === observed.dev &&
    created.ino === observed.ino &&
    (created.mode & 0o7777) === 0o700 &&
    (observed.mode & 0o7777) === 0o700
  );
}

/** An effect happened but its containing directory did not reach the fsync boundary. */
export class PublicationUncertain extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Publication durability is uncertain at ${path}; the effect may already be committed. Inspect authoritative on-disk receipts before retrying. No rollback was attempted.`,
      { cause }
    );
    this.name = "PublicationUncertain";
  }
}
/** Never convert a post-effect sync failure into a claim that the old state was preserved. */
export function publishAndSync(
  path: string,
  effect: () => void,
  sync: () => void
) {
  effect();
  try {
    sync();
  } catch (error) {
    throw new PublicationUncertain(path, error);
  }
}

/** Same-parent directory publication that never replaces even an empty target.
 * Darwin SDK sys/stdio.h: renameatx_np(int,const char*,int,const char*,unsigned), RENAME_EXCL=4.
 * Linux upstream include/uapi/linux/fs.h: RENAME_NOREPLACE=1; glibc stdio-common/renameat2.c
 * exports the same five-argument signature. No ordinary-rename fallback is permitted.
 * Filesystems lacking the primitive refuse; the private sibling stage is retained.
 */
export function publishDirectoryExclusive(
  source: string,
  target: string
): boolean {
  canonical(source);
  canonical(target);
  requireThat(
    dirname(source) === dirname(target),
    "Initialization publication requires sibling paths."
  );
  requireThat(
    process.platform === "darwin" || process.platform === "linux",
    "Atomic no-replace publication is unavailable on this platform."
  );
  const name = process.platform === "darwin" ? "renameatx_np" : "renameat2";
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      [name]: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
    }
  );
  let fd: number;
  try {
    fd = openSync(dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    library.close();
    throw error;
  }
  const from = Buffer.from(`${basename(source)}\0`);
  const to = Buffer.from(`${basename(target)}\0`);
  try {
    const rename = library.symbols[name];
    requireThat(rename, "No-replace rename symbol unavailable.");
    return (
      rename(
        fd,
        ptr(from),
        fd,
        ptr(to),
        process.platform === "darwin" ? 4 : 1
      ) === 0
    );
  } finally {
    closeSync(fd);
    library.close();
  }
}
