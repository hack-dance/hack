import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { publishFileExclusive } from "./exclusive-publish.ts";
import { closedFileWriteError } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { preparePrivateStaging } from "./private-staging.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

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
   * Where a replace or publish stages the complete contents. `"ignored"`
   * (the default) uses the private, self-ignoring staging directory next to
   * the target (see `private-staging.ts`), so a copy left by a crash is
   * never visible to git; `"sibling"` uses a `.<name>.<uuid>.tmp` sibling,
   * for files outside any checkout whose directory must hold nothing else.
   * A directory option keeps ignored staging under an existing private recovery
   * directory instead. It must share the target filesystem for atomic rename.
   */
  readonly staging?: "ignored" | "sibling" | { readonly directory: string };
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

/** A staging path for `opts.path` and the check to run before publishing it. */
async function stagingFor(opts: ReplaceablePrivateFileOptions): Promise<{
  readonly path: string;
  readonly recheck: () => Promise<void>;
}> {
  if (opts.staging === "sibling") {
    return {
      path: join(
        dirname(opts.path),
        `.${basename(opts.path)}.${randomUUID()}.tmp`
      ),
      recheck: async () => undefined,
    };
  }
  try {
    return await preparePrivateStaging({
      target:
        typeof opts.staging === "object"
          ? join(opts.staging.directory, basename(opts.path))
          : opts.path,
      refusal: opts.refusal,
    });
  } catch (error: unknown) {
    throw closedFileWriteError({ error, path: opts.path, operation: "write" });
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
    if (read !== "replaced") {
      // Bind the read to the pinned directories (HACK-2165): first the
      // directories are checked again, then the path must still name the
      // file that was opened. A directory swapped to read another file and
      // restored before the first check leaves the path naming a different
      // file; one restored after it fails the directory check.
      await recheckRealDirectories({ directories, refusal: opts.refusal });
      if (
        read === null ||
        (await stillNamesOpened({ path: opts.path, read }))
      ) {
        return read === null ? null : { text: read.text, mode: read.mode };
      }
    }
    if (attempt < REPLACEABLE_READ_ATTEMPTS) {
      continue;
    }
    throw opts.refusal();
  }
}

/** Whether `path` still names (no-follow) the regular file that was read. */
async function stillNamesOpened(opts: {
  readonly path: string;
  readonly read: OpenedPrivateFile;
}): Promise<boolean> {
  const current = await lstat(opts.path).catch(() => null);
  return (
    current?.isFile() === true &&
    current.dev === opts.read.dev &&
    current.ino === opts.read.ino
  );
}

/** A read's contents with the identity of the file actually opened. */
type OpenedPrivateFile = ReplaceablePrivateFile & {
  readonly dev: number;
  readonly ino: number;
};

/**
 * One no-follow observe-open-read of `opts.path`: null when absent,
 * `"replaced"` when the opened regular file is not the one `lstat` observed.
 */
async function readReplaceableTargetOnce(
  opts: ReplaceablePrivateFileOptions & { readonly maxBytes?: number }
): Promise<OpenedPrivateFile | null | "replaced"> {
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
    return {
      text,
      mode: opened.mode & 0o7777,
      dev: opened.dev,
      ino: opened.ino,
    };
  } finally {
    await file.close();
  }
}

/**
 * Replaces `path` with `text` atomically and durably, leaving mode 0600 (or
 * `mode`, for a non-secret file such as a committed ignore file).
 *
 * A uniquely named staging file (see `staging`) is created with
 * O_CREAT|O_EXCL|O_NOFOLLOW and mode 0600, fchmod 0600, written and fsynced,
 * then renamed over `path`; readers see
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
  const prepared = await stagingFor(opts);
  const staging = prepared.path;
  const file = await openForPrivateWrite({ path: opts.path, open: staging });
  let committed = false;
  try {
    // The umask can only remove bits; set the requested mode explicitly.
    await file.chmod(mode);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    await prepared.recheck();
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
 * The complete contents are staged in a private (0600, fsynced) file (see
 * `staging`) and published with link(2), which fails with EEXIST instead of replacing an
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
  const prepared = await stagingFor(opts);
  const staging = prepared.path;
  const file = await openForPrivateWrite({ path: opts.path, open: staging });
  let published = false;
  try {
    // The umask can only remove bits; restore owner read/write explicitly.
    await file.chmod(0o600);
    await file.writeFile(opts.text, "utf8");
    await file.sync();
    await recheckRealDirectories({ directories, refusal: opts.refusal });
    await prepared.recheck();
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

/**
 * A private path was refused: a symlink, a non-regular file or directory,
 * another owner, or more than one hard link. The message names the path
 * only; contents are never read.
 */
