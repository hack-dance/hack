import { constants, lstatSync } from "node:fs";
import { chmod, type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { checkReplaceableChain } from "../lib/path-trust.ts";

/**
 * hackd's local API is unauthenticated: whoever can connect to its Unix
 * sockets can list projects and run jobs as the daemon's user. The sockets
 * are created with the inherited umask, so a shared-group umask (`0002`)
 * would make them group-writable. hackd therefore keeps its daemon directory
 * owner-only (`0700`) before it binds anything: another user cannot reach a
 * socket inside it whatever the socket's mode (HACK-2052).
 *
 * The process umask is left alone on purpose: jobs and shells hackd starts
 * inherit it and write project files that must keep the user's normal
 * permissions.
 *
 * The directories above it matter too: whoever can write `~/.hack` can
 * rename `daemon/` and put their own socket in its place. Every directory
 * on the way to it (symlinks followed) must be owned by this user or root
 * and not writable by others; group/other write is removed inside the Hack
 * home (its parent), and anything else refuses.
 *
 * Nothing is changed before the directory is established as Hack's own
 * (HACK-2052): the chain is checked first, then the directory is opened
 * without following a link and must be a directory this user owns; only
 * that open directory is made owner-only. A `daemon` link planted by
 * another account, or one to a directory elsewhere, is refused unchanged.
 *
 * Throws when the directory still grants group or other access afterwards
 * (for example a filesystem that ignores chmod), a parent can be replaced,
 * or the directory is not this user's own, so hackd does not serve its API
 * from a shared place.
 */
export async function secureDaemonDirectory(opts: {
  readonly root: string;
}): Promise<void> {
  const uid = process.getuid?.() ?? -1;
  const chain = checkReplaceableChain({
    path: opts.root,
    uid,
    hackHome: dirname(opts.root),
  });
  if (chain !== null) {
    throw new Error(
      `hackd state directory ${opts.root} is not safe from other users: ${chain}`
    );
  }
  let handle: FileHandle;
  try {
    handle = await open(
      opts.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error: unknown) {
    throw new Error(
      describeUnopenableDirectory({ root: opts.root, uid, error })
    );
  }
  try {
    const info = await handle.stat();
    if (uid >= 0 && info.uid !== uid) {
      throw new Error(
        `hackd state directory ${opts.root} is owned by another user (uid ${info.uid}); remove or rename it and start hackd again`
      );
    }
    if ((info.mode & 0o077) !== 0) {
      try {
        await handle.chmod(0o700);
      } catch {
        // Checked below.
      }
    }
    const mode = (await handle.stat()).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `hackd state directory ${opts.root} is accessible to other users (mode ${mode.toString(8)}) and could not be made owner-only; fix its permissions (chmod 700) and start hackd again`
      );
    }
  } finally {
    await handle.close();
  }
  // Now that nobody else can add entries, what is already there must be
  // this user's own: a directory that was writable by others (and repaired
  // above) may hold a planted `hackd.log` link to another file, which the
  // log writer would append to or truncate (HACK-2142).
  const planted = await findPlantedEntry({ root: opts.root, uid });
  if (planted !== null) {
    throw new Error(
      `hackd state directory ${opts.root} holds ${planted}. Review and remove it, then start hackd again`
    );
  }
}

/**
 * An entry in the daemon directory hackd would not have created: another
 * account's, a symlink, or a regular file with other hard links (a link to
 * a file elsewhere). hackd also writes one level down (`gateway/`), so each
 * subdirectory is made owner-only the same way (opened without following a
 * link, this user's) and its entries get the same checks; Hack creates
 * nothing deeper, so a directory there is refused. Null when every entry is
 * plainly this user's.
 */
