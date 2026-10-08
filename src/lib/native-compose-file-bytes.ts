import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import {
  NativeComposeGenerationError,
  sameFile,
} from "./native-compose-private-state.ts";

export const NATIVE_COMPOSE_FILE_BYTES_LIMIT = 1024 * 1024;
export type NativeComposeFileAnchor = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly digest: string;
};
export type HeldNativeComposeFile = {
  readonly path: string;
  readonly file: FileHandle;
  readonly info: Stats;
  readonly bytes: Buffer;
  readonly anchor: NativeComposeFileAnchor;
  readonly assertFresh: () => Promise<void>;
  readonly close: () => Promise<void>;
};
export function refuseNativeComposeFile(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}
export function nativeComposeFileDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function allowed(
  info: Stats,
  modes: readonly number[],
  limit: number
): boolean {
  return (
    info.isFile() &&
    info.uid === process.getuid?.() &&
    info.nlink === 1 &&
    info.size >= 0 &&
    info.size <= limit &&
    (modes.length === 0
      ? (info.mode & 0o022) === 0
      : modes.includes(info.mode & 0o777))
  );
}
function unchanged(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
async function readBounded(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(
      bytes,
      offset,
      bytes.length - offset,
      offset
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  if (offset !== size) {
    bytes.fill(0);
    return refuseNativeComposeFile();
  }
  return bytes.subarray(0, size);
}
/** Empty/binary member reads are distinct from the nonempty UTF-8 receipt reader. */
export async function holdNativeComposeFile(opts: {
  readonly path: string;
  readonly modes: readonly number[];
  readonly limit: number;
}): Promise<HeldNativeComposeFile> {
  const path = opts.path;
  const modes = [...opts.modes];
  const limit = opts.limit;
  if (
    !(
      Number.isSafeInteger(limit) &&
      limit >= 0 &&
      limit <= NATIVE_COMPOSE_FILE_BYTES_LIMIT
    )
  ) {
    return refuseNativeComposeFile();
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => refuseNativeComposeFile());
  let bytes: Buffer | undefined;
  let active = true;
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (!(allowed(info, modes, limit) && unchanged(info, named))) {
      return refuseNativeComposeFile();
    }
    bytes = await readBounded(file, info.size);
    const digest = nativeComposeFileDigest(bytes);
    const assertFresh = async () => {
      if (!active) {
        return refuseNativeComposeFile();
      }
      const current = await file.stat();
      const currentNamed = await lstat(path).catch(() =>
        refuseNativeComposeFile()
      );
      if (
        !(
          allowed(current, modes, limit) &&
          unchanged(info, current) &&
          unchanged(info, currentNamed)
        )
      ) {
        return refuseNativeComposeFile();
      }
      const comparison = await readBounded(file, info.size);
      try {
        if (
          nativeComposeFileDigest(comparison) !== digest ||
          !unchanged(info, await file.stat()) ||
          !unchanged(info, await lstat(path))
        ) {
          return refuseNativeComposeFile();
        }
      } finally {
        comparison.fill(0);
      }
    };
    await assertFresh();
    return {
      path,
      file,
      info,
      bytes,
      anchor: Object.freeze({
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mode: info.mode & 0o777,
        digest,
      }),
      assertFresh,
      async close() {
        if (active) {
          active = false;
          bytes?.fill(0);
          await file.close();
        }
      },
    };
  } catch (error) {
    bytes?.fill(0);
    await file.close();
    throw error;
  }
}
/** Exclusive creation freezes exact bytes and modes; it never creates a missing bind source later. */
export async function writeNativeComposeFile(opts: {
  readonly path: string;
  readonly bytes: Uint8Array;
}): Promise<NativeComposeFileAnchor> {
  const bytes = Buffer.from(opts.bytes);
  if (bytes.length > NATIVE_COMPOSE_FILE_BYTES_LIMIT) {
    bytes.fill(0);
    return refuseNativeComposeFile();
  }
  const file = await open(
    opts.path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o444
  );
  try {
    await file.writeFile(bytes);
    await file.chmod(0o444);
    await file.sync();
    const info = await file.stat();
    if (
      !(
        allowed(info, [0o444], bytes.length) &&
        sameFile(info, await lstat(opts.path))
      )
    ) {
      return refuseNativeComposeFile();
    }
    return Object.freeze({
      dev: info.dev,
      ino: info.ino,
      size: bytes.length,
      mode: 0o444,
      digest: nativeComposeFileDigest(bytes),
    });
  } finally {
    bytes.fill(0);
    await file.close();
  }
}
