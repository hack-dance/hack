import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, type Stats, unlinkSync } from "node:fs";
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

/** Test seams between publication steps; production passes none. */
export interface UnixSocketPublishHooks {
  /** After this server bound the staging name and its identity was recorded. */
  readonly afterBind?: (staging: string) => Promise<void>;
  /** After the endpoint was linked and verified, before the staging name is retired. */
  readonly afterLink?: (staging: string) => Promise<void>;
  /** Holding names tried, in order, when an unproven staging entry is moved aside. */
  readonly holdingNames?: (staging: string) => readonly string[];
}

/** How many fresh holding names are tried before a close proceeds without one. */
const HOLDING_ATTEMPTS = 8;

function freshHoldingNames(staging: string): string[] {
  return Array.from(
    { length: HOLDING_ATTEMPTS },
    () => `${staging}.${randomBytes(4).toString("hex")}`
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function entry(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function same(
  stat: Stats | null,
  identity: UnixSocketIdentity | undefined
): boolean {
  return (
    stat !== null &&
    identity !== undefined &&
    stat.dev === identity.dev &&
    stat.ino === identity.ino
  );
}

/** Removes `path` only while it is `identity`; the check and the removal run back to back. */
function removeIfSame(path: string, identity: UnixSocketIdentity): void {
  if (same(entry(path), identity)) {
    unlinkSync(path);
  }
}

/**
 * Moves the staging entry to the first free holding name: link(2) never replaces an existing
 * holding entry, and the staging name is dropped only while it is still the linked entry.
 * Returns the holding name, or undefined when no holding name was free or the entry cannot be
 * hard-linked (the entry stays put).
 */
function moveAside(
  staging: string,
  names: readonly string[]
): string | undefined {
  for (const candidate of names) {
    try {
      linkSync(staging, candidate);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        continue;
      }
      // Not linkable (a directory, for example): it cannot be moved aside.
      return undefined;
    }
    const held = entry(candidate);
    if (held && same(entry(staging), { dev: held.dev, ino: held.ino })) {
      unlinkSync(staging);
    }
    return candidate;
  }
  return undefined;
}

/**
 * Closes `server` without letting its close-time unlink by name (Bun 1.3.14 and later, as in Node)
 * reach an entry at the staging name that this attempt cannot prove is its own. Whatever the name
 * holds is moved to a free holding name while the server closes. Afterwards this attempt's socket
 * is removed; anything else is put back by link, which never replaces a newer entry, so its inode,
 * bytes and mode are unchanged (if the name was taken meanwhile, it stays at the holding name).
 * If none of the bounded holding names is free, or the entry cannot be hard-linked, the close
 * proceeds and the runtime can remove the entry.
 */
async function closeKeepingStaging(
  server: Server,
  staging: string,
  bound: UnixSocketIdentity | undefined,
  holdingNames: (staging: string) => readonly string[]
): Promise<void> {
  const held = entry(staging)
    ? moveAside(staging, holdingNames(staging))
    : undefined;
  // Closing a server that never listened reports an error; either way it is closed.
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!held) {
    return;
  }
  if (bound && same(entry(held), bound)) {
    unlinkSync(held);
    return;
  }
  try {
    linkSync(held, staging);
    unlinkSync(held);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
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
 * hold. The socket is created with exactly `mode` (the umask during the synchronous bind), so no
 * name is ever chmodded, and its identity is recorded in the same tick. It is published with
 * link(2), which refuses an existing `path` (EEXIST) rather than replacing it, and the staging name
 * is then retired only while it is still this socket. `path` is removed only by the caller's
 * identity-checked cleanup, using the returned identity; callers keep it at once and compare every
 * later observation of `path` against it.
 *
 * On any failure the server is closed, only this attempt's socket is removed, and `path` is
 * removed only while it still holds this socket. An entry at the staging name that is not this
 * socket, or cannot be proven to be (an ambiguous partial bind), is moved to a free holding name
 * for the close and put back.
 *
 * Scope: the directory must be private to this user. These guarantees cover accidental and
 * concurrent entries, not an adversarial process of the same user, which can race any path-based
 * check. Residuals:
 * - Each check and its operation run back to back, but by path: an entry changed between them is
 *   outside the guarantee.
 * - If the staging entry cannot be moved aside (every bounded holding name occupied, or an entry
 *   that cannot be hard-linked, such as a directory), the failure close proceeds and the runtime's
 *   close-time unlink can remove it.
 * - After a successful return the staging name is retired. The runtime's normal close later
 *   unlinks that name, and can remove an entry placed there afterwards.
 */
export async function listenPublishedUnixSocket(
  server: Server,
  path: string,
  options: {
    /** Endpoint permissions, set at creation. */
    readonly mode?: number;
    readonly hooks?: UnixSocketPublishHooks;
  } = {}
): Promise<UnixSocketIdentity> {
  const mode = options.mode ?? 0o600;
  const hooks = options.hooks ?? {};
  const name = basename(path);
  const staging = join(
    dirname(path),
    `.${randomBytes(Math.ceil(name.length / 2))
      .toString("hex")
      .slice(0, Math.max(4, name.length - 1))}`
  );
  if (entry(staging)) {
    throw new Error("Unix socket staging name is already in use");
  }
  let bound: UnixSocketIdentity | undefined;
  let published = false;
  try {
    // Inside the cleanup: a runtime can create the staging socket and still fail
    // the listen, which must not leave a listener behind.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Bun binds synchronously inside listen(): create the socket with exactly
      // `mode` and restore the mask before any await.
      const previousMask = process.umask();
      process.umask(0o777 & ~mode);
      try {
        server.listen(staging, () => {
          server.off("error", reject);
          resolve();
        });
        // Record what this server bound before anything else runs here.
        const created = entry(staging);
        if (
          created?.isSocket() &&
          created.uid === process.getuid?.() &&
          (created.mode & 0o777) === mode
        ) {
          bound = { dev: created.dev, ino: created.ino };
        }
      } finally {
        process.umask(previousMask);
      }
    });
    if (!bound) {
      throw new Error(
        "Unix socket staging endpoint is not this server's socket"
      );
    }
    await hooks.afterBind?.(staging);
    // Publish only this server's socket; the check and the link run back to back.
    if (!same(entry(staging), bound)) {
      throw new Error(
        "Unix socket staging endpoint changed before publication"
      );
    }
    try {
      linkSync(staging, path);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new UnixSocketEndpointExists(path);
      }
      throw error;
    }
    published = true;
    if (!same(entry(path), bound)) {
      throw new Error("Unix socket endpoint changed during publication");
    }
    await hooks.afterLink?.(staging);
    // Retire the staging name only while it is this socket; anything else is kept.
    removeIfSame(staging, bound);
    return bound;
  } catch (error) {
    await closeKeepingStaging(
      server,
      staging,
      bound,
      hooks.holdingNames ?? freshHoldingNames
    );
    if (published && bound) {
      removeIfSame(path, bound);
    }
    throw error;
  }
}