async function findPlantedEntry(opts: {
  readonly root: string;
  readonly uid: number;
  /** Subdirectories still to descend into (1 at the daemon directory). */
  readonly depth?: number;
}): Promise<string | null> {
  const depth = opts.depth ?? 1;
  for (const name of await readdir(opts.root)) {
    const path = join(opts.root, name);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch {
      // Removed meanwhile: nothing to open.
      continue;
    }
    const problem =
      plantedProblem({ path, info, uid: opts.uid }) ??
      (info.isDirectory()
        ? await checkSubdirectory({ path, uid: opts.uid, depth })
        : await checkWritableFile({ path, info }));
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

function plantedProblem(opts: {
  readonly path: string;
  readonly info: Awaited<ReturnType<typeof lstat>>;
  readonly uid: number;
}): string | null {
  const { info, path } = opts;
  if (opts.uid >= 0 && info.uid !== opts.uid) {
    return `${path}, owned by another user (uid ${info.uid})`;
  }
  if (info.isSymbolicLink()) {
    return `${path}, a symbolic link`;
  }
  if (info.isFile() && info.nlink > 1) {
    return `${path}, a file with other hard links`;
  }
  return null;
}

/**
 * State files whose contents decide who may use hackd: one others could
 * write may already say what they chose (a write token's hash), so it is
 * refused, not repaired (HACK-2142).
 */
const TRUSTED_CONTENT_FILES = new Set([join("gateway", "tokens.json")]);

/**
 * A regular file group or others could write. hackd's own logs and pid
 * file are created with the process umask (`0664` under `0002`); their
 * contents decide nothing (a pid is proven before any signal), so write
 * access is removed through a handle that does not follow a link. A file
 * in {@link TRUSTED_CONTENT_FILES} is refused instead. Null when fine.
 */
async function checkWritableFile(opts: {
  readonly path: string;
  readonly info: Awaited<ReturnType<typeof lstat>>;
}): Promise<string | null> {
  if (!opts.info.isFile() || (Number(opts.info.mode) & 0o022) === 0) {
    return null;
  }
  const relativePath = join(basename(dirname(opts.path)), basename(opts.path));
  if (TRUSTED_CONTENT_FILES.has(relativePath)) {
    return `${opts.path}, which other users could write (mode ${(Number(opts.info.mode) & 0o777).toString(8)}), so its contents cannot be trusted (gateway tokens must be issued again once it is removed)`;
  }
  let handle: FileHandle;
  try {
    handle = await open(opts.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    return `${opts.path}, a file that could not be opened (${error instanceof Error ? error.message : String(error)})`;
  }
  try {
    const mode = Number((await handle.stat()).mode);
    await handle.chmod(mode & 0o7755).catch(() => undefined);
    if ((Number((await handle.stat()).mode) & 0o022) !== 0) {
      return `${opts.path}, a file other users can write that could not be made owner-writable`;
    }
  } finally {
    await handle.close();
  }
  return null;
}

/** A subdirectory: made owner-only, then its own entries checked. */
async function checkSubdirectory(opts: {
  readonly path: string;
  readonly uid: number;
  readonly depth: number;
}): Promise<string | null> {
  if (opts.depth < 1) {
    return `${opts.path}, a nested directory`;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      opts.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
  } catch (error: unknown) {
    return `${opts.path}, a directory that could not be opened (${error instanceof Error ? error.message : String(error)})`;
  }
  try {
    const info = await handle.stat();
    if (opts.uid >= 0 && info.uid !== opts.uid) {
      return `${opts.path}, owned by another user (uid ${info.uid})`;
    }
    if ((info.mode & 0o077) !== 0) {
      await handle.chmod(0o700).catch(() => undefined);
      if (((await handle.stat()).mode & 0o077) !== 0) {
        return `${opts.path}, a directory other users can reach that could not be made owner-only`;
      }
    }
  } finally {
    await handle.close();
  }
  return await findPlantedEntry({
    root: opts.path,
    uid: opts.uid,
    depth: opts.depth - 1,
  });
}

/**
 * Why the daemon directory could not be opened: one of this user's own
 * directories without read permission gets the `chmod` to run; anything
 * else (a link, another account's entry, not a directory) is not Hack's.
 */
function describeUnopenableDirectory(opts: {
  readonly root: string;
  readonly uid: number;
  readonly error: unknown;
}): string {
  const detail =
    opts.error instanceof Error ? opts.error.message : String(opts.error);
  try {
    const info = lstatSync(opts.root);
    if (info.isDirectory() && (opts.uid < 0 || info.uid === opts.uid)) {
      return `hackd state directory ${opts.root} could not be opened (${detail}); fix its permissions (chmod 700 ${opts.root}) and start hackd again`;
    }
  } catch {
    // Described below.
  }
  return `hackd state directory ${opts.root} is not a directory of its own (${detail}); remove or rename it and start hackd again`;
}

/**
 * Makes a bound Unix socket owner-only (`0600`). Best effort: the directory
 * permissions from {@link secureDaemonDirectory} already keep other users
 * out.
 */
export async function restrictSocketMode(opts: {
  readonly path: string;
}): Promise<void> {
  try {
    await chmod(opts.path, 0o600);
  } catch {
    // The owner-only directory is the boundary.
  }
}
