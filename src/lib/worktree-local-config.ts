import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { isSlimExecutionMode } from "./execution-mode.ts";
import { listGitWorktrees } from "./git-worktree.ts";
import { readProjectConfig } from "./project.ts";
import { exec } from "./shell.ts";

export function shouldInheritPrimaryLocalInputs(): boolean {
  return !(
    isSlimExecutionMode() ||
    ["1", "true"].includes(process.env.CI ?? "") ||
    ["0", "false", "off", "no"].includes(
      (process.env.HACK_WORKTREE_INHERIT_LOCAL ?? "").trim().toLowerCase()
    )
  );
}

type GitCheckoutDirs = {
  readonly commonDir: string;
  readonly gitDir: string;
};

/** One rev-parse per checkout yields both identity paths (common dir, git dir). */
async function readGitCheckoutDirs(opts: {
  readonly repoRoot: string;
}): Promise<GitCheckoutDirs | null> {
  const result = await exec(
    [
      "git",
      "-C",
      opts.repoRoot,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
    ],
    { stdin: "ignore" }
  ).catch(() => null);
  const [commonRaw, gitRaw] = (result?.exitCode === 0 ? result.stdout : "")
    .split("\n")
    .map((line) => line.trim());
  if (!(commonRaw && gitRaw)) {
    return null;
  }
  const toReal = (raw: string) =>
    realpath(resolve(opts.repoRoot, raw)).catch(() => null);
  const [commonDir, gitDir] = await Promise.all([
    toReal(commonRaw),
    toReal(gitRaw),
  ]);
  return commonDir && gitDir ? { commonDir, gitDir } : null;
}

/** Verify the checkout roots and their shared Git administrative identity. */
async function resolveVerifiedPrimaryWorktreeRoot(opts: {
  readonly projectRoot: string;
}): Promise<string | null> {
  const checkoutRoot = await realpath(opts.projectRoot);
  const marker = await lstat(resolve(checkoutRoot, ".git")).catch(() => null);
  if (!marker?.isFile()) {
    return null;
  }
  const checkout = await readGitCheckoutDirs({ repoRoot: checkoutRoot });
  if (
    !checkout ||
    checkout.commonDir === checkout.gitDir ||
    basename(checkout.commonDir) !== ".git" ||
    dirname(checkout.gitDir) !== resolve(checkout.commonDir, "worktrees")
  ) {
    return null;
  }
  const primaryRoot = dirname(checkout.commonDir);
  const primaryMarker = await lstat(resolve(primaryRoot, ".git")).catch(
    () => null
  );
  if (
    !primaryMarker?.isDirectory() ||
    (await realpath(primaryRoot)) !== primaryRoot
  ) {
    return null;
  }
  const [primary, entries] = await Promise.all([
    readGitCheckoutDirs({ repoRoot: primaryRoot }),
    listGitWorktrees({ repoRoot: checkoutRoot }),
  ]);
  if (
    primary?.commonDir !== checkout.commonDir ||
    primary.gitDir !== checkout.commonDir
  ) {
    return null;
  }
  const roots = await Promise.all(
    (entries ?? []).map((entry) => realpath(entry.path).catch(() => null))
  );
  return roots.includes(checkoutRoot) && roots.includes(primaryRoot)
    ? primaryRoot
    : null;
}

/**
 * Resolve only an existing, direct primary project directory, without writes.
 * Every opt-out (env, CI, slim mode, project config) is checked before any Git
 * subprocess runs; verification then costs three Git calls.
 */
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
  const cfg = await readProjectConfig({
    ...opts,
    projectDirName: name,
    composeFile: resolve(opts.projectDir, "docker-compose.yml"),
    envFile: resolve(opts.projectDir, ".env"),
    configFile: resolve(opts.projectDir, "hack.config.json"),
  });
  if (cfg.worktree?.inheritLocal === false) {
    return null;
  }
  const primaryRoot = await resolveVerifiedPrimaryWorktreeRoot(opts);
  if (!primaryRoot) {
    return null;
  }
  // An unreadable config hides any opt-out, so a linked worktree fails closed.
  if (cfg.parseError) {
    throw new Error("Cannot inherit local env with invalid project config");
  }
  const candidate = resolve(primaryRoot, name);
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isDirectory() || (await realpath(candidate)) !== candidate) {
    return null;
  }
  return candidate;
}

/** Whether the primary checkout holds any local overlay this checkout could inherit. */
export async function hasPrimaryLocalInputs(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const primaryDir = await resolvePrimaryLocalProjectDir(opts);
  if (primaryDir === null) {
    return false;
  }
  const entries = await readdir(primaryDir, { withFileTypes: true });
  return entries.some(
    (entry) =>
      entry.isFile() &&
      (entry.name === "hack.env.local.yaml" ||
        (entry.name.startsWith("hack.env.") &&
          entry.name.endsWith(".local.yaml")))
  );
}

/** Read an inherited file; only a missing file is skipped, other errors fail closed. */
export async function readPrimaryLocalFile(
  path: string
): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null;
    }
    throw new Error(`Cannot read primary local env file: ${path}`);
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Inherited files must be regular files with no symlink redirection. */
export async function validatePrimaryLocalFile(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isEnoent(error)) {
      return null;
    }
    throw new Error(`Cannot inspect primary local env file: ${path}`);
  });
  if (info && (!info.isFile() || (await realpath(path)) !== resolve(path))) {
    throw new Error(
      `Refusing redirected or non-regular primary local env file: ${path}`
    );
  }
}
