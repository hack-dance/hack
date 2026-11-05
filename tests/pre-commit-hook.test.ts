import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

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

function git(
  cwd: string,
  args: readonly string[]
): { exitCode: number; output: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: fixtureGitEnv(),
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

async function ownedTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-pre-commit-shim-"));
  owned.push(dir);
  return dir;
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

test.skipIf(process.getuid?.() === 0)(
  "the hook rejects the commit when it cannot write the formatted file back",
  async () => {
    const repo = await scratchRepo();
    const path = "src/read-only.ts";
    await Bun.write(join(repo, path), UNFORMATTED);
    mustGit(repo, ["add", "--all"]);
    await chmod(join(repo, path), 0o444);

    const commit = git(repo, ["commit", "--quiet", "-m", "test: read-only"]);
    expect(commit.exitCode).not.toBe(0);
    expect(
      git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).exitCode
    ).not.toBe(0);
    expect(await Bun.file(join(repo, path)).text()).toBe(UNFORMATTED);
  }
);

/** Single-quotes a value for a POSIX shell script. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * A `node_modules` for worktree B whose `.bin/biome` is a shim (HACK-1769).
 * Every other entry links to the checkout's install, so configs still resolve
 * `ultracite`. The first time the hook runs Biome, the shim has the other
 * worktree push its own stash entry, then runs the real Biome. That is the
 * interleaving that let the old hook's `stash pop` take another worktree's
 * entry. The concurrent command runs with the fixture environment only, not
 * the hook's `GIT_DIR`/`GIT_INDEX_FILE`.
 */
async function biomeShimInstall(options: {
  readonly scratch: string;
  readonly otherWorktree: string;
  readonly concurrentArgs: readonly string[];
}): Promise<string> {
  const realGit = Bun.which("git");
  if (!realGit) {
    throw new Error("git is not on PATH");
  }
  const install = join(options.scratch, "node_modules");
  const marker = join(options.scratch, "concurrent-ran");
  await mkdir(join(install, ".bin"), { recursive: true });
  for (const entry of await readdir(join(root, "node_modules"))) {
    if (entry !== ".bin") {
      await symlink(join(root, "node_modules", entry), join(install, entry));
    }
  }
  const fixtureEnv = Object.entries(fixtureGitEnv())
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(" ");
  const concurrent = [
    realGit,
    "-C",
    options.otherWorktree,
    ...options.concurrentArgs,
  ]
    .map(shQuote)
    .join(" ");
  await Bun.write(
    join(install, ".bin/biome"),
    `#!/bin/sh
if [ ! -e ${shQuote(marker)} ]; then
  : >${shQuote(marker)}
  env -i ${fixtureEnv} ${concurrent} >/dev/null 2>&1
fi
exec ${shQuote(join(root, "node_modules/.bin/biome"))} "$@"
`
  );
  await chmod(join(install, ".bin/biome"), 0o755);
  return install;
}

function stashEntries(cwd: string): string {
  return mustGit(cwd, ["stash", "list", "--format=%H %gs"]);
}

