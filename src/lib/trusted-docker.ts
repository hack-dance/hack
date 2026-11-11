/**
 * A Docker client Hack trusts to witness the running Caddy root before it
 * offers system-wide trust (`hack global trust` on Linux).
 *
 * A bare `docker` resolves through the caller's PATH, so a same-user process
 * that can write an earlier PATH directory could answer both the CA export
 * and its supposed runtime witness. The witness therefore uses only a client
 * at a fixed system path that, after resolving symlinks, is a regular
 * executable owned by root and not group- or world-writable, inside
 * directories (up to `/`) owned by root and not group- or world-writable.
 *
 * Engine selection (`DOCKER_HOST`, the current context) is kept: rootless
 * Docker and Docker Desktop for Linux depend on it, and a same-user process
 * able to run its own engine is not something a local check can rule out.
 * The prompt's SHA-256 fingerprint remains the user's final check.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type ExecOptions, type ExecResult, exec } from "./shell.ts";

const DOCKER_CANDIDATES = [
  "/usr/bin/docker",
  "/usr/local/bin/docker",
  "/bin/docker",
] as const;
const ROOT_UID = 0;
const GROUP_OR_WORLD_WRITE = 0o022;
const ANY_EXECUTE = 0o111;

export type BinaryFacts = {
  readonly uid: number;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
};

/** Filesystem reads used to vet the client; injectable for tests. */
export type BinaryFs = {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<BinaryFacts>;
};

const realFs: BinaryFs = {
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

function rootOwnedNotWritable(facts: BinaryFacts): boolean {
  return facts.uid === ROOT_UID && (facts.mode & GROUP_OR_WORLD_WRITE) === 0;
}

async function directoriesRootOwned(opts: {
  readonly fs: BinaryFs;
  readonly file: string;
}): Promise<boolean> {
  let dir = dirname(opts.file);
  for (;;) {
    const facts = await opts.fs.stat(dir);
    if (!(facts.isDirectory && rootOwnedNotWritable(facts))) {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return true;
    }
    dir = parent;
  }
}

/** The vetted absolute docker path, or `null` when none qualifies. */
export async function resolveTrustedDocker(
  fs: BinaryFs = realFs
): Promise<string | null> {
  for (const candidate of DOCKER_CANDIDATES) {
    try {
      const resolved = await fs.realpath(candidate);
      const facts = await fs.stat(resolved);
      if (
        facts.isFile &&
        rootOwnedNotWritable(facts) &&
        (facts.mode & ANY_EXECUTE) !== 0 &&
        (await directoriesRootOwned({ fs, file: resolved }))
      ) {
        return resolved;
      }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return null;
}

const UNAVAILABLE: ExecResult = { exitCode: 127, stdout: "", stderr: "" };

/**
 * An `exec` that runs `docker …` through the vetted client only. Any other
 * command, or `docker` when no client qualifies, reports exit 127 so callers
 * treat the runtime as unavailable.
 */
export function createTrustedDockerExec(opts?: {
  readonly fs?: BinaryFs;
  readonly execute?: typeof exec;
}): typeof exec {
  return async (cmd: readonly string[], options?: ExecOptions) => {
    if (cmd[0] !== "docker") {
      return UNAVAILABLE;
    }
    const docker = await resolveTrustedDocker(opts?.fs);
    if (docker === null) {
      return UNAVAILABLE;
    }
    try {
      return await (opts?.execute ?? exec)([docker, ...cmd.slice(1)], options);
    } catch {
      return UNAVAILABLE;
    }
  };
}
