import { chmod, lstat, readlink, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

/**
 * Whether anything on the way to a path can be replaced by another
 * account (HACK-2052): used for hackd's state directory, the programs and
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
export async function checkReplaceableChain(opts: {
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
}): Promise<string | null> {
  const walk = await walkReplaceableChain(opts);
  return "error" in walk ? walk.error : null;
}

/**
 * {@link checkReplaceableChain}, also reporting where the walk ended. With
 * `allowMissing`, a component that does not exist ends the walk instead of
 * failing it: `existing` is then the deepest physical directory reached,
 * after every link on the way (dangling ones included) was followed and
 * checked, and `complete` is false.
 */
export async function walkReplaceableChain(opts: {
  readonly path: string;
  readonly uid: number;
  readonly hackHome: string | null;
  readonly stopAtLink?: boolean;
  readonly allowMissing?: boolean;
  readonly checked?: Set<string>;
}): Promise<
  | { readonly error: string }
  | { readonly existing: string; readonly complete: boolean }
> {
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
  const rootError = await checkChainEntry(state, "/");
  if (rootError !== null) {
    return { error: rootError };
  }
  while (state.queue.length > 0) {
    const step = await walkChainStep(state);
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

async function checkChainEntry(
  state: ChainWalk,
  entry: string
): Promise<string | null> {
  if (state.checked.has(entry)) {
    return null;
  }
  state.checked.add(entry);
  return await checkServicePathEntry({
    path: entry,
    uid: state.opts.uid,
    hackHome: state.opts.hackHome,
  });
}

/** One component of {@link walkReplaceableChain}; a result ends the walk. */
async function walkChainStep(
  state: ChainWalk
): Promise<
  | { readonly error: string }
  | { readonly existing: string; readonly complete: boolean }
  | null
> {
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
  if (state.opts.allowMissing === true && !(await entryExists(next))) {
    return { existing: state.cur, complete: false };
  }
  const error = await checkChainEntry(state, next);
  if (error !== null) {
    return { error };
  }
  const link = await readSymlinkTarget(next);
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
export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A symlink's raw target, or null when `path` is not a link. */
async function readSymlinkTarget(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) {
      return null;
    }
    return await readlink(path);
  } catch {
    return null;
  }
}

async function checkServicePathEntry(opts: {
  readonly path: string;
  readonly uid: number;
  readonly hackHome: string | null;
}): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(opts.path);
  } catch (error: unknown) {
    return `${opts.path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Ownership first, links included: in a sticky directory the owner of a
  // link can still replace it. A regular file in a root-owned directory is
  // the package manager's (setuid tools owned by system accounts): only its
  // mode matters there.
  if (
    opts.uid >= 0 &&
    info.uid !== opts.uid &&
    info.uid !== 0 &&
    !(info.isFile() && (await isRootOwned(dirname(opts.path))))
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
      await chmod(opts.path, info.mode & 0o7755);
      if (((await lstat(opts.path)).mode & 0o022) === 0) {
        return null;
      }
    } catch {
      // Reported below.
    }
  }
  return `${opts.path} is writable by other users (mode ${(info.mode & 0o777).toString(8)}); run: chmod go-w ${opts.path}`;
}

/** "mode NNNN" when others may create entries in `dir` (sticky or not). */
export async function lettingOthersCreate(dir: string): Promise<string | null> {
  const mode = (await stat(dir)).mode;
  return (mode & 0o022) === 0 ? null : `mode ${(mode & 0o7777).toString(8)}`;
}

async function isRootOwned(dir: string): Promise<boolean> {
  try {
    return (await lstat(dir)).uid === 0;
  } catch {
    return false;
  }
}