test("the hook leaves the shared stash stack and another worktree's changes alone", async () => {
  const repo = await scratchRepo();
  await Bun.write(join(repo, "src/shared.ts"), FORMATTED);
  await Bun.write(join(repo, "src/other.ts"), FORMATTED);
  mustGit(repo, ["add", "--all"]);
  mustGit(repo, ["commit", "--quiet", "--no-verify", "-m", "test: base"]);

  // Worktree A (the main checkout) owns a stash entry and unstaged changes.
  await Bun.write(join(repo, "src/shared.ts"), "export const stashed = 1;\n");
  mustGit(repo, ["stash", "push", "--quiet", "-m", "worktree-a-entry"]);
  const aShared = "export const concurrent = 2;\n";
  const aOther = "export const keep = 3;\n";
  await Bun.write(join(repo, "src/shared.ts"), aShared);
  await Bun.write(join(repo, "src/other.ts"), aOther);
  const before = stashEntries(repo);
  expect(before).toContain("worktree-a-entry");

  // Worktree B stages unformatted content and keeps different unstaged edits
  // in the same file, the case where the old hook ran `git stash push`.
  const worktree = join(repo, "..", `${basename(repo)}-b`);
  owned.push(worktree);
  mustGit(repo, ["worktree", "add", "--quiet", "-b", "b", worktree]);
  await Bun.write(join(worktree, "src/b.ts"), UNFORMATTED);
  mustGit(worktree, ["add", "src/b.ts"]);
  const bUnstaged = `${UNFORMATTED}export const   unstaged =  2\n`;
  await Bun.write(join(worktree, "src/b.ts"), bUnstaged);

  const scratch = await ownedTempDir();
  const install = await biomeShimInstall({
    scratch,
    otherWorktree: repo,
    concurrentArgs: [
      "stash",
      "push",
      "--quiet",
      "-m",
      "worktree-a-concurrent",
      "--",
      "src/shared.ts",
    ],
  });
  await symlink(install, join(worktree, "node_modules"));
  const trace = join(scratch, "git-trace.log");
  const commit = Bun.spawnSync(
    ["git", "commit", "--quiet", "-m", "test: worktree b"],
    {
      cwd: worktree,
      env: fixtureGitEnv({ gitEnv: { GIT_TRACE: trace } }),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const output = `${commit.stdout.toString()}${commit.stderr.toString()}`;
  expect(output).not.toContain("stash");
  expect(commit.exitCode).toBe(0);

  // Both of worktree A's entries are on the stack, untouched, and its other
  // unstaged change is still in its working tree.
  const after = stashEntries(repo);
  expect(after).toContain("worktree-a-concurrent");
  expect(after.endsWith(before)).toBe(true);
  expect(mustGit(repo, ["stash", "show", "-p", "stash@{0}"])).toContain(
    "concurrent = 2"
  );
  expect(await Bun.file(join(repo, "src/other.ts")).text()).toBe(aOther);
  expect(await Bun.file(join(repo, "src/shared.ts")).text()).toBe(FORMATTED);

  // Worktree B committed the formatted staged snapshot, kept its own unstaged
  // edit, and received nothing from worktree A.
  expect(mustGit(worktree, ["show", "HEAD:src/b.ts"])).toBe(FORMATTED);
  expect(await Bun.file(join(worktree, "src/b.ts")).text()).toBe(bUnstaged);
  expect(await Bun.file(join(worktree, "src/shared.ts")).text()).toBe(
    FORMATTED
  );
  expect(mustGit(worktree, ["status", "--porcelain"])).toBe(" M src/b.ts\n");

  // The hook never ran `git stash`. The concurrent push runs without
  // GIT_TRACE, so the trace holds only this commit and its hook.
  const traced = (await Bun.file(trace).text()).split("\n");
  expect(traced.some((line) => line.includes("built-in: git add"))).toBe(true);
  expect(traced.filter((line) => line.includes("git stash"))).toEqual([]);
});

test("the hook formats the temporary index of `git commit <path>`", async () => {
  const repo = await scratchRepo();
  await Bun.write(join(repo, "src/a.ts"), FORMATTED);
  await Bun.write(join(repo, "src/b.ts"), FORMATTED);
  mustGit(repo, ["add", "--all"]);
  mustGit(repo, ["commit", "--quiet", "--no-verify", "-m", "test: base"]);

  await Bun.write(join(repo, "src/a.ts"), UNFORMATTED);
  await Bun.write(join(repo, "src/b.ts"), UNFORMATTED);
  const commit = git(repo, ["commit", "--quiet", "-m", "test: a", "src/a.ts"]);
  expect(commit.exitCode).toBe(0);

  expect(mustGit(repo, ["show", "HEAD:src/a.ts"])).toBe(FORMATTED);
  expect(await Bun.file(join(repo, "src/a.ts")).text()).toBe(FORMATTED);
  expect(await Bun.file(join(repo, "src/b.ts")).text()).toBe(UNFORMATTED);
  expect(mustGit(repo, ["show", "HEAD:src/b.ts"])).toBe(FORMATTED);
  expect(stashEntries(repo)).toBe("");
});
