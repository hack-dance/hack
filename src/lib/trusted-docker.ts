/**
 * A Docker client and engine Hack trusts to witness the running Caddy root
 * before it offers system-wide trust (`hack global trust` on Linux).
 *
 * A same-user process must not be able to answer both the CA export and its
 * runtime witness. So the witness:
 * - runs only a client at a fixed system path that, after resolving
 *   symlinks, is a regular executable owned by root and not group- or
 *   world-writable, inside root-owned, non-writable directories up to `/`;
 * - talks only to the system engine socket (`/var/run/docker.sock` or
 *   `/run/docker.sock`) when, after resolving symlinks, it is a socket owned
 *   by root, not world-writable, inside root-owned, non-writable
 *   directories; `DOCKER_HOST` is forced to it;
 * - ignores the user's client configuration: `DOCKER_CONFIG` points at a
 *   path under `/` that no user can create, so only system CLI plugins
 *   (including Compose) load, and `DOCKER_CONTEXT` plus TLS/certificate
 *   selectors are removed.
 * Rootless Docker and Docker Desktop for Linux have no such system engine;
 * there the witness is unavailable and automatic trust is refused.
 */
import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type ExecOptions, type ExecResult, exec } from "./shell.ts";
import { vettedHelperEnv } from "./vetted-env.ts";

const DOCKER_CANDIDATES = [
  "/usr/bin/docker",
  "/usr/local/bin/docker",
  "/bin/docker",
] as const;
const SOCKET_CANDIDATES = ["/var/run/docker.sock", "/run/docker.sock"] as const;
const ROOT_UID = 0;
const GROUP_OR_WORLD_WRITE = 0o022;
const WORLD_WRITE = 0o002;
const ANY_EXECUTE = 0o111;
const SYSTEM_TOOL_DIRS = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"] as const;
const SYSTEM_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** No user can create this (its parent is `/`), so no user plugins load. */
export const FROZEN_DOCKER_CONFIG = "/nonexistent/hack-trusted-docker-config";
const ENGINE_SELECTORS = [
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_CLI_PLUGIN_EXTRA_DIRS",
] as const;

export type BinaryFacts = {
  readonly uid: number;
  readonly mode: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSocket: boolean;
};

/** Filesystem reads used to vet the client and socket; injectable for tests. */
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
      isSocket: info.isSocket(),
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

async function firstVetted(opts: {
  readonly fs: BinaryFs;
  readonly candidates: readonly string[];
  readonly accept: (facts: BinaryFacts) => boolean;
}): Promise<string | null> {
  for (const candidate of opts.candidates) {
    try {
      const resolved = await opts.fs.realpath(candidate);
      if (
        opts.accept(await opts.fs.stat(resolved)) &&
        (await directoriesRootOwned({ fs: opts.fs, file: resolved }))
      ) {
        return resolved;
      }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return null;
}

/** The vetted absolute docker client path, or `null` when none qualifies. */
export async function resolveTrustedDocker(
  fs: BinaryFs = realFs
): Promise<string | null> {
  return await firstVetted({
    fs,
    candidates: DOCKER_CANDIDATES,
    accept: (facts) =>
      facts.isFile &&
      rootOwnedNotWritable(facts) &&
      (facts.mode & ANY_EXECUTE) !== 0,
  });
}

/**
 * A distro-provided executable used by Linux trust, never selected from PATH.
 * Apply the same root ownership, mode and ancestor policy as the Docker client.
 */
export async function resolveTrustedSystemTool(opts: {
  readonly name: string;
  readonly fs?: BinaryFs;
}): Promise<string | null> {
  if (!SYSTEM_TOOL_NAME.test(opts.name)) {
    return null;
  }
  return await firstVetted({
    fs: opts.fs ?? realFs,
    candidates: SYSTEM_TOOL_DIRS.map((dir) => `${dir}/${opts.name}`),
    accept: (facts) =>
      facts.isFile &&
      rootOwnedNotWritable(facts) &&
      (facts.mode & ANY_EXECUTE) !== 0,
  });
}

/**
 * The vetted system engine socket, or `null`. Group write is allowed (the
 * `docker` group); world write and non-root ownership are not.
 */
export async function resolveSystemDockerSocket(
  fs: BinaryFs = realFs
): Promise<string | null> {
  return await firstVetted({
    fs,
    candidates: SOCKET_CANDIDATES,
    accept: (facts) =>
      facts.isSocket &&
      facts.uid === ROOT_UID &&
      (facts.mode & WORLD_WRITE) === 0,
  });
}

const UNAVAILABLE: ExecResult = { exitCode: 127, stdout: "", stderr: "" };

/**
 * An `exec` that runs `docker …` only through the vetted client against the
 * vetted system engine, with the user's engine selection and client
 * configuration ignored. Any other command, or a missing client or system
 * engine, reports exit 127 so callers treat the runtime as unavailable.
 */
export function createTrustedDockerExec(opts?: {
  readonly fs?: BinaryFs;
  readonly execute?: typeof exec;
}): typeof exec {
  return async (cmd: readonly string[], options?: ExecOptions) => {
    if (cmd[0] !== "docker") {
      return UNAVAILABLE;
    }
    const [docker, socket] = await Promise.all([
      resolveTrustedDocker(opts?.fs),
      resolveSystemDockerSocket(opts?.fs),
    ]);
    if (docker === null || socket === null) {
      return UNAVAILABLE;
    }
    const helper = vettedHelperEnv();
    try {
      return await (opts?.execute ?? exec)([docker, ...cmd.slice(1)], {
        ...options,
        env: {
          ...helper.env,
          DOCKER_HOST: `unix://${socket}`,
          DOCKER_CONFIG: FROZEN_DOCKER_CONFIG,
        },
        unsetEnvKeys: [
          ...(options?.unsetEnvKeys ?? []),
          ...helper.unsetEnvKeys,
          ...ENGINE_SELECTORS,
        ],
      });
    } catch {
      return UNAVAILABLE;
    }
  };
}
