import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord } from "./guards.ts";

/**
 * Where private writes stage their complete contents before the rename or
 * link that publishes them (HACK-2165).
 *
 * A staging copy holds the whole secret (an env file, a key), and a process
 * killed between its create and its rename leaves it behind. A sibling named
 * after the target (`.<name>.<uuid>.tmp`) is not matched by the ignore entry
 * for the target itself, so git could stage it. Staging copies therefore go
 * into a private directory next to the target, {@link PRIVATE_STAGING_DIRNAME},
 * that ignores itself: it holds a `.gitignore` of `*`, so git never lists
 * anything in it without any change to the project's own ignore files. It is
 * on the target's filesystem, so the rename stays atomic.
 *
 * Ownership: every entry in that directory is a Hack staging file; leftovers
 * older than {@link STAGING_LEFTOVER_MIN_AGE_MS} are removed by the next
 * staging write in it and by `hack doctor --fix`. Staging siblings written by
 * earlier Hack versions are swept the same way.
 */
export const PRIVATE_STAGING_DIRNAME = ".hack-staging";

/**
 * A staging file younger than this may belong to a write still in progress,
 * so sweeps leave it alone.
 */
export const STAGING_LEFTOVER_MIN_AGE_MS = 10 * 60_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGING_FILE = new RegExp(`^.+\\.${UUID}\\.tmp$`);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the `.<name>.<uuid>.tmp` sibling earlier versions staged `name` in. */
export function legacyStagingSiblingPattern(name: string): RegExp {
  return new RegExp(`^\\.${escapeRegExp(name)}\\.${UUID}\\.tmp$`);
}

const LEGACY_SIBLING = new RegExp(`^\\.(.+)\\.${UUID}\\.tmp$`);

/**
 * The target name a legacy `.<name>.<uuid>.tmp` sibling was staging, or null
 * when `fileName` is not one.
 */
export function legacyStagingTargetName(fileName: string): string | null {
  return LEGACY_SIBLING.exec(fileName)?.[1] ?? null;
}

/** Whether `name` is a staging file inside {@link PRIVATE_STAGING_DIRNAME}. */
export function isStagingFileName(name: string): boolean {
  return STAGING_FILE.test(name);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

/** A directory only the current user can use: real, owned, no group/other bits. */
function isPrivateDirectory(stats: Stats): boolean {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.uid === process.getuid?.() &&
    (stats.mode & 0o077) === 0
  );
}

/** A leftover Hack may remove: a regular file of ours, old enough. */
export function isRemovableLeftover(opts: {
  readonly stats: Stats;
  readonly now: number;
}): boolean {
  return (
    opts.stats.isFile() &&
    opts.stats.uid === process.getuid?.() &&
    opts.now - opts.stats.mtimeMs >= STAGING_LEFTOVER_MIN_AGE_MS
  );
}

export type StagingLeftover = {
  readonly path: string;
  readonly stats: Stats;
};

/**
 * Leftover staging copies for targets in `directory`: every old-enough file
 * in its staging directory, and old-enough legacy siblings of the given
 * target names. Nothing is read or removed.
 */
export async function findStagingLeftovers(opts: {
  readonly directory: string;
  readonly names: readonly string[];
  readonly now: number;
}): Promise<readonly StagingLeftover[]> {
  const found: StagingLeftover[] = [];
  const collect = async (dir: string, accept: (name: string) => boolean) => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries.filter(accept).sort()) {
      const path = join(dir, name);
      const stats = await lstat(path).catch(() => null);
      if (stats && isRemovableLeftover({ stats, now: opts.now })) {
        found.push({ path, stats });
      }
    }
  };
  const patterns = opts.names.map(legacyStagingSiblingPattern);
  await collect(opts.directory, (name) =>
    patterns.some((pattern) => pattern.test(name))
  );
  const staging = join(opts.directory, PRIVATE_STAGING_DIRNAME);
  const stagingStats = await lstat(staging).catch(() => null);
  if (stagingStats && isPrivateDirectory(stagingStats)) {
    await collect(staging, isStagingFileName);
  }
  return found;
}

/**
 * Removes a leftover only while it is still the file that was found (same
 * device and inode), so a replacement is never removed by mistake.
 */
export async function removeStagingLeftover(
  leftover: StagingLeftover
): Promise<boolean> {
  const current = await lstat(leftover.path).catch(() => null);
  if (
    !current?.isFile() ||
    current.dev !== leftover.stats.dev ||
    current.ino !== leftover.stats.ino
  ) {
    return false;
  }
  await unlink(leftover.path).catch((error: unknown) => {
    if (!isMissing(error)) {
      throw error;
    }
  });
  return true;
}

export type PreparedStaging = {
  /** Where to create the staging file (exclusively, no-follow). */
  readonly path: string;
  /** Re-check before publishing; throws `refusal()` when the directory changed. */
  readonly recheck: () => Promise<void>;
};

/**
 * Prepares the staging directory next to `target` and returns a fresh
 * staging path in it. The directory is created private (0700) with its
 * self-ignoring `.gitignore`; an existing entry there that is a link, not a
 * directory, not the user's own or open to group or others is refused with
 * `refusal()`, so a staging copy is never created through it. Old leftovers
 * of this target are swept first.
 */
export async function preparePrivateStaging(opts: {
  readonly target: string;
  readonly refusal: () => Error;
  readonly now?: number;
}): Promise<PreparedStaging> {
  const directory = join(dirname(opts.target), PRIVATE_STAGING_DIRNAME);
  const created = await mkdir(directory, { mode: 0o700 }).then(
    () => true,
    (error: unknown) => {
      if (!isExisting(error)) {
        throw error;
      }
      return false;
    }
  );
  if (created) {
    // The umask can only remove bits: a restrictive one would leave a
    // directory the owner cannot create files in.
    await chmod(directory, 0o700);
  }
  const identity = await lstat(directory).catch(() => null);
  if (!(identity && isPrivateDirectory(identity))) {
    throw opts.refusal();
  }
  await ensureSelfIgnore(directory);
  const leftovers = await findStagingLeftovers({
    directory: dirname(opts.target),
    names: [basename(opts.target)],
    now: opts.now ?? Date.now(),
  });
  for (const leftover of leftovers) {
    await removeStagingLeftover(leftover).catch(() => false);
  }
  return {
    path: join(directory, `${basename(opts.target)}.${randomUUID()}.tmp`),
    recheck: async () => {
      const current = await lstat(directory).catch(() => null);
      if (
        !(current && isPrivateDirectory(current)) ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw opts.refusal();
      }
    },
  };
}

/** `*` ignores every entry, the `.gitignore` itself included. */
async function ensureSelfIgnore(directory: string): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(
      join(directory, ".gitignore"),
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600
    );
    await file.writeFile("*\n", "utf8");
  } catch (error: unknown) {
    if (!isExisting(error)) {
      throw error;
    }
  } finally {
    await file?.close();
  }
}
