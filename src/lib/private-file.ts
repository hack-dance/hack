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
import { publishFileExclusive } from "./exclusive-publish.ts";
import { closedFileWriteError } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * Bounded, no-follow reads and exclusive creates for private key material.
 *
 * Ownership: callers own the path choice and the refusal message. These helpers
 * never follow a symlink at the final path component, never replace an existing
 * entry, and never include file contents in errors.
 *
 * Failures the user must fix (permission denied, a read-only filesystem, a full
 * disk or quota, a non-directory parent) are reported by the create, replace
 * and replaceable-read helpers as a closed `FileWriteRefusedError` that names
 * the caller's path, never a staging path or the errno text. EEXIST and every
 * other error propagate unchanged.
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
  const file = await openForPrivateWrite({ path: opts.path, open: opts.path });
  let created: Stats | null = null;
  let complete = false;
  try {
    created = await file.stat();
    // The umask can only remove bits; restore owner read/write explicitly.
    await file.chmod(0o600);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    complete = true;
  } catch (error: unknown) {
    throw closedFileWriteError({ error, path: opts.path, operation: "write" });
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
    throw closedFileWriteError({ error, path: opts.path, operation: "read" });
  });
  if (observed && !observed.isFile()) {
    throw opts.refusal();
  }
  return observed;
}

/**
 * How many times {@link readReplaceablePrivateFile} re-observes a path whose
 * regular file was atomically replaced between its `lstat` and its `open`
 * before it refuses closed. One concurrent writer's rename costs one retry;
 * only a path replaced on every attempt exhausts the budget.
 */
export const REPLACEABLE_READ_ATTEMPTS = 8;

/**
 * Reads a private file that is later replaced with
 * {@link replacePrivateFileAtomic}. Returns null when the entry is absent. A
 * symlink at the path, a non-regular entry, a symlinked or replaced directory
 * from `directories`, or a file that keeps changing identity throws
 * `refusal()`; other filesystem errors (for example EACCES) propagate, so an
 * unreadable file is never mistaken for an empty one and overwritten.
 *
 * Concurrency: readers need no lock. When the regular file seen by `lstat`
 * and the regular file opened (no-follow) differ, a writer renamed a complete
 * sibling over the path in between, which is the replacement this module's
 * writer promises readers may observe; the read starts again (at most
 * {@link REPLACEABLE_READ_ATTEMPTS} times) and returns the previous or the new
 * contents, never a false symlink refusal (HACK-1422). A symlink or
 * non-regular entry opened at any attempt is still refused at once.
 */
export async function readReplaceablePrivateFile(
  opts: ReplaceablePrivateFileOptions & {
    /** Largest accepted file size in bytes; a larger file throws `refusal()` before it is read. */
    readonly maxBytes?: number;
  }
): Promise<ReplaceablePrivateFile | null> {
  const directories = await captureRealDirectories(opts);
  for (let attempt = 1; ; attempt += 1) {
    const read = await readReplaceableTargetOnce(opts);
    if (read === "replaced") {
      if (attempt < REPLACEABLE_READ_ATTEMPTS) {
        continue;
      }
      throw opts.refusal();
    }
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    return read;
  }
}

/**
 * One no-follow observe-open-read of `opts.path`: null when absent,
 * `"replaced"` when the opened regular file is not the one `lstat` observed.
 */
async function readReplaceableTargetOnce(
  opts: ReplaceablePrivateFileOptions & { readonly maxBytes?: number }
): Promise<ReplaceablePrivateFile | null | "replaced"> {
  const observed = await observeReplaceableTarget(opts);
  if (!observed) {
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
    throw closedFileWriteError({ error, path: opts.path, operation: "read" });
  }
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      (opts.maxBytes !== undefined && opened.size > opts.maxBytes)
    ) {
      throw opts.refusal();
    }
    if (opened.dev !== observed.dev || opened.ino !== observed.ino) {
      return "replaced";
    }
    const text = await file.readFile({ encoding: "utf8" });
    if (
      opts.maxBytes !== undefined &&
      Buffer.byteLength(text, "utf8") > opts.maxBytes
    ) {
      // The file grew in place after the size check.
      throw opts.refusal();
    }
    return { text, mode: opened.mode & 0o7777 };
  } finally {
    await file.close();
  }
}

