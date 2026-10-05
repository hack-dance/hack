import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { exec } from "./shell.ts";

const SIMPLE_QUOTED_BRANCH = /^'refs\/heads\/([^'"\s\\]+)' $/;

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

/**
 * Detects whether the checkout at `repoRoot` is a linked git worktree
 * (its per-worktree git dir differs from the shared common dir).
 * Returns null when git is unavailable or the path is not a git checkout.
 */
export async function isLinkedGitWorktree(opts: {
  readonly repoRoot: string;
}): Promise<boolean | null> {
  const [commonDir, worktreeDir] = await Promise.all([
    resolveGitRepositoryIdentity({ repoRoot: opts.repoRoot }),
    resolveGitWorktreeDir({ repoRoot: opts.repoRoot }),
  ]);
  if (!(commonDir && worktreeDir)) {
    return null;
  }
  return commonDir !== worktreeDir;
}

/**
 * Resolves the currently checked-out branch name for the checkout at `repoRoot`.
 * Returns null for detached HEAD, non-git paths, or when git is unavailable.
 */
export async function resolveGitCurrentBranch(opts: {
  readonly repoRoot: string;
}): Promise<string | null> {
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      ["git", "-C", opts.repoRoot, "branch", "--show-current"],
      { stdin: "ignore" }
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

/**
 * Resolves registration metadata with one Git child for ordinary checkouts.
 * Unborn HEAD emits only identity and uses the existing branch lookup, keeping
 * its two-child cost. Git remains authoritative for escaped or unusual refs.
 */
export async function resolveGitRegistrationMetadata(opts: {
  readonly repoRoot: string;
}): Promise<{
  readonly repoIdentity: string | null;
  readonly gitBranch: string | null;
}> {
  let result: Awaited<ReturnType<typeof exec>> | null = null;
  try {
    result = await exec(
      [
        "git",
        "-C",
        opts.repoRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--sq",
        "--symbolic-full-name",
        "--revs-only",
        "HEAD",
      ],
      { stdin: "ignore" }
    );
  } catch {
    // Fall back independently: identity and branch failures have separate meaning.
  }
  const parsed =
    result?.exitCode === 0 ? parseRegistrationMetadata(result.stdout) : null;
  if (parsed) {
    return {
      repoIdentity: await tryRealpath(parsed.repoIdentity),
      gitBranch:
        parsed.gitBranch === undefined
          ? await resolveGitCurrentBranch(opts)
          : parsed.gitBranch,
    };
  }
  return {
    repoIdentity: await resolveGitRepositoryIdentity(opts),
    gitBranch: await resolveGitCurrentBranch(opts),
  };
}

function parseRegistrationMetadata(stdout: string): {
  readonly repoIdentity: string;
  readonly gitBranch: string | null | undefined;
} | null {
  // --sq applies only after --git-common-dir. The raw path ends in LF; the
  // optional quoted ref does not. Split at the last LF to preserve newline paths.
  const separator = stdout.lastIndexOf("\n");
  if (separator < 1 || stdout.includes("\0")) {
    return null;
  }
  const repoIdentity = stdout.slice(0, separator);
  const ref = stdout.slice(separator + 1);
  if (
    !isAbsolute(repoIdentity) ||
    (ref !== "" && !(ref.startsWith("'") && ref.endsWith("' ")))
  ) {
    return null;
  }
  const simpleBranch = SIMPLE_QUOTED_BRANCH.exec(ref)?.[1];
  return {
    repoIdentity,
    gitBranch: ref === "'HEAD' " ? null : simpleBranch,
  };
}

export type GitWorktreeListEntry = {
  readonly path: string;
  readonly branch: string | null;
  readonly detached: boolean;
};

/**
 * Lists all checkouts (primary + linked worktrees) of the repo family that
 * contains `repoRoot` via `git worktree list --porcelain`.
 * Returns null when git is unavailable or the path is not a git checkout.
 */
export async function listGitWorktrees(opts: {
  readonly repoRoot: string;
}): Promise<readonly GitWorktreeListEntry[] | null> {
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      ["git", "-C", opts.repoRoot, "worktree", "list", "--porcelain"],
      { stdin: "ignore" }
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  return parseGitWorktreeListPorcelain(result.stdout);
}

function parseGitWorktreeListPorcelain(
  stdout: string
): readonly GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let detached = false;

  const flush = () => {
    if (path) {
      entries.push({ path, branch, detached });
    }
    path = null;
    branch = null;
    detached = false;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const prefix = "refs/heads/";
      branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      continue;
    }
    if (line === "detached") {
      detached = true;
    }
  }
  flush();

  return entries;
}
