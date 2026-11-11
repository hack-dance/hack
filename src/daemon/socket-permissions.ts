import { chmod, stat } from "node:fs/promises";

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
 * Throws when the directory still grants group or other access afterwards
 * (for example a filesystem that ignores chmod), so hackd does not serve
 * its API from a shared directory.
 */
export async function secureDaemonDirectory(opts: {
  readonly root: string;
}): Promise<void> {
  try {
    await chmod(opts.root, 0o700);
  } catch {
    // Checked below.
  }
  const mode = (await stat(opts.root)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `hackd state directory ${opts.root} is accessible to other users (mode ${mode.toString(8)}) and could not be made owner-only; fix its permissions (chmod 700) and start hackd again`
    );
  }
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
