import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Private request directories may become runtime state and must use a physical path. */
export async function nativeRuntimeTempDirectory(
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await realpath(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const COMBINED_PREFIX = "hack-native-combined-";
const COMBINED_FILE = "compose.json";
// mkdtemp appends six characters. Current names carry the creating PID.
const COMBINED_NAME = /^hack-native-combined-(?:(\d{1,10})-)?[A-Za-z0-9]{6}$/;
// Names from before the PID was recorded cannot be tied to a process. An
// append request is bounded well under this, so an older one is abandoned.
const LEGACY_COMBINED_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The directory for one append's combined Compose file (mode 0600). The name
 * carries this process's PID so a later run can tell an abandoned directory
 * from a live one: the `finally` that removes it does not run after SIGKILL.
 */
export function nativeCombinedTempDirectory(): Promise<string> {
  return nativeRuntimeTempDirectory(`${COMBINED_PREFIX}${process.pid}-`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the PID exists under another user, so it is not provably gone.
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

/** Whether `path` (named `name`) is this user's abandoned combined directory. */
async function abandonedCombinedDirectory(opts: {
  readonly name: string;
  readonly path: string;
  readonly alive: (pid: number) => boolean;
  readonly now: number;
}): Promise<boolean> {
  const match = COMBINED_NAME.exec(opts.name);
  if (!match) {
    return false;
  }
  const info = await lstat(opts.path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    return false;
  }
  const pid = match[1] === undefined ? undefined : Number(match[1]);
  const abandoned =
    pid === undefined
      ? opts.now - info.mtimeMs > LEGACY_COMBINED_AGE_MS
      : pid !== process.pid && !opts.alive(pid);
  if (!abandoned) {
    return false;
  }
  const entries = await readdir(opts.path);
  return entries.every((entry) => entry === COMBINED_FILE);
}

/**
 * Best effort: remove combined Compose directories left by a killed CLI. Only
 * this user's real directories that hold nothing but the combined file are
 * removed, and only when the recorded PID has exited (or, for a legacy name
 * without a PID, after a day). A live append's directory is never touched.
 * Returns the removed paths; failures are ignored.
 */
export async function sweepAbandonedNativeCombinedDirectories(
  opts: {
    readonly root?: string;
    readonly alive?: (pid: number) => boolean;
    readonly now?: number;
  } = {}
): Promise<readonly string[]> {
  const root = opts.root ?? tmpdir();
  const alive = opts.alive ?? processAlive;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      if (await abandonedCombinedDirectory({ name, path, alive, now })) {
        await rm(path, { recursive: true, force: true });
        removed.push(path);
      }
    } catch {
      // Raced with its owner or unreadable: leave it.
    }
  }
  return removed;
}