/**
 * Replaces `path` with `text` atomically and durably, leaving mode 0600 (or
 * `mode`, for a non-secret file such as a committed ignore file).
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
  opts: ReplaceablePrivateFileOptions & {
    readonly text: string;
    /** Permission bits for the new file; defaults to 0600. */
    readonly mode?: number;
    /**
     * Runs after staging and fsync, immediately before the rename. A throw
     * abandons the replacement and removes the staging file, so a caller can
     * make its last compare-and-swap check here.
     */
    readonly beforeRename?: () => Promise<void>;
  }
): Promise<void> {
  const mode = (opts.mode ?? 0o600) & 0o777;
  const directories = await captureRealDirectories(opts);
  await observeReplaceableTarget(opts);
  const staging = join(
    dirname(opts.path),
    `.${basename(opts.path)}.${randomUUID()}.tmp`
  );
  const file = await openForPrivateWrite({ path: opts.path, open: staging });
  let committed = false;
  try {
    // The umask can only remove bits; set the requested mode explicitly.
    await file.chmod(mode);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    await observeReplaceableTarget(opts);
    await opts.beforeRename?.();
    await rename(staging, opts.path);
    committed = true;
  } catch (error: unknown) {
    throw closedFileWriteError({ error, path: opts.path, operation: "write" });
  } finally {
    await file.close();
    if (!committed) {
      await unlink(staging).catch(() => undefined);
    }
  }
  await syncDirectory({ path: dirname(opts.path) });
}

/**
 * Publishes `text` at `path` only when no entry exists there, and reports
 * whether this call published it.
 *
 * The complete contents are staged in a private (0600, fsynced) sibling and
 * published with link(2), which fails with EEXIST instead of replacing an
 * existing entry. Unlike {@link createPrivateFileExclusive}, readers never see
 * a partial file, so a concurrent loser can adopt the winner's file
 * immediately. An existing regular file returns false untouched; a symlink
 * (dangling or not), a non-regular entry, or a symlinked or replaced directory
 * from `directories` throws `refusal()`. The staging file is always removed.
 *
 * On a filesystem without hard links (ExFAT, FAT) the sibling is renamed over
 * an exclusive, no-follow empty reservation instead (see
 * `publishByExclusivePlaceholder`): an existing entry is still never replaced
 * or followed, and readers see nothing, an empty file or the complete file.
 * A process killed between the two steps leaves an empty file, which is
 * refused, never adopted, until it is removed.
 */
export async function publishPrivateFileExclusive(
  opts: ReplaceablePrivateFileOptions & { readonly text: string }
): Promise<boolean> {
  const directories = await captureRealDirectories(opts);
  if (await observeReplaceableTarget(opts)) {
    return false;
  }
  const staging = join(
    dirname(opts.path),
    `.${basename(opts.path)}.${randomUUID()}.tmp`
  );
  const file = await openForPrivateWrite({ path: opts.path, open: staging });
  let published = false;
  try {
    // The umask can only remove bits; restore owner read/write explicitly.
    await file.chmod(0o600);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    published = await publishFileExclusive({
      source: staging,
      target: opts.path,
    });
    if (!published) {
      // Lost the race: classify what is there now (regular file or refusal).
      await observeReplaceableTarget(opts);
    }
  } catch (error: unknown) {
    throw closedFileWriteError({ error, path: opts.path, operation: "write" });
  } finally {
    await file.close();
    await unlink(staging).catch(() => undefined);
  }
  await syncDirectory({ path: dirname(opts.path) });
  return published;
}

/**
 * Opens `open` (the target itself, or its staging sibling) with
 * O_CREAT|O_EXCL|O_NOFOLLOW|O_WRONLY and mode 0600. A classified failure is a
 * closed refusal naming `path`, never the staging name; EEXIST and every other
 * error propagate unchanged, so an exclusive create still sees an existing
 * entry as EEXIST.
 */
async function openForPrivateWrite(opts: {
  readonly path: string;
  readonly open: string;
}): Promise<FileHandle> {
  try {
    return await open(
      opts.open,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600
    );
  } catch (error: unknown) {
    throw closedFileWriteError({ error, path: opts.path, operation: "write" });
  }
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
