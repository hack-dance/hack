import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { readTextFile } from "./fs.ts";
import { listGitWorktrees } from "./git-worktree.ts";
import {
  resolveProjectEnvKeyPath,
  resolveProjectEnvSharedKeyLocation,
} from "./project-env-config.ts";
import type { RuntimeProject } from "./runtime-projects.ts";

export type WorktreeCheckoutKeyStatus = {
  /** Checkout root (primary or linked worktree). */
  readonly path: string;
  readonly branch: string | null;
  /** Checkout-local `.hack.secret.key` path for this checkout. */
  readonly keyPath: string;
  /** Short content digest, or null when the checkout has no local key. */
  readonly keyDigest: string | null;
};

export type WorktreeSecretKeyInspection = {
  readonly checkouts: readonly WorktreeCheckoutKeyStatus[];
  readonly sharedKeyPath: string | null;
  readonly sharedKeyDigest: string | null;
  /** True when more than one distinct key exists across checkouts + shared location. */
  readonly divergent: boolean;
  /** Key paths that participate in the divergence (present keys only). */
  readonly divergentKeyPaths: readonly string[];
};

/**
 * Compares `.hack.secret.key` contents across every checkout of the repo
 * family (via `git worktree list --porcelain`) plus the shared key at the git
 * common dir. Returns null when git is unavailable or the path is not a git
 * checkout.
 */
export async function inspectWorktreeSecretKeys(opts: {
  readonly projectRoot: string;
}): Promise<WorktreeSecretKeyInspection | null> {
  const worktrees = await listGitWorktrees({ repoRoot: opts.projectRoot });
  if (worktrees === null) {
    return null;
  }

  const sharedLocation = await resolveProjectEnvSharedKeyLocation({
    projectRoot: opts.projectRoot,
  });
  const sharedKeyPath = sharedLocation?.path ?? null;
  const sharedKeyDigest =
    sharedKeyPath === null
      ? null
      : await digestKeyFile({ path: sharedKeyPath });

  const checkouts: WorktreeCheckoutKeyStatus[] = [];
  for (const worktree of worktrees) {
    const keyPath = resolveProjectEnvKeyPath({ projectRoot: worktree.path });
    checkouts.push({
      path: worktree.path,
      branch: worktree.branch,
      keyPath,
      keyDigest: await digestKeyFile({ path: keyPath }),
    });
  }

  const byDigest = new Map<string, string[]>();
  for (const checkout of checkouts) {
    if (checkout.keyDigest !== null) {
      const paths = byDigest.get(checkout.keyDigest) ?? [];
      paths.push(checkout.keyPath);
      byDigest.set(checkout.keyDigest, paths);
    }
  }
  if (sharedKeyDigest !== null && sharedKeyPath !== null) {
    const paths = byDigest.get(sharedKeyDigest) ?? [];
    paths.push(sharedKeyPath);
    byDigest.set(sharedKeyDigest, paths);
  }

  const divergent = byDigest.size > 1;
  const divergentKeyPaths = divergent
    ? [...byDigest.values()].flat().sort((a, b) => a.localeCompare(b))
    : [];

  return {
    checkouts,
    sharedKeyPath,
    sharedKeyDigest,
    divergent,
    divergentKeyPaths,
  };
}

export type CrossCheckoutInstance = {
  readonly composeProject: string;
  /** Branch slug parsed from a `<base>--<branch>` compose project name, or null for the base instance. */
  readonly branch: string | null;
  readonly workingDir: string | null;
  readonly running: boolean;
};

/**
 * Finds compose instances of the same project family (base name and
 * `<base>--<branch>` variants) that were started from a checkout other than
 * `currentProjectDir`. A running base instance from another checkout claims
 * the same routed dev_host this checkout would claim on `hack up`.
 */
export function findCrossCheckoutInstances(opts: {
  readonly baseProjectName: string;
  readonly currentProjectDir: string;
  readonly runtime: readonly RuntimeProject[];
}): readonly CrossCheckoutInstance[] {
  const base = opts.baseProjectName;
  const currentDir = canonicalPath(opts.currentProjectDir);

  const out: CrossCheckoutInstance[] = [];
  for (const project of opts.runtime) {
    const branch = parseFamilyBranch({ name: project.project, base });
    if (branch === undefined) {
      continue;
    }
    const workingDir = project.workingDir;
    if (workingDir !== null && canonicalPath(workingDir) === currentDir) {
      continue;
    }
    out.push({
      composeProject: project.project,
      branch,
      workingDir,
      running: hasRunningContainer(project),
    });
  }
  return out;
}

/**
 * Returns the branch slug for `<base>--<branch>` names, null for the exact
 * base name, and undefined when the compose project is not in the family.
 */
function parseFamilyBranch(opts: {
  readonly name: string;
  readonly base: string;
}): string | null | undefined {
  if (opts.name === opts.base) {
    return null;
  }
  const prefix = `${opts.base}--`;
  if (opts.name.startsWith(prefix)) {
    const branch = opts.name.slice(prefix.length);
    return branch.length > 0 ? branch : undefined;
  }
  return undefined;
}

function hasRunningContainer(project: RuntimeProject): boolean {
  for (const service of project.services.values()) {
    if (service.containers.some((container) => container.state === "running")) {
      return true;
    }
  }
  return false;
}

async function digestKeyFile(opts: {
  readonly path: string;
}): Promise<string | null> {
  const text = await readTextFile(opts.path);
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return createHash("sha256")
    .update(trimmed, "utf8")
    .digest("hex")
    .slice(0, 12);
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
