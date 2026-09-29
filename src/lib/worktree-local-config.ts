import { realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { isSlimExecutionMode } from "./execution-mode.ts";
import {
  isLinkedGitWorktree,
  resolveGitPrimaryWorktreeRoot,
} from "./git-worktree.ts";
import { readProjectConfig } from "./project.ts";

/** Resolve only the matching primary configuration directory; never copy state. */
export async function resolvePrimaryLocalProjectDir(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<string | null> {
  if (isSlimExecutionMode() || ["1", "true"].includes(process.env.CI ?? "")) {
    return null;
  }
  const name = basename(opts.projectDir);
  if (
    ![".hack", ".dev"].includes(name) ||
    relative(opts.projectRoot, opts.projectDir) !== name
  ) {
    return null;
  }
  const cfg = await readProjectConfig({
    ...opts,
    projectDirName: name === ".dev" ? ".dev" : ".hack",
    composeFile: resolve(opts.projectDir, "docker-compose.yml"),
    envFile: resolve(opts.projectDir, ".env"),
    configFile: resolve(opts.projectDir, "hack.config.json"),
  });
  if (cfg.parseError) {
    throw new Error(
      "Cannot inherit worktree configuration with invalid project config"
    );
  }
  if (
    cfg.worktree?.inheritLocal === false ||
    !(await isLinkedGitWorktree({ repoRoot: opts.projectRoot }))
  ) {
    return null;
  }
  const primary = await resolveGitPrimaryWorktreeRoot({
    repoRoot: opts.projectRoot,
  });
  if (!primary || resolve(primary) === resolve(opts.projectRoot)) {
    return null;
  }
  const candidate = resolve(primary, name);
  try {
    // A symlinked primary configuration must not redirect inheritance elsewhere.
    if (
      (await realpath(candidate)) !== resolve(await realpath(primary), name)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/** Inherited inputs may not redirect through a file or nested-directory symlink. */
export async function validatePrimaryLocalFile(path: string): Promise<void> {
  try {
    if ((await realpath(path)) !== resolve(path)) {
      throw new Error("Refusing redirected primary local configuration");
    }
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
