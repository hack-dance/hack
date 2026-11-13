import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** In-memory deletion authority tied to file identity and contents; never source text. */
export type LegacyEnvCleanupReceipt = {
  readonly path: string;
  readonly identity: string;
  readonly digest: string;
};

/** Missing, linked, changing or unreadable files have no deletion authority. */
export async function legacyEnvCleanupReceipt(
  path: string
): Promise<LegacyEnvCleanupReceipt | null> {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 32n * 1024n * 1024n) {
        return null;
      }
      const bytes = Buffer.alloc(Number(before.size) + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (BigInt(bytesRead) !== before.size) {
        return null;
      }
      const digest = createHash("sha256")
        .update(bytes.subarray(0, bytesRead))
        .digest("hex");
      const after = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      const identity = (entry: typeof before) =>
        [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(
          ":"
        );
      if (
        named.isSymbolicLink() ||
        identity(before) !== identity(after) ||
        identity(after) !== identity(named)
      ) {
        return null;
      }
      return { path, identity: identity(after), digest };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

export async function legacyEnvCleanupReceiptMatches(
  expected: LegacyEnvCleanupReceipt
): Promise<boolean> {
  const current = await legacyEnvCleanupReceipt(expected.path);
  return (
    current?.identity === expected.identity &&
    current.digest === expected.digest
  );
}
