import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { exec } from "./shell.ts";

async function tryRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function readGitPath(opts: {
  readonly repoRoot: string;
  readonly args: readonly string[];
}): Promise<string | null> {
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(["git", "-C", opts.repoRoot, ...opts.args], {
      stdin: "ignore",
    });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }

  const raw = result.stdout.trim();
  if (raw.length === 0) {
    return null;
  }

  const resolvedPath = isAbsolute(raw) ? raw : resolve(opts.repoRoot, raw);
  return await tryRealpath(resolvedPath);
}

/**
 * Resolves the current checkout's git dir.
 * Linked worktrees return their per-worktree git dir, not the shared common dir.
 */
export async function resolveGitWorktreeDir(opts: {
  readonly repoRoot: string;
}): Promise<string | null> {
  return await readGitPath({
    repoRoot: opts.repoRoot,
    args: ["rev-parse", "--path-format=absolute", "--git-dir"],
  });
}

/**
 * Resolves the shared git dir used by the current checkout family.
 * Linked worktrees of the same repo return the same path.
 */
export async function resolveGitRepositoryIdentity(opts: {
  readonly repoRoot: string;
}): Promise<string | null> {
  return await readGitPath({
    repoRoot: opts.repoRoot,
    args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  });
}

/**
 * Resolves the primary checkout root for a linked worktree when it can be inferred.
 */
export async function resolveGitPrimaryWorktreeRoot(opts: {
  readonly repoRoot: string;
}): Promise<string | null> {
  const commonDir = await resolveGitRepositoryIdentity({
    repoRoot: opts.repoRoot,
  });
  if (!commonDir) {
    return null;
  }

  return commonDir.endsWith("/.git") ? dirname(commonDir) : null;
}
