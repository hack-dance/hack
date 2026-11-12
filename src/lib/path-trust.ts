import {
  chmodSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

/**
 * Whether anything on the way to a path can be replaced by another
 * account (HACK-2052). The checks use synchronous `lstat`/`readlink`: they
 * are short local metadata reads, and a PATH directory such as /usr/bin
 * holds thousands of entries, where an async round trip per call costs
 * more than the call: used for hackd's state directory, the programs and
 * unit files a login service runs, and systemd's load paths. Paths are
 * walked the way the kernel resolves them, one component at a time with
 * symlinks followed where they are met.
 */

const MAX_SERVICE_PATH_HOPS = 64;

/**
 * Null when nothing on the way to `path` can be replaced by another account:
 * `path`, every directory above it up to `/`, and, for every symlink hop on
 * the path or on any directory above it, the hop target's own chain. Each
 * entry must be owned by `uid` or root and not writable by group or others
 * (sticky directories excepted); group/other write is removed inside
 * `hackHome` (Hack's own directories) and refused elsewhere.
 */
export function checkReplaceableChain(opts: {
  readonly path: string;
  readonly uid: number;
  readonly hackHome: string | null;
  /** Check the last component itself but do not follow it when it is a link. */
  readonly stopAtLink?: boolean;
  /**
   * Entries already found safe, shared across calls that check many paths
   * under the same directories (a whole PATH directory).
   */
  readonly checked?: Set<string>;
}): string | null {
  const walk = walkReplaceableChain(opts);
  return "error" in walk ? walk.error : null;
}

/**
 * {@link checkReplaceableChain}, also reporting where the walk ended. With
 * `allowMissing`, a component that does not exist ends the walk instead of
 * failing it: `existing` is then the deepest physical directory reached,
 * after every link on the way (dangling ones included) was followed and
 * checked, and `complete` is false.
 */
export function walkReplaceableChain(opts: {
  readonly path: string;
  readonly uid: number;
  readonly hackHome: string | null;
  readonly stopAtLink?: boolean;
  readonly allowMissing?: boolean;
  readonly checked?: Set<string>;
}):
  | { readonly error: string }
  | { readonly existing: string; readonly complete: boolean } {
  if (!isAbsolute(opts.path)) {
    return { error: `${opts.path} is not an absolute path` };
  }
  // Walk the path the way the kernel does: one component at a time from
  // `/`, following each symlink where it is met and applying `..` to the
  // physical directory reached so far (never collapsing `..` lexically
  // first, which can name a different file). Every entry visited, links
  // included, is checked; `state.cur` is always a symlink-free directory.
  const state: ChainWalk = {
    opts,
    checked: opts.checked ?? new Set<string>(),
    queue: opts.path.split("/"),
    cur: "/",
    hops: 0,
  };
  const rootError = checkChainEntry(state, "/");
  if (rootError !== null) {
    return { error: rootError };
  }
  while (state.queue.length > 0) {
    const step = walkChainStep(state);
    if (step !== null) {
      return step;
    }
  }
  return { existing: state.cur, complete: true };
}

type ChainWalk = {
  readonly opts: {
    readonly path: string;
    readonly uid: number;
    readonly hackHome: string | null;
    readonly stopAtLink?: boolean;
    readonly allowMissing?: boolean;
  };
  readonly checked: Set<string>;
  readonly queue: string[];
  cur: string;
  hops: number;
};

function checkChainEntry(state: ChainWalk, entry: string): string | null {
  if (state.checked.has(entry)) {
    return null;
  }
  state.checked.add(entry);
  return checkServicePathEntry({
    path: entry,
    uid: state.opts.uid,
    hackHome: state.opts.hackHome,
  });
}

/** One component of {@link walkReplaceableChain}; a result ends the walk. */
function walkChainStep(
  state: ChainWalk
):
  | { readonly error: string }
  | { readonly existing: string; readonly complete: boolean }
  | null {
  const component = state.queue.shift() as string;
  if (component === "" || component === ".") {
    return null;
  }
  if (component === "..") {
    state.cur = dirname(state.cur);
    return null;
  }
  const next =
    state.cur === "/" ? `/${component}` : `${state.cur}/${component}`;
  if (state.opts.allowMissing === true && !entryExists(next)) {
    return { existing: state.cur, complete: false };
  }
  const error = checkChainEntry(state, next);
  if (error !== null) {
    return { error };
  }
  const link = readSymlinkTarget(next);
  if (
    link === null ||
    (state.opts.stopAtLink === true && state.queue.length === 0)
  ) {
    state.cur = next;
    return null;
  }
  state.hops += 1;
  if (state.hops > MAX_SERVICE_PATH_HOPS) {
    return { error: `${state.opts.path} has too many symlink hops to check` };
  }
  if (link.startsWith("/")) {
    state.cur = "/";
  }
  state.queue.unshift(...link.split("/"));
  return null;
}

/** Any directory entry, a dangling symlink included. */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A symlink's raw target, or null when `path` is not a link. */
function readSymlinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      return null;
    }
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function checkServicePathEntry(opts: {
  readonly path: string;
  readonly uid: number;
  readonly hackHome: string | null;
}): string | null {
  let info: Stats;
  try {
    info = lstatSync(opts.path);
  } catch (error: unknown) {
    return `${opts.path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Ownership first, links included: in a sticky directory the owner of a
  // link can still replace it. A regular file owned by a system account in
  // a root-owned directory nobody else can write is the package manager's
  // (setuid tools such as `at` owned by `daemon`): only its mode matters
  // there. Another regular user's file is never trusted: its owner can
  // chmod and rewrite it whatever the directory.
  if (
    opts.uid >= 0 &&
    info.uid !== opts.uid &&
    info.uid !== 0 &&
    !(
      info.isFile() &&
      isSystemAccount(info.uid) &&
      isProtectedSystemDir(dirname(opts.path))
    )
  ) {
    return `${opts.path} is owned by another user (uid ${info.uid})`;
  }
  if (info.isSymbolicLink()) {
    // Otherwise a link cannot be rewritten in place: its directory is
    // checked, and its target's chain is followed as another hop.
    return null;
  }
  const sticky = info.isDirectory() && (info.mode & 0o1000) !== 0;
  if ((info.mode & 0o022) === 0 || sticky) {
    return null;
  }
  // Only a directory inside the Hack home is repaired: whoever could write a
  // file may already have changed its contents, which a chmod would keep.
  const insideHackHome =
    opts.hackHome !== null &&
    (opts.path === opts.hackHome || opts.path.startsWith(`${opts.hackHome}/`));
  if (insideHackHome && info.isDirectory() && info.uid === opts.uid) {
    try {
      chmodSync(opts.path, info.mode & 0o7755);
      if ((lstatSync(opts.path).mode & 0o022) === 0) {
        return null;
      }
    } catch {
      // Reported below.
    }
  }
  return `${opts.path} is writable by other users (mode ${(info.mode & 0o777).toString(8)}); run: chmod go-w ${opts.path}`;
}

/** "mode NNNN" when others may create entries in `dir` (sticky or not). */
export function lettingOthersCreate(dir: string): string | null {
  const mode = statSync(dir).mode;
  return (mode & 0o022) === 0 ? null : `mode ${(mode & 0o7777).toString(8)}`;
}

/**
 * A root-owned directory nobody else can write (sticky or not): only there
 * does a file's foreign owner mean "the package manager set it". In `/tmp`
 * (root-owned, 1777) a file's owner controls it.
 */
function isProtectedSystemDir(dir: string): boolean {
  try {
    const info = lstatSync(dir);
    return (
      info.isDirectory() && info.uid === 0 && (Number(info.mode) & 0o022) === 0
    );
  } catch {
    return false;
  }
}

let uidMin: number | null = null;

/**
 * Below the system's first regular-user uid (`UID_MIN` in
 * /etc/login.defs, 1000 when absent): an operating-system account, not
 * another person on the host.
 */
export function isSystemAccount(uid: number): boolean {
  if (uidMin === null) {
    uidMin = 1000;
    try {
      const defs = readFileSync("/etc/login.defs", "utf8");
      const value = UID_MIN_LINE.exec(defs)?.[1];
      if (value) {
        uidMin = Number.parseInt(value, 10);
      }
    } catch {
      // No login.defs: keep the common default.
    }
  }
  return uid > 0 && uid < uidMin;
}

const UID_MIN_LINE = /^\s*UID_MIN\s+(\d+)/m;
