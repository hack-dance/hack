import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { isSlimExecutionMode } from "./execution-mode.ts";
import {
  isLinkedGitWorktree,
  listGitWorktrees,
  resolveGitPrimaryWorktreeRoot,
  resolveGitRepositoryIdentity,
  resolveGitWorktreeDir,
} from "./git-worktree.ts";
import { readProjectConfig } from "./project.ts";

export function shouldInheritPrimaryLocalInputs(): boolean {
  return !(
    isSlimExecutionMode() ||
    ["1", "true"].includes(process.env.CI ?? "") ||
    ["0", "false", "off", "no"].includes(
      (process.env.HACK_WORKTREE_INHERIT_LOCAL ?? "").trim().toLowerCase()
    )
  );
}

/** Verify the checkout roots and their shared Git administrative identity. */
async function resolveVerifiedPrimaryWorktreeRoot(opts: {
  readonly projectRoot: string;
}): Promise<string | null> {
  const checkoutRoot = await realpath(opts.projectRoot);
  const marker = await lstat(resolve(checkoutRoot, ".git")).catch(() => null);
  if (
    !(
      marker?.isFile() &&
      (await isLinkedGitWorktree({ repoRoot: checkoutRoot }))
    )
  ) {
    return null;
  }
  const gitOpts = { repoRoot: checkoutRoot };
  const commonDir = await resolveGitRepositoryIdentity(gitOpts);
  const gitDir = await resolveGitWorktreeDir(gitOpts);
  const primaryRoot = await resolveGitPrimaryWorktreeRoot(gitOpts);
  if (
    !(commonDir && gitDir && primaryRoot) ||
    basename(commonDir) !== ".git" ||
    dirname(gitDir) !== resolve(commonDir, "worktrees")
  ) {
    return null;
  }
  const primaryMarker = await lstat(resolve(primaryRoot, ".git")).catch(
    () => null
  );
  if (
    !primaryMarker?.isDirectory() ||
    (await realpath(primaryRoot)) !== primaryRoot ||
    (await resolveGitRepositoryIdentity({ repoRoot: primaryRoot })) !==
      commonDir ||
    (await resolveGitWorktreeDir({ repoRoot: primaryRoot })) !== commonDir
  ) {
    return null;
  }
  const entries = await listGitWorktrees(gitOpts);
  const roots = await Promise.all(
    (entries ?? []).map((entry) => realpath(entry.path).catch(() => null))
  );
  return roots.includes(checkoutRoot) && roots.includes(primaryRoot)
    ? primaryRoot
    : null;
}

/** Resolve only an existing, direct primary project directory, without writes. */
export async function resolvePrimaryLocalProjectDir(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<string | null> {
  if (!shouldInheritPrimaryLocalInputs()) {
    return null;
  }
  const name = basename(opts.projectDir);
  if (
    (name !== ".hack" && name !== ".dev") ||
    relative(opts.projectRoot, opts.projectDir) !== name
  ) {
    return null;
  }
  const primaryRoot = await resolveVerifiedPrimaryWorktreeRoot(opts);
  if (!primaryRoot) {
    return null;
  }
  const cfg = await readProjectConfig({
    ...opts,
    projectDirName: name,
    composeFile: resolve(opts.projectDir, "docker-compose.yml"),
    envFile: resolve(opts.projectDir, ".env"),
    configFile: resolve(opts.projectDir, "hack.config.json"),
  });
  if (cfg.parseError) {
    throw new Error("Cannot inherit local env with invalid project config");
  }
  if (cfg.worktree?.inheritLocal === false) {
    return null;
  }
  const candidate = resolve(primaryRoot, name);
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isDirectory() || (await realpath(candidate)) !== candidate) {
    return null;
  }
  return candidate;
}

/** Inherited files must be regular files with no symlink redirection. */
export async function validatePrimaryLocalFile(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  });
  if (info && (!info.isFile() || (await realpath(path)) !== resolve(path))) {
    throw new Error(
      `Refusing redirected or non-regular primary local env file: ${path}`
    );
  }
}
