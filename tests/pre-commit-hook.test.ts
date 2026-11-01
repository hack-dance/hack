import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The repository pre-commit hook formats staged files with Biome (HACK-1665).
 *
 * Ultracite 7's `fix` shell-quoted every path and then ran Biome through a
 * shell, so a Next.js route such as `site/app/docs/[[...slug]]/page.tsx`
 * reached Biome with literal quotes and was never formatted. These tests run
 * the real hook through a real `git commit` in a scratch repository that uses
 * the checkout's Biome install and configs, and check the committed content.
 */

const root = resolve(import.meta.dir, "..");
const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

/** Git environment without inherited repository, hook or user configuration. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function git(
  cwd: string,
  args: readonly string[]
): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function mustGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }
  return result.output;
}

/** A scratch repository wired to the checkout's hook, Biome configs and install. */
async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "hack-pre-commit-"));
  owned.push(repo);
  for (const file of [".husky/pre-commit", "biome.jsonc", "site/biome.jsonc"]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await copyFile(join(root, file), join(repo, file));
  }
  // The tracked hook is not executable; Husky's wrapper runs it with `sh`.
  await chmod(join(repo, ".husky/pre-commit"), 0o755);
  await symlink(join(root, "node_modules"), join(repo, "node_modules"));
  await Bun.write(join(repo, ".gitignore"), "node_modules\n");
  mustGit(repo, ["init", "--quiet"]);
  mustGit(repo, ["config", "user.name", "Hook Test"]);
  mustGit(repo, ["config", "user.email", "hook-test@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
  mustGit(repo, ["config", "core.hooksPath", ".husky"]);
  return repo;
}

const UNFORMATTED = "export const   value =  1\n";
const FORMATTED = "export const value = 1;\n";

test("the hook formats staged paths with brackets, spaces and quotes and commits them", async () => {
  const repo = await scratchRepo();
  const paths = [
    "site/app/docs/[[...slug]]/page.tsx",
    "site/app/[id]/page.tsx",
    "site/app/release notes/page.tsx",
    "src/it's here.ts",
  ];
  for (const path of paths) {
    await Bun.write(join(repo, path), UNFORMATTED);
  }
  mustGit(repo, ["add", "--all"]);

  const commit = git(repo, ["commit", "--quiet", "-m", "test: bracket paths"]);
  expect(commit.output).not.toContain("internalError/io");
  expect(commit.exitCode).toBe(0);

  for (const path of paths) {
    expect(mustGit(repo, ["show", `HEAD:${path}`])).toBe(FORMATTED);
    expect(await Bun.file(join(repo, path)).text()).toBe(FORMATTED);
  }
  expect(mustGit(repo, ["status", "--porcelain"])).toBe("");
});

test("the hook rejects the commit when Biome reports an error it cannot fix", async () => {
  const repo = await scratchRepo();
  const path = "site/app/docs/[[...slug]]/page.tsx";
  await Bun.write(join(repo, path), 'export const value = eval("1");\n');
  mustGit(repo, ["add", "--all"]);

  const commit = git(repo, ["commit", "--quiet", "-m", "test: lint error"]);
  expect(commit.exitCode).not.toBe(0);
  expect(commit.output).toContain("noGlobalEval");
  expect(
    git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).exitCode
  ).not.toBe(0);
});
