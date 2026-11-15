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
 * The child gets the allowlisted environment from `vetted-env.ts`.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { childEnvironment } from "./child-environment.ts";
import { run } from "./shell.ts";
import {
  VETTED_HELPER_PATH,
  vettedHelperEnv,
  vettedRootCommand,
} from "./vetted-env.ts";

const SUDO_CANDIDATES = ["/usr/bin/sudo", "/bin/sudo"] as const;
const ROOT_UID = 0;
const SETUID = 0o4000;
const GROUP_OR_WORLD_WRITE = 0o022;
/** Exit code reported when no trustworthy sudo exists or it cannot start. */
export const SUDO_UNAVAILABLE_EXIT = 126;

export const PRIVILEGED_CHILD_PATH = VETTED_HELPER_PATH;

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

/** Spawns `argv` with `input` on stdin and the terminal for output. */
export type InputRunner = (
  argv: readonly string[],
  opts: {
    readonly input: Uint8Array;
    readonly env: Readonly<Record<string, string>>;
  }
) => Promise<number>;

const spawnWithInput: InputRunner = async (argv, opts) => {
  // sudo reads a password from /dev/tty, not stdin, so stdin can carry data.
  const proc = Bun.spawn([...argv], {
    stdin: new Blob([opts.input.slice()]),
    stdout: "inherit",
    stderr: "inherit",
    env: childEnvironment({ ...opts.env }),
  });
  return await proc.exited;
};

/**
 * The exact argv `runTrustedSudo` spawns for `argv`: the vetted sudo, then
 * `vettedRootCommand` (fixed PATH and locale), then `argv`. Plans print this,
 * so a printed root step is the spawned one (HACK-2218).
 */
export function trustedSudoInvocation(opts: {
  readonly sudo: string;
  readonly argv: readonly string[];
}): readonly string[] {
  return [opts.sudo, ...vettedRootCommand(opts.argv)];
}

/**
 * Run `<trusted sudo> <argv>` with the terminal attached and the vetted
 * helper environment. With `input`, those bytes are the child's stdin (the
 * terminal still serves sudo's prompt). Returns {@link SUDO_UNAVAILABLE_EXIT}
 * when no trustworthy sudo exists or it cannot be started; never throws.
 */
export async function runTrustedSudo(
  argv: readonly string[],
  opts?: {
    readonly fs?: SudoFs;
    readonly runner?: typeof run;
    readonly input?: Uint8Array;
    readonly inputRunner?: InputRunner;
  }
): Promise<number> {
  const sudo = await resolveTrustedSudo(opts?.fs);
  if (sudo === null) {
    return SUDO_UNAVAILABLE_EXIT;
  }
  const helperEnv = vettedHelperEnv();
  const command = trustedSudoInvocation({ sudo, argv });
  try {
    if (opts?.input !== undefined) {
      return await (opts.inputRunner ?? spawnWithInput)(command, {
        input: opts.input,
        env: helperEnv.env,
      });
    }
    return await (opts?.runner ?? run)(command, {
      stdin: "inherit",
      env: { ...helperEnv.env },
      unsetEnvKeys: helperEnv.unsetEnvKeys,
    });
  } catch {
    return SUDO_UNAVAILABLE_EXIT;
  }
}
