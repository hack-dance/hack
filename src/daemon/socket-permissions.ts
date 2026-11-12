import { constants, lstatSync } from "node:fs";
import { chmod, type FileHandle, open } from "node:fs/promises";
import { dirname } from "node:path";

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
