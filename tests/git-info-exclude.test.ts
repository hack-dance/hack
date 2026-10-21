import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureHackGitInfoExclude,
  renderHackGitInfoExcludeBlock,
  resetHackGitInfoExcludeCacheForTests,
} from "../src/lib/git-info-exclude.ts";

let root: string;
let repo: string;

async function git(args: readonly string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

beforeEach(async () => {
  resetHackGitInfoExcludeCacheForTests();
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-info-exclude-")));
  repo = join(root, "repo");
  await mkdir(join(repo, ".hack"), { recursive: true });
  await git(["init", "-q", "-b", "main"], repo);
});

afterEach(async () => {
  resetHackGitInfoExcludeCacheForTests();
  await rm(root, { recursive: true, force: true });
});

test("renders root-anchored entries with glob characters in the prefix escaped", () => {
  const block = renderHackGitInfoExcludeBlock({ prefix: "a[b]*?\\c/.hack/" });
  expect(block?.entries[0]).toBe("/a\\[b\\]\\*\\?\\\\c/.hack/.internal/");
  expect(block?.beginMarker).toContain("/a[b]*?\\c/.hack/");
  expect(renderHackGitInfoExcludeBlock({ prefix: "" })).toBeNull();
  expect(renderHackGitInfoExcludeBlock({ prefix: "a\nb/.hack/" })).toBeNull();
});

test("adds one block per project dir, keeps user lines and is idempotent", async () => {
  const exclude = join(repo, ".git", "info", "exclude");
  await writeFile(exclude, "# user rule\n*.log\n");
  await mkdir(join(repo, "apps", "api", ".hack"), { recursive: true });

  await ensureHackGitInfoExclude({ projectDir: join(repo, ".hack") });
  await ensureHackGitInfoExclude({
    projectDir: join(repo, "apps", "api", ".hack"),
  });
  const first = await readFile(exclude, "utf8");
  expect(first.startsWith("# user rule\n*.log\n")).toBe(true);
  expect(first).toContain("\n/.hack/.internal/\n");
  expect(first).toContain("\n/apps/api/.hack/.internal/\n");

  resetHackGitInfoExcludeCacheForTests();
  await ensureHackGitInfoExclude({ projectDir: join(repo, ".hack") });
  await ensureHackGitInfoExclude({
    projectDir: join(repo, "apps", "api", ".hack"),
  });
  expect(await readFile(exclude, "utf8")).toBe(first);
});

test("leaves a symlinked exclude file and its target alone", async () => {
  const exclude = join(repo, ".git", "info", "exclude");
  const target = join(root, "elsewhere");
  await writeFile(target, "outside\n");
  await rm(exclude, { force: true });
  await symlink(target, exclude);

  await ensureHackGitInfoExclude({ projectDir: join(repo, ".hack") });

  expect((await lstat(exclude)).isSymbolicLink()).toBe(true);
  expect(await readlink(exclude)).toBe(target);
  expect(await readFile(target, "utf8")).toBe("outside\n");
});

test("is a silent no-op outside a git repository", async () => {
  const plain = join(root, "plain", ".hack");
  await mkdir(plain, { recursive: true });
  await ensureHackGitInfoExclude({ projectDir: plain });
  expect(await lstat(join(plain, ".gitignore")).catch(() => null)).toBeNull();
});
