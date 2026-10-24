import { constants, type Stats } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { isRecord } from "./guards.ts";

/**
 * Exclusive publication of a complete file at a path that must not already
 * exist, for filesystems with and without hard links.
 *
 * Ownership: the caller owns `source` (a fully written, fsynced sibling it
 * created exclusively) and decides what an occupied `target` means. These
 * helpers never follow a symlink at `target` and never replace an entry they
 * did not create.
 */

/**
 * `link(2)` failures that mean the filesystem cannot make hard links: ExFAT
 * and FAT report ENOTSUP on macOS and EPERM on Linux. A real permission
 * problem also reports EPERM; the fallback then fails with its own
 * permission error, so nothing is hidden.
 */
const HARD_LINK_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

/** Whether a `link(2)` error means the filesystem has no hard links. */
export function isHardLinkUnsupportedError(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    HARD_LINK_UNSUPPORTED_CODES.has(error.code)
  );
}

/**
 * Publishes `source` at `target` only when no entry exists at `target`, and
 * reports whether this call published it. `source` must be on the same
 * filesystem (a sibling).
 *
 * Primary path: `link(source, target)`, which fails with EEXIST instead of
 * replacing anything; `source` keeps its name. When the filesystem has no
 * hard links ({@link isHardLinkUnsupportedError}), it falls back to
 * {@link publishByExclusivePlaceholder}, after which `source` no longer
 * exists. Callers that remove `source` afterwards must tolerate ENOENT.
 *
 * EEXIST resolves to false; every other error propagates unchanged.
 */
export async function publishFileExclusive(opts: {
  readonly source: string;
  readonly target: string;
}): Promise<boolean> {
  try {
    await link(opts.source, opts.target);
    return true;
  } catch (error: unknown) {
    if (hasCode(error, "EEXIST")) {
      return false;
    }
    if (!isHardLinkUnsupportedError(error)) {
      throw error;
    }
  }
  return await publishByExclusivePlaceholder(opts);
}

/**
 * Publication without hard links: reserve `target` with an empty
 * O_CREAT|O_EXCL|O_NOFOLLOW file (mode 0600), then rename the complete
 * `source` over that reservation.
 *
 * Guarantees kept from the hard-link path:
 * - no overwrite: the exclusive create fails with EEXIST on any existing
 *   entry, including a dangling symlink, and the rename replaces only the
 *   empty regular file this call created. It is checked again (still an
 *   empty regular file with the same identity) immediately before the
 *   rename; if anything else is there the call reports the path as occupied
 *   and leaves it alone.
 * - no follow: neither O_EXCL|O_NOFOLLOW nor rename(2) follows a symlink at
 *   the final component.
 * - readers see either nothing, the empty reservation, or the complete file,
 *   never a partial one.
 *
 * Difference: a process killed between the reservation and the rename
 * leaves an empty file at `target`. Callers already treat an empty file as
 * invalid, never as theirs, so it is refused rather than adopted or
 * reclaimed; it must be removed by hand. A failed rename removes the
 * reservation while it is still the empty file this call created.
 */
export async function publishByExclusivePlaceholder(opts: {
  readonly source: string;
  readonly target: string;
}): Promise<boolean> {
  let reserved: Stats;
  try {
    const placeholder = await open(
      opts.target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600
    );
    try {
      reserved = await placeholder.stat();
    } finally {
      await placeholder.close();
    }
  } catch (error: unknown) {
    if (hasCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
  if (!(await isOwnReservation({ path: opts.target, reserved }))) {
    return false;
  }
  try {
    await rename(opts.source, opts.target);
  } catch (error: unknown) {
    if (await isOwnReservation({ path: opts.target, reserved })) {
      await unlink(opts.target).catch(() => undefined);
    }
    throw error;
  }
  return true;
}

/**
 * Whether `path` still names the empty regular file this call reserved.
 * Size is checked as well as identity: some filesystems without hard links
 * (ExFAT) give every empty file the same inode number.
 */
async function isOwnReservation(opts: {
  readonly path: string;
  readonly reserved: Stats;
}): Promise<boolean> {
  const current = await lstat(opts.path).catch(() => null);
  return (
    current?.isFile() === true &&
    current.size === 0 &&
    current.dev === opts.reserved.dev &&
    current.ino === opts.reserved.ino
  );
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
