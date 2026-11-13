import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { ClosedCliError } from "./cli-result.ts";
import type { EnvMigrationFileState } from "./env-migration-snapshot.ts";
import { isRecord } from "./guards.ts";

const FILE_LIMIT = 32 * 1024 * 1024;

export function migrationRefusal(): ClosedCliError {
  return new ClosedCliError(
    "Env migration refused: an input, journal, payload or destination is unsafe, changed or unreadable. Keep the legacy files and snapshot; values omitted."
  );
}

export function migrationDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Bounded descriptor read: no final symlink, FIFO, device, or changing file is accepted. */
export async function readMigrationFile(path: string): Promise<{
  readonly state: EnvMigrationFileState;
  readonly text: string | null;
}> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { state: { path, sha256: null, mode: null, size: 0 }, text: null };
    }
    throw migrationRefusal();
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > FILE_LIMIT) {
      throw migrationRefusal();
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      named.isSymbolicLink() ||
      before.size !== bytes.length ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.mtimeMs !== named.mtimeMs ||
      after.ctimeMs !== named.ctimeMs
    ) {
      throw migrationRefusal();
    }
    return {
      state: {
        path,
        sha256: migrationDigest(bytes),
        mode: before.mode & 0o777,
        size: bytes.length,
      },
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    throw migrationRefusal();
  } finally {
    await handle.close();
  }
}

export function sameMigrationFile(
  left: EnvMigrationFileState,
  right: EnvMigrationFileState
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.mode === right.mode &&
    left.size === right.size
  );
}
