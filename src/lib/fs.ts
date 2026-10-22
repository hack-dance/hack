import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ClosedCliError } from "./cli-result.ts";

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    const file = Bun.file(absolutePath);
    if (typeof file.stat === "function") {
      await file.stat();
      return true;
    }
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(absoluteDir: string): Promise<void> {
  await mkdir(absoluteDir, { recursive: true });
}

export async function readTextFile(
  absolutePath: string
): Promise<string | null> {
  try {
    return await Bun.file(absolutePath).text();
  } catch {
    return null;
  }
}

/**
 * Result of reading an optional file that distinguishes a path that does not
 * exist from one that exists but cannot be read.
 */
export type OptionalTextFile =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "text"; readonly text: string };

/**
 * Read an optional text file without collapsing "present but unreadable" into
 * "absent".
 *
 * Existence is decided with `lstat` before reading, so a path is `absent` only
 * when it (or a parent component) does not exist. Any other lstat failure
 * (for example a parent directory without search permission), a dangling
 * symlink, or a read failure (for example mode 000) is `unreadable`. Callers
 * that check Hack-managed files must treat `unreadable` as drift rather than
 * as an optional integration that was never installed.
 */
export async function readOptionalTextFile(
  absolutePath: string
): Promise<OptionalTextFile> {
  try {
    await lstat(absolutePath);
  } catch (error: unknown) {
    return isMissingPathError(error)
      ? { kind: "absent" }
      : { kind: "unreadable" };
  }
  const text = await readTextFile(absolutePath);
  return text === null ? { kind: "unreadable" } : { kind: "text", text };
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function writeTextFile(
  absolutePath: string,
  content: string
): Promise<void> {
  await Bun.write(absolutePath, content);
}

export async function writeTextFileIfChanged(
  absolutePath: string,
  content: string
): Promise<{ readonly changed: boolean }> {
  const existing = await readTextFile(absolutePath);
  if (existing === content) {
    return { changed: false };
  }
  await writeTextFile(absolutePath, content);
  return { changed: true };
}

/**
 * A compare-and-swap write found the file changed by another writer. Closed:
 * the CLI prints its message only, never a stack.
 */
export class AtomicWriteConflictError extends ClosedCliError {
  constructor() {
    super("The file changed while it was being replaced; nothing was written.");
    this.name = "AtomicWriteConflictError";
  }
}

/**
 * Replaces `absolutePath` with `content` only when the text differs, publishing
 * the new contents atomically.
 *
 * Commit point: a uniquely named sibling is created exclusively (no symlink
 * follow), written and fsynced, then renamed over the target. A process that
 * dies before the rename leaves the previous complete file in place and at most
 * an orphaned `.<name>.<uuid>.tmp` sibling that no reader selects; the staging
 * file is removed on every failure this process observes. Orphans are never
 * swept here, because a concurrent writer may still own one; callers that write
 * under `.hack/` rely on its managed `.gitignore` to keep them unstaged.
 * Directory fsync is best effort.
 *
 * Rename needs no write permission on the file it replaces, so the guards an
 * in-place write got from the kernel are checked explicitly, before any staging
 * file exists, and fail with {@link AtomicWriteRefusedError}: an existing target
 * that cannot be read, is not a regular file or is not writable is refused, and
 * so is one whose owner and group the staging file cannot take (for example a
 * root-owned file left by `sudo hack`, or a file the caller owns whose group
 * is not one of the caller's groups). A caller that merged a change into what
 * it read therefore never replaces contents it could not see. These checks are
 * not an atomic fence against a concurrent permission change. Callers that
 * merge into the current contents read them with
 * {@link readAtomicWriteTargetText}, which refuses the same unreadable targets
 * instead of reading them as absent.
 *
 * The group is never silently changed: the staging file would otherwise take
 * the caller's default group (on macOS usually `staff`, which every local
 * account belongs to), so keeping group-readable mode bits under a different
 * group could widen who can read the file.
 *
 * An existing target keeps its permission bits, owner and group, and an
 * existing symlink keeps pointing where it did: the replacement lands at the
 * link's resolved path, as a plain write through the link would. A new file
 * gets the umask default. Unlike an in-place write, a dangling symlink is
 * replaced by a regular file, a hard link to the target is detached (its other
 * names keep the previous contents), and the containing directory must be
 * writable.
 *
 * With `expectedExisting`, the write is a compare-and-swap: the current text
 * (null when absent; an unreadable target is refused, never read as absent)
 * must equal it both before staging and again after the
 * staging file is fsynced, immediately before the rename; otherwise the
 * staging file is removed and {@link AtomicWriteConflictError} is thrown. The
 * second check narrows, but cannot close, the window in which a writer that
 * does not use this check can still be overwritten.
 */
export async function writeTextFileAtomicIfChanged(
  absolutePath: string,
  content: string,
  options: { readonly expectedExisting?: string | null } = {}
): Promise<{ readonly changed: boolean }> {
  const existing = await inspectAtomicWriteTarget(absolutePath);
  const expectsExisting = options.expectedExisting !== undefined;
  if (expectsExisting && targetText(existing) !== options.expectedExisting) {
    throw new AtomicWriteConflictError();
  }
  if (existing.kind === "existing" && existing.text === content) {
    return { changed: false };
  }
  const target =
    existing.kind === "absent" ? absolutePath : await realpath(absolutePath);
  if (existing.kind === "existing") {
    try {
      await access(target, constants.W_OK);
    } catch {
      throw new AtomicWriteRefusedError({
        path: absolutePath,
        reason: "not_writable",
      });
    }
  }
  const staging = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`
  );
  const file = await open(
    staging,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o666
  );
  let committed = false;
  try {
    if (existing.kind === "existing") {
      // chown can clear set-id bits, so the mode is applied after it.
      await preserveOwnership({ file, existing, path: absolutePath });
      await file.chmod(existing.mode);
    }
    await file.writeFile(content, "utf8");
    await file.sync();
    if (
      expectsExisting &&
      targetText(await inspectAtomicWriteTarget(absolutePath)) !==
        options.expectedExisting
    ) {
      throw new AtomicWriteConflictError();
    }
    await rename(staging, target);
    committed = true;
  } finally {
    await file.close();
    if (!committed) {
      await unlink(staging).catch(() => undefined);
    }
  }
  await syncDirectoryBestEffort(dirname(target));
  return { changed: true };
}

/** Why {@link writeTextFileAtomicIfChanged} refused to replace a file. */
export type AtomicWriteRefusal =
  | "unreadable"
  | "not_regular_file"
  | "not_writable"
  | "owner_not_preserved"
  | "group_not_preserved";

const ATOMIC_WRITE_REFUSAL_MESSAGES: Readonly<
  Record<AtomicWriteRefusal, string>
> = {
  unreadable: "it exists but cannot be read, so its contents cannot be kept",
  not_regular_file: "it is not a regular file",
  not_writable: "it is not writable",
  owner_not_preserved: "its owner and group cannot be preserved",
  group_not_preserved:
    "its group cannot be preserved because you are not a member of that group",
};

/**
 * Closed refusal from {@link writeTextFileAtomicIfChanged}. The message names
 * the path and a fixed reason only; it never carries file contents or a cause,
 * and the CLI prints it as one line, never with a stack.
 */
export class AtomicWriteRefusedError extends ClosedCliError {
  readonly path: string;
  readonly reason: AtomicWriteRefusal;

  constructor(opts: {
    readonly path: string;
    readonly reason: AtomicWriteRefusal;
  }) {
    super(
      `Refusing to replace ${opts.path}: ${ATOMIC_WRITE_REFUSAL_MESSAGES[opts.reason]}.`
    );
    this.name = "AtomicWriteRefusedError";
    this.path = opts.path;
    this.reason = opts.reason;
  }
}

type AtomicWriteTarget =
  | { readonly kind: "absent" }
  | {
      readonly kind: "existing";
      readonly text: string;
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
    };

/**
 * Classifies the current target without collapsing "exists but unreadable"
 * into "absent". Only a missing path, or a symlink whose target is missing, is
 * `absent`; any other lstat, stat or read failure is a refusal.
 */
async function inspectAtomicWriteTarget(
  absolutePath: string
): Promise<AtomicWriteTarget> {
  const refuse = (reason: AtomicWriteRefusal) =>
    new AtomicWriteRefusedError({ path: absolutePath, reason });
  try {
    await lstat(absolutePath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return { kind: "absent" };
    }
    throw refuse("unreadable");
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolutePath);
  } catch (error: unknown) {
    // lstat found an entry, so a missing stat target is a dangling symlink.
    if (isMissingPathError(error)) {
      return { kind: "absent" };
    }
    throw refuse("unreadable");
  }
  if (!info.isFile()) {
    throw refuse("not_regular_file");
  }
  const text = await readTextFile(absolutePath);
  if (text === null) {
    throw refuse("unreadable");
  }
  return {
    kind: "existing",
    text,
    mode: Number(info.mode) & 0o7777,
    uid: Number(info.uid),
    gid: Number(info.gid),
  };
}

/**
 * Reads the current text of a file that {@link writeTextFileAtomicIfChanged}
 * may replace: null when it is absent (a missing path or a dangling symlink),
 * and an {@link AtomicWriteRefusedError} when it exists but cannot be read or
 * is not a regular file. Use it instead of `readTextFile`, which reads an
 * unreadable file as absent, whenever the result decides what to write.
 */
export async function readAtomicWriteTargetText(
  absolutePath: string
): Promise<string | null> {
  return targetText(await inspectAtomicWriteTarget(absolutePath));
}

/** The compare-and-swap view of a target: its text, or null when absent. */
function targetText(target: AtomicWriteTarget): string | null {
  return target.kind === "existing" ? target.text : null;
}

/** Gives the staging file the target's owner and group, or refuses. */
async function preserveOwnership(opts: {
  readonly file: FileHandle;
  readonly existing: { readonly uid: number; readonly gid: number };
  readonly path: string;
}): Promise<void> {
  const staged = await opts.file.stat();
  if (staged.uid === opts.existing.uid && staged.gid === opts.existing.gid) {
    return;
  }
  try {
    await opts.file.chown(opts.existing.uid, opts.existing.gid);
  } catch {
    // Only the group differs: the caller owns the file but is not in its group.
    throw new AtomicWriteRefusedError({
      path: opts.path,
      reason:
        staged.uid === opts.existing.uid
          ? "group_not_preserved"
          : "owner_not_preserved",
    });
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some filesystems refuse directory fsync; the file itself is synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Ensures a marker-delimited managed block exists in a gitignore-style file.
 *
 * Merge scheme (simple + robust):
 * - File missing: write just the managed block.
 * - Both markers present: replace the lines between them with the canonical
 *   entries; everything before/after the block (user additions) is preserved.
 * - Begin marker present but end marker missing (corrupted block): replace
 *   from the begin marker to end-of-file with a fresh block.
 * - No markers: preserve the existing content and append the managed block.
 *
 * Idempotent: rewrites only when the resulting content differs.
 * @returns Whether the file was modified
 */
export async function ensureManagedGitignoreBlock(opts: {
  readonly gitignorePath: string;
  readonly beginMarker: string;
  readonly endMarker: string;
  readonly entries: readonly string[];
}): Promise<{ readonly changed: boolean }> {
  const block = [opts.beginMarker, ...opts.entries, opts.endMarker].join("\n");
  const existing = await readTextFile(opts.gitignorePath);
  if (existing === null) {
    return await writeTextFileIfChanged(opts.gitignorePath, `${block}\n`);
  }

  const lines = existing.split("\n");
  const beginIndex = lines.findIndex(
    (line) => line.trim() === opts.beginMarker
  );
  if (beginIndex !== -1) {
    const endOffset = lines
      .slice(beginIndex + 1)
      .findIndex((line) => line.trim() === opts.endMarker);
    const tail =
      endOffset === -1 ? [] : lines.slice(beginIndex + 1 + endOffset + 1);
    const next = [...lines.slice(0, beginIndex), block, ...tail].join("\n");
    const withNewline = next.endsWith("\n") ? next : `${next}\n`;
    return await writeTextFileIfChanged(opts.gitignorePath, withNewline);
  }

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  const separator = existing.trim().length > 0 ? "\n" : "";
  return await writeTextFileIfChanged(
    opts.gitignorePath,
    `${base}${separator}${block}\n`
  );
}

/**
 * Ensures an entry exists in .gitignore. Creates the file if it doesn't exist.
 * @returns Whether the file was modified
 */
export async function ensureGitignoreEntry(opts: {
  readonly gitignorePath: string;
  readonly entry: string;
  readonly comment?: string;
}): Promise<{ readonly changed: boolean }> {
  const existing = await readTextFile(opts.gitignorePath);
  const entryLine = opts.entry.trim();

  if (existing !== null) {
    const lines = existing.split("\n");
    const hasEntry = lines.some((line) => line.trim() === entryLine);
    if (hasEntry) {
      return { changed: false };
    }

    const newContent = existing.endsWith("\n") ? existing : `${existing}\n`;
    const addition = opts.comment
      ? `\n${opts.comment}\n${entryLine}\n`
      : `\n${entryLine}\n`;
    await writeTextFile(opts.gitignorePath, newContent + addition);
    return { changed: true };
  }

  const content = opts.comment
    ? `${opts.comment}\n${entryLine}\n`
    : `${entryLine}\n`;
  await writeTextFile(opts.gitignorePath, content);
  return { changed: true };
}
