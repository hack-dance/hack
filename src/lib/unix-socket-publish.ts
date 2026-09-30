import { randomBytes } from "node:crypto";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import type { Server } from "node:net";
import { basename, dirname, join } from "node:path";

/** Device and inode of a published Unix-socket endpoint. */
export interface UnixSocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Thrown when a file already exists at the requested endpoint path. */
export class UnixSocketEndpointExists extends Error {
  readonly code = "EEXIST";
  readonly path: string;
  constructor(path: string) {
    super("Unix socket endpoint already exists");
    this.path = path;
  }
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function removeIfSame(
  path: string,
  identity: UnixSocketIdentity
): Promise<void> {
  const current = await lstat(path).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw error;
  });
  if (current && current.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path);
  }
}

/**
 * Removes the staging name after a failed start: the socket this attempt bound (by identity once
 * known) or, before that, only a socket of this user, since the fresh private name held nothing
 * before listen.
 */
async function removeStaging(
  staging: string,
  bound: UnixSocketIdentity | undefined
): Promise<void> {
  const current = await lstat(staging).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw error;
  });
  if (
    current?.isSocket() &&
    current.uid === process.getuid?.() &&
    (!bound || (current.dev === bound.dev && current.ino === bound.ino))
  ) {
    await unlink(staging);
  }
}

/**
 * Listens on a Unix socket published at `path`, so that the runtime never replaces or removes a
 * file at `path`.
 *
 * Bun replaces an existing file at a Unix server's bound path when it listens, and from 1.3.14 it
 * unlinks the bound path by name when the server closes, whatever that path holds by then. Binding
 * `path` directly would let a close remove a foreign replacement. Instead the server binds a fresh
 * staging name in the same directory, never longer than `path`'s own name so path-length budgets
 * hold, under an owner-only umask, and set to `mode` before publication. It is then published with link(2), which refuses an existing
 * `path` (EEXIST) rather than replacing it. The staging name is removed right away, so a
 * close-time unlink by the runtime finds nothing. `path` is removed only by the caller's
 * identity-checked cleanup, using the returned identity.
 *
 * The directory must be private to this user. On any failure, including a listen that bound the
 * staging name and then failed, the server is closed, a staging socket this attempt created is
 * removed, and `path` is removed only while it still holds this server's socket. Callers keep the
 * returned identity at once and compare every later observation of `path` against it.
 */
export async function listenPublishedUnixSocket(
  server: Server,
  path: string,
  options: {
    /** Endpoint permissions, applied before publication. */
    readonly mode?: number;
    /** Changes a mode by path; replaceable to inject a preparation failure. */
    readonly setMode?: typeof chmod;
  } = {}
): Promise<UnixSocketIdentity> {
  const mode = options.mode ?? 0o600;
  const setMode = options.setMode ?? chmod;
  const name = basename(path);
  const staging = join(
    dirname(path),
    `.${randomBytes(Math.ceil(name.length / 2))
      .toString("hex")
      .slice(0, Math.max(4, name.length - 1))}`
  );
  if (
    await lstat(staging).then(
      () => true,
      (error: unknown) => (missing(error) ? false : Promise.reject(error))
    )
  ) {
    throw new Error("Unix socket staging name is already in use");
  }
  let bound: UnixSocketIdentity | undefined;
  let published: UnixSocketIdentity | undefined;
  try {
    // Inside the cleanup: a runtime can create the staging socket and still fail
    // the listen, which must not leave that socket or a listener behind.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Bun binds synchronously inside listen(); keep the socket owner-only from
      // creation and restore the mask before any await.
      const previousMask = process.umask();
      process.umask(previousMask | 0o077);
      try {
        server.listen(staging, () => {
          server.off("error", reject);
          resolve();
        });
      } finally {
        process.umask(previousMask);
      }
    });
    const created = await lstat(staging);
    if (!created.isSocket() || created.uid !== process.getuid?.()) {
      throw new Error(
        "Unix socket staging endpoint changed before publication"
      );
    }
    bound = { dev: created.dev, ino: created.ino };
    // Set the mode before publication, so the endpoint is never changed by path
    // afterwards (a replacement there is never chmodded or adopted).
    await setMode(staging, mode);
    const prepared = await lstat(staging);
    if (
      !prepared.isSocket() ||
      prepared.dev !== bound.dev ||
      prepared.ino !== bound.ino ||
      (prepared.mode & 0o777) !== mode
    ) {
      throw new Error(
        "Unix socket staging endpoint changed before publication"
      );
    }
    try {
      await link(staging, path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new UnixSocketEndpointExists(path);
      }
      throw error;
    }
    published = bound;
    const current = await lstat(path);
    if (
      !current.isSocket() ||
      current.dev !== bound.dev ||
      current.ino !== bound.ino
    ) {
      throw new Error("Unix socket endpoint changed during publication");
    }
    await unlink(staging);
    return published;
  } catch (error) {
    // Closing a server that never listened reports an error; either way it is closed.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeStaging(staging, bound);
    if (published) {
      await removeIfSame(path, published);
    }
    throw error;
  }
}
