import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";

/** Executables larger than this are refused, never hashed. */
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
/**
 * Two reused read buffers: the next positional read runs on the I/O thread
 * while the current one is hashed, so the whole operation runs at about the
 * hash's own speed (`scripts/bench-sha256.ts`).
 */
const READ_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * A file changed this recently before its read began may have been changed
 * again within the same filesystem timestamp tick without changing its stat.
 * Such a digest is returned but never cached. Two seconds covers the coarsest
 * timestamps a supported filesystem keeps.
 */
const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * SHA-256 of an executable, with the existing checks: a regular file, not
 * group- or world-writable, executable, at most 256 MiB, at a canonical path
 * (no symlink anywhere), and the same stat before and after the read
 * (a file that changes during the read is refused).
 *
 * Each process caches a digest per path, keyed on the file's identity
 * (device, inode, size, modification and change times in nanoseconds).
 * A later call still opens the file and runs every check on a fresh stat;
 * it skips only the read when that stat equals the key. A file whose change
 * time falls within {@link RACY_WINDOW_NS} of the read's start is not cached:
 * an in-place same-size write in the same timestamp tick would leave its stat
 * unchanged. `tests/models/tla/executable-digest-cache` models this rule.
 *
 * `fresh` always reads the file; use it where a process verifies what it is
 * about to execute.
 */
export interface NativeExecutableDigests {
  sha256(
    path: string,
    opts: { readonly refused: () => Error; readonly fresh?: boolean }
  ): Promise<string>;
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function pipelinedSha256(
  file: FileHandle,
  size: bigint
): Promise<{ readonly digest: string; readonly bytes: bigint }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let current = new Uint8Array(READ_BUFFER_BYTES);
  let spare = new Uint8Array(READ_BUFFER_BYTES);
  let position = 0;
  // One read past the stat size proves the file did not grow.
  const limit = Number(size) + 1;
  let pending = file.read(current, 0, READ_BUFFER_BYTES, 0);
  for (;;) {
    const { bytesRead } = await pending;
    if (bytesRead === 0 || position >= limit) {
      break;
    }
    position += bytesRead;
    const filled = current;
    current = spare;
    spare = filled;
    pending = file.read(current, 0, READ_BUFFER_BYTES, position);
    hasher.update(filled.subarray(0, bytesRead));
  }
  return { digest: hasher.digest("hex"), bytes: BigInt(position) };
}

/** A digest cache; tests pass their own clock. */
export function createNativeExecutableDigests(
  opts: {
    /** Wall-clock time in nanoseconds; the filesystem stamps from the same clock. */
    readonly nowNs?: () => bigint;
    /** Test seam: runs after the read, before the after-stat. */
    readonly afterRead?: (path: string) => Promise<void>;
  } = {}
): NativeExecutableDigests & { readonly reads: () => number } {
  const nowNs = opts.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
  const cache = new Map<string, { key: string; digest: string }>();
  let reads = 0;
  return {
    reads: () => reads,
    async sha256(path, { refused, fresh }) {
      const startedNs = nowNs();
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const stat = await file.stat({ bigint: true });
        if (
          !stat.isFile() ||
          (stat.mode & 0o022n) !== 0n ||
          (stat.mode & 0o111n) === 0n ||
          stat.size > BigInt(MAX_EXECUTABLE_BYTES) ||
          (await realpath(path)) !== path
        ) {
          throw refused();
        }
        const key = identity(stat);
        const cached = cache.get(path);
        if (!fresh && cached?.key === key) {
          return cached.digest;
        }
        reads += 1;
        const { digest, bytes } = await pipelinedSha256(file, stat.size);
        await opts.afterRead?.(path);
        const after = await file.stat({ bigint: true });
        if (identity(after) !== key || bytes !== stat.size) {
          cache.delete(path);
          throw refused();
        }
        if (stat.ctimeNs < startedNs - RACY_WINDOW_NS) {
          cache.set(path, { key, digest });
        } else {
          cache.delete(path);
        }
        return digest;
      } finally {
        await file.close();
      }
    },
  };
}

/** The process-wide cache every native executable check shares. */
export const nativeExecutableDigests = createNativeExecutableDigests();
