/**
 * Resolve and run the system `sudo` for Hack's confirmed Linux root steps.
 *
 * A bare `sudo` resolves through the caller's PATH, so a same-user process
 * that can write an earlier PATH directory could substitute its own binary,
 * receive the terminal and the approved arguments, and run something else
 * through the real sudo. Hack therefore only uses a sudo that is:
 * - at a fixed system path (never looked up on PATH);
 * - after resolving symlinks, a regular setuid file owned by root and not
 *   group- or world-writable;
 * - inside directories (up to `/`) owned by root and not group- or
 *   world-writable.
 * The child gets a fixed system PATH and no loader/shell injection variables.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "./shell.ts";

const SUDO_CANDIDATES = ["/usr/bin/sudo", "/bin/sudo"] as const;
const ROOT_UID = 0;
const SETUID = 0o4000;
const GROUP_OR_WORLD_WRITE = 0o022;
/** Exit code reported when no trustworthy sudo exists or it cannot start. */
export const SUDO_UNAVAILABLE_EXIT = 126;

export const PRIVILEGED_CHILD_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const UNSAFE_ENV_KEYS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "IFS",
  "SUDO_ASKPASS",
  // A preserved temp dir could put root's verified copy in a user-writable
  // directory; root scripts name /tmp explicitly.
  "TMPDIR",
  "TMP",
  "TEMP",
] as const;

export type FileFacts = {
  readonly uid: number;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
};

/** Filesystem reads used to vet sudo; injectable for tests. */
export type SudoFs = {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<FileFacts>;
};

const realFs: SudoFs = {
  realpath: async (path) => await realpath(path),
  stat: async (path) => {
    const info = await stat(path);
    return {
      uid: info.uid,
      mode: info.mode,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
    };
  },
};

function rootOwnedNotWritable(facts: FileFacts): boolean {
  return facts.uid === ROOT_UID && (facts.mode & GROUP_OR_WORLD_WRITE) === 0;
}

/** The vetted absolute sudo path, or `null` when none qualifies. */
export async function resolveTrustedSudo(
  fs: SudoFs = realFs
): Promise<string | null> {
  for (const candidate of SUDO_CANDIDATES) {
    try {
      const resolved = await fs.realpath(candidate);
      const facts = await fs.stat(resolved);
      if (
        !(
          facts.isFile &&
          rootOwnedNotWritable(facts) &&
          (facts.mode & SETUID) !== 0
        )
      ) {
        continue;
      }
      let dir = dirname(resolved);
      let dirsOk = true;
      for (;;) {
        const dirFacts = await fs.stat(dir);
        if (!(dirFacts.isDirectory && rootOwnedNotWritable(dirFacts))) {
          dirsOk = false;
          break;
        }
        const parent = dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
      if (dirsOk) {
        return resolved;
      }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return null;
}

/**
 * Run `<trusted sudo> <argv>` with the terminal attached and a sanitized
 * environment. Returns {@link SUDO_UNAVAILABLE_EXIT} when no trustworthy
 * sudo exists or it cannot be started; never throws.
 */
export async function runTrustedSudo(
  argv: readonly string[],
  opts?: { readonly fs?: SudoFs; readonly runner?: typeof run }
): Promise<number> {
  const sudo = await resolveTrustedSudo(opts?.fs);
  if (sudo === null) {
    return SUDO_UNAVAILABLE_EXIT;
  }
  try {
    return await (opts?.runner ?? run)([sudo, ...argv], {
      stdin: "inherit",
      env: { PATH: PRIVILEGED_CHILD_PATH },
      unsetEnvKeys: UNSAFE_ENV_KEYS,
    });
  } catch {
    return SUDO_UNAVAILABLE_EXIT;
  }
}