export class PrivatePathRefusedError extends ClosedCliError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Refusing ${reason} at ${path}; remove it and retry.`);
    this.name = "PrivatePathRefusedError";
    this.path = path;
  }
}

/**
 * Create (parents included) or adopt a private directory: mode 0700, owned
 * by this user, not a symlink. An existing directory with group or other
 * access is tightened to 0700 in place.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(isRecord(error) && error.code === "EEXIST")) {
      throw error;
    }
  });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new PrivatePathRefusedError(path, "a non-directory entry");
  }
  if (info.uid !== process.getuid?.()) {
    throw new PrivatePathRefusedError(
      path,
      "a directory owned by another user"
    );
  }
  if ((info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
}

/**
 * Open a private file for appending without following a symlink at the
 * final path: created mode 0600, refused unless it is a regular file owned
 * by this user with one link. An older file with group or other access is
 * replaced by a private copy (a new inode) before anything is written, so a
 * reader that already had it open sees no new output. `O_NONBLOCK` makes a
 * planted FIFO fail instead of blocking.
 */
export async function openPrivateAppend(path: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < MIGRATION_ATTEMPTS; attempt += 1) {
    const handle = await openVerifiedAppend(path);
    const info = await handle.stat();
    if ((info.mode & 0o077) === 0) {
      return handle;
    }
    await handle.close();
    // Group or other could read it, and chmod does not revoke a descriptor a
    // reader already holds: move it aside and start a new private file, so
    // that reader sees nothing written from now on. One migration at a time;
    // the returned descriptor is always rechecked above.
    await withProjectsRegistryLock({
      lockPath: `${path}.migrate.lock`,
      label: "private log migration",
      run: async () => {
        await moveAsidePublicFile({ path });
      },
    });
  }
  throw new PrivatePathRefusedError(
    path,
    "a file that stays readable by others"
  );
}

/** Broad-mode files replaced faster than this are refused, not chased. */
const MIGRATION_ATTEMPTS = 3;

/**
 * Move a broad-mode file out of the way (call it under the migration lock):
 * if `path` names this user's single-link regular file that group or other
 * can read, rename it to `<path>.before-private-<time>` and make that file
 * 0600. Its history is kept there, never copied: nothing can interleave with
 * a half-done copy, and a writer that still holds the old file (a shell
 * started before the upgrade) appends to the kept file. The next open
 * creates a new private file at `path`. Returns the kept file's path, or
 * null when there is nothing to move (already private, or gone).
 */
export async function moveAsidePublicFile(opts: {
  readonly path: string;
}): Promise<string | null> {
  const current = await lstat(opts.path).catch(() => null);
  if (
    !current?.isFile() ||
    current.uid !== process.getuid?.() ||
    current.nlink !== 1 ||
    (current.mode & 0o077) === 0
  ) {
    return null;
  }
  const kept = `${opts.path}.before-private-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  await rename(opts.path, kept);
  // Same inode under its kept name: make it private too (no-follow).
  const handle = await open(
    kept,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await handle.stat();
    if (info.dev === current.dev && info.ino === current.ino) {
      await handle.chmod(0o600);
    }
  } finally {
    await handle.close();
  }
  return kept;
}

/** Open for appending, refusing anything but this user's single-link regular file. */
async function openVerifiedAppend(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600
  ).catch((error: unknown) => {
    if (isRecord(error) && (error.code === "ELOOP" || error.code === "ENXIO")) {
      throw new PrivatePathRefusedError(path, "a symlink or special file");
    }
    throw error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new PrivatePathRefusedError(path, "a non-regular file");
    }
    if (info.uid !== process.getuid?.()) {
      throw new PrivatePathRefusedError(path, "a file owned by another user");
    }
    if (info.nlink !== 1) {
      throw new PrivatePathRefusedError(path, "a file with other hard links");
    }
    return handle;
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
}

/** Append to a private file (see {@link openPrivateAppend}). */
export async function appendPrivateFile(opts: {
  readonly path: string;
  readonly data: string | Uint8Array;
}): Promise<void> {
  const handle = await openPrivateAppend(opts.path);
  try {
    await handle.appendFile(opts.data);
  } finally {
    await handle.close();
  }
}
