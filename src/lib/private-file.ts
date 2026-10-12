import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

/** Options shared by the no-follow read and atomic replace of a private file. */
export type ReplaceablePrivateFileOptions = {
  readonly path: string;
  /**
   * Directories (normally the file's parent inside the project) that must be
   * real directories rather than symlinks, with a stable identity across the
   * operation. Ancestors outside this list are not inspected.
   */
  readonly directories: readonly string[];
  /** Builds the caller's fixed, value-free refusal. */
  readonly refusal: () => Error;
};

/** Current contents and permission bits of a replaceable private file. */
export type ReplaceablePrivateFile = {
  readonly text: string;
  readonly mode: number;
};

type DirectoryIdentity = { readonly path: string; readonly stats: Stats };

async function captureRealDirectories(
  opts: ReplaceablePrivateFileOptions
): Promise<readonly DirectoryIdentity[]> {
  return await Promise.all(
    opts.directories.map(async (path) => {
      const stats = await lstat(path).catch(() => null);
      if (!stats?.isDirectory()) {
        throw opts.refusal();
      }
      return { path, stats };
    })
  );
}

async function recheckRealDirectories(opts: {
  readonly directories: readonly DirectoryIdentity[];
  readonly refusal: () => Error;
}): Promise<void> {
  for (const { path, stats } of opts.directories) {
    const current = await lstat(path).catch(() => null);
    if (
      !current?.isDirectory() ||
      current.dev !== stats.dev ||
      current.ino !== stats.ino
    ) {
      throw opts.refusal();
    }
  }
}

/** Null when absent; refuses a symlink (dangling or not) or non-regular entry. */
async function observeReplaceableTarget(opts: {
  readonly path: string;
  readonly refusal: () => Error;
}): Promise<Stats | null> {
  const observed = await lstat(opts.path).catch((error: unknown) => {
    if (isMissingEntryError(error)) {
      return null;
    }
    throw error;
  });
  if (observed && !observed.isFile()) {
    throw opts.refusal();
  }
  return observed;
}

/**
 * Reads a private file that is later replaced with
 * {@link replacePrivateFileAtomic}. Returns null when the entry is absent. A
 * symlink at the path, a non-regular entry, a symlinked or replaced directory
 * from `directories`, or a file that changes identity during the read throws
 * `refusal()`; other filesystem errors (for example EACCES) propagate, so an
 * unreadable file is never mistaken for an empty one and overwritten.
 */
export async function readReplaceablePrivateFile(
  opts: ReplaceablePrivateFileOptions
): Promise<ReplaceablePrivateFile | null> {
  const directories = await captureRealDirectories(opts);
  const observed = await observeReplaceableTarget(opts);
  if (!observed) {
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    return null;
  }
  let file: FileHandle;
  try {
    file = await open(
      opts.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ELOOP") {
      throw opts.refusal();
    }
    throw error;
  }
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== observed.dev ||
      opened.ino !== observed.ino
    ) {
      throw opts.refusal();
    }
    const text = await file.readFile({ encoding: "utf8" });
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    return { text, mode: opened.mode & 0o7777 };
  } finally {
    await file.close();
  }
}

/**
 * Replaces `path` with `text` atomically and durably, leaving mode 0600.
 *
 * A uniquely named sibling is created with O_CREAT|O_EXCL|O_NOFOLLOW and mode
 * 0600, fchmod 0600, written and fsynced, then renamed over `path`; readers see
 * either the previous or the complete new contents, never a partial file. A
 * symlink (dangling or not) or non-regular entry at `path`, or a symlinked or
 * replaced directory from `directories`, throws `refusal()` before any write
 * reaches the target. rename(2) never follows a final-component symlink, so
 * even a link planted after the check is replaced rather than written through.
 * The staging file is removed on every failure path.
 */
export async function replacePrivateFileAtomic(
  opts: ReplaceablePrivateFileOptions & { readonly text: string }
): Promise<void> {
  const directories = await captureRealDirectories(opts);
  await observeReplaceableTarget(opts);
  const staging = join(
    dirname(opts.path),
    `.${basename(opts.path)}.${randomUUID()}.tmp`
  );
  const file = await open(
    staging,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600
  );
  let committed = false;
  try {
    // The umask can only remove bits; restore owner read/write explicitly.
    await file.chmod(0o600);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    await observeReplaceableTarget(opts);
    await rename(staging, opts.path);
    committed = true;
  } finally {
    await file.close();
    if (!committed) {
      await unlink(staging).catch(() => undefined);
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
