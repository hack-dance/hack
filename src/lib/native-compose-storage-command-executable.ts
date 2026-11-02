import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import type { NativeComposeStorageCommandExecutable } from "./native-compose-storage-command-record.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

/** Coarser than any supported filesystem timestamp granularity (1 s on HFS+/ext3). */
const RACY_MS = 2000;
const LIMIT = 268_435_456n;

async function digestContent(file: FileHandle, size: number): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  const bytes = Buffer.alloc(65_536);
  let position = 0;
  while (position < size) {
    const read = await file.read(
      bytes,
      0,
      Math.min(bytes.length, size - position),
      position
    );
    if (read.bytesRead <= 0) {
      return refuse();
    }
    hash.update(bytes.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash.digest("hex");
}

/**
 * Identity and SHA-256 of a recorded command executable (the Docker CLI and
 * `/bin/sh`), with every open, type, link-count, size, write-mode, before/after
 * stat, named-path and canonical-path check run on each call.
 *
 * Only the content read is cached, for the life of one CLI process (one native
 * command), keyed by the canonical path and the complete stat identity: device,
 * inode, size, mtime and ctime in nanoseconds, mode and owner. Any change to any
 * of them re-reads the content. Like Git's racily clean index entries, a file
 * whose mtime or ctime is within two seconds of the read is never cached, so a
 * write inside the same timestamp tick as the hashed bytes cannot be hidden.
 * `now` and `digest` exist for focused tests only.
 */
export function createNativeComposeStorageCommandExecutableReader(
  opts: {
    readonly now?: () => number;
    readonly digest?: (file: FileHandle, size: number) => Promise<string>;
  } = {}
): (path: string) => Promise<NativeComposeStorageCommandExecutable> {
  const now = opts.now ?? Date.now;
  const digest = opts.digest ?? digestContent;
  const settled = new Map<
    string,
    { readonly identity: string; readonly hash: string }
  >();
  return async (path) => {
    const canonical = await realpath(path);
    const file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size <= 0n ||
        before.size > LIMIT ||
        (before.mode & 0o022n) !== 0n
      ) {
        return refuse();
      }
      const identity = JSON.stringify(
        [
          before.dev,
          before.ino,
          before.size,
          before.mtimeNs,
          before.ctimeNs,
          before.mode,
          before.uid,
        ].map(String)
      );
      const size = Number(before.size);
      const started = now();
      const cached = settled.get(canonical);
      const hash =
        cached?.identity === identity ? cached.hash : await digest(file, size);
      const after = await file.stat({ bigint: true }),
        named = await lstat(canonical, { bigint: true });
      if (
        !(
          before.dev === after.dev &&
          before.ino === after.ino &&
          before.dev === named.dev &&
          before.ino === named.ino
        ) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode ||
        before.uid !== after.uid ||
        (await realpath(path)) !== canonical
      ) {
        settled.delete(canonical);
        return refuse();
      }
      const newest = Math.max(
        Number(before.mtimeNs / 1_000_000n),
        Number(before.ctimeNs / 1_000_000n)
      );
      if (newest < started - RACY_MS) {
        settled.set(canonical, { identity, hash });
      } else {
        settled.delete(canonical);
      }
      return {
        path: canonical,
        dev: before.dev.toString(),
        ino: before.ino.toString(),
        uid: Number(before.uid),
        mode: Number(before.mode),
        size,
        hash,
      };
    } finally {
      await file.close();
    }
  };
}

/** The command's single reader; a CLI process runs exactly one native command. */
export const readNativeComposeStorageCommandExecutable =
  createNativeComposeStorageCommandExecutableReader();
