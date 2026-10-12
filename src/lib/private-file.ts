import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./guards.ts";

/**
 * Bounded, no-follow reads and exclusive creates for private key material.
 *
 * Ownership: callers own the path choice and the refusal message. These helpers
 * never follow a symlink at the final path component, never replace an existing
 * entry, and never include file contents in errors.
 */

export type BoundedPrivateFileReadOptions = {
  readonly path: string;
  /**
   * Directories whose identity must stay stable across the read. With
   * `canonical`, each one and the file must also be spelled by its realpath.
   */
  readonly directories: readonly string[];
  /** Require the canonical (realpath) spelling for `path` and `directories`. */
  readonly canonical: boolean;
  /** Largest accepted file size in bytes. */
  readonly maxBytes: number;
  /** Builds the caller's fixed, value-free refusal. */
  readonly refusal: () => Error;
  /** Runs between steps, e.g. to observe cancellation. */
  readonly checkpoint?: () => void;
};

function sameFileVersion(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function isMissingEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Reads a small private text file without following a final-component symlink.
 * Returns null when the entry is absent or contains only whitespace; otherwise
 * the trimmed UTF-8 text. A symlink (dangling or not), a non-regular file, an
 * unreadable or oversized file, invalid UTF-8, or a file that changes during
 * the read throws `refusal()`; other filesystem errors propagate unchanged.
 */
export async function readBoundedPrivateFile(
  opts: BoundedPrivateFileReadOptions
): Promise<string | null> {
  const checkpoint = opts.checkpoint ?? (() => undefined);
  checkpoint();
  const directories = await Promise.all(
    opts.directories.map(async (path) => {
      const stats = await lstat(path);
      if (
        !stats.isDirectory() ||
        (opts.canonical && (await realpath(path)) !== path)
      ) {
        throw opts.refusal();
      }
      return { path, stats };
    })
  );
  const recheckDirectories = async () => {
    for (const { path, stats } of directories) {
      const current = await lstat(path);
      if (
        !current.isDirectory() ||
        current.dev !== stats.dev ||
        current.ino !== stats.ino ||
        (opts.canonical && (await realpath(path)) !== path)
      ) {
        throw opts.refusal();
      }
    }
    checkpoint();
  };
  const observed = await lstat(opts.path).catch((error: unknown) => {
    if (isMissingEntryError(error)) {
      return null;
    }
    throw error;
  });
  if (!observed) {
    await recheckDirectories();
    return null;
  }
  if (
    !observed.isFile() ||
    observed.size > opts.maxBytes ||
    (observed.mode & 0o444) === 0 ||
    (opts.canonical && (await realpath(opts.path)) !== opts.path)
  ) {
    throw opts.refusal();
  }
  const file = await open(
    opts.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    checkpoint();
    const before = await file.stat();
    if (!(before.isFile() && sameFileVersion(observed, before))) {
      throw opts.refusal();
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      checkpoint();
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size
      );
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(opts.path);
    if (
      size !== before.size ||
      !current.isFile() ||
      !sameFileVersion(before, after) ||
      !sameFileVersion(before, current) ||
      (opts.canonical && (await realpath(opts.path)) !== opts.path)
    ) {
      throw opts.refusal();
    }
    await recheckDirectories();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size)
      );
    } catch {
      throw opts.refusal();
    }
    return text.trim() || null;
  } finally {
    await file.close();
  }
}

/**
 * Creates `path` with mode 0600 and writes `text`, durably. The open uses
 * O_CREAT|O_EXCL|O_NOFOLLOW, so an existing entry, including a dangling
 * symlink, fails with EEXIST and its target is never created or written.
 * On a failed write the partially written file is removed only while the
 * path still names the file this call created.
 */
export async function createPrivateFileExclusive(opts: {
  readonly path: string;
  readonly text: string;
}): Promise<void> {
  const file = await open(
    opts.path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600
  );
  let created: Stats | null = null;
  let complete = false;
  try {
    created = await file.stat();
    // The umask can only remove bits; restore owner read/write explicitly.
    await file.chmod(0o600);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete && created) {
      const current = await lstat(opts.path).catch(() => null);
      if (
        current?.isFile() &&
        current.dev === created.dev &&
        current.ino === created.ino
      ) {
        await unlink(opts.path).catch(() => undefined);
      }
    }
  }
  await syncDirectory({ path: dirname(opts.path) });
}

/** Best effort: persist the directory entry where the platform allows it. */
async function syncDirectory(opts: { readonly path: string }): Promise<void> {
  let directory: FileHandle | null = null;
  try {
    directory = await open(opts.path, constants.O_RDONLY);
    await directory.sync();
  } catch {
    // Some filesystems refuse directory fsync; the file itself is already synced.
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

/**
 * Decodes standard padded base64 only when the text is its canonical encoding
 * (re-encoding the bytes reproduces the text exactly). Whitespace, URL-safe or
 * invalid characters, missing or extra padding, and non-zero trailing bits are
 * refused. The length is bounded before any decoding allocation.
 */
export function decodeCanonicalBase64(opts: {
  readonly text: string;
  readonly maxBytes: number;
}): Buffer | null {
  if (
    opts.text.length % 4 !== 0 ||
    opts.text.length > Math.ceil(opts.maxBytes / 3) * 4
  ) {
    return null;
  }
  const decoded = Buffer.from(opts.text, "base64");
  if (
    decoded.length > opts.maxBytes ||
    decoded.toString("base64") !== opts.text
  ) {
    return null;
  }
  return decoded;
}
