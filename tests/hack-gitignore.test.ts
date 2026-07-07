import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureManagedGitignoreBlock } from "../src/lib/fs.ts";
import { ensureHackDirGitignore } from "../src/lib/project-env-config.ts";
import {
  HACK_DIR_GITIGNORE_BEGIN_MARKER,
  HACK_DIR_GITIGNORE_END_MARKER,
  HACK_DIR_GITIGNORE_ENTRIES,
} from "../src/templates.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-gitignore-"));
  tempDirs.add(dir);
  return dir;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await runGit(["init", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "Hack Test"], repoRoot);
  await runGit(["config", "user.email", "hack@example.com"], repoRoot);
}

async function gitCheckIgnore(opts: {
  readonly repoRoot: string;
  readonly path: string;
}): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["git", "check-ignore", "-q", "--", opts.path],
    cwd: opts.repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

const BLOCK_OPTS = {
  beginMarker: "# >>> managed",
  endMarker: "# <<< managed",
  entries: ["one", "two"],
} as const;

test("ensureManagedGitignoreBlock creates the file with just the managed block", async () => {
  const dir = await createTempDir();
  const path = resolve(dir, ".gitignore");

  const first = await ensureManagedGitignoreBlock({
    gitignorePath: path,
    ...BLOCK_OPTS,
  });
  expect(first.changed).toBe(true);
  expect(await readFile(path, "utf8")).toBe(
    "# >>> managed\none\ntwo\n# <<< managed\n"
  );

  const second = await ensureManagedGitignoreBlock({
    gitignorePath: path,
    ...BLOCK_OPTS,
  });
  expect(second.changed).toBe(false);
  expect(await readFile(path, "utf8")).toBe(
    "# >>> managed\none\ntwo\n# <<< managed\n"
  );
});

test("ensureManagedGitignoreBlock preserves user lines outside the markers", async () => {
  const dir = await createTempDir();
  const path = resolve(dir, ".gitignore");
  await writeFile(
    path,
    "# user header\ncustom-before\n# >>> managed\nstale-entry\n# <<< managed\ncustom-after\n"
  );

  const result = await ensureManagedGitignoreBlock({
    gitignorePath: path,
    ...BLOCK_OPTS,
  });
  expect(result.changed).toBe(true);
  expect(await readFile(path, "utf8")).toBe(
    "# user header\ncustom-before\n# >>> managed\none\ntwo\n# <<< managed\ncustom-after\n"
  );
});

test("ensureManagedGitignoreBlock appends the block to marker-less user files", async () => {
  const dir = await createTempDir();
  const path = resolve(dir, ".gitignore");
  await writeFile(path, "custom-entry\n");

  await ensureManagedGitignoreBlock({ gitignorePath: path, ...BLOCK_OPTS });
  expect(await readFile(path, "utf8")).toBe(
    "custom-entry\n\n# >>> managed\none\ntwo\n# <<< managed\n"
  );
});

test("ensureManagedGitignoreBlock repairs a block with a missing end marker", async () => {
  const dir = await createTempDir();
  const path = resolve(dir, ".gitignore");
  await writeFile(path, "custom-before\n# >>> managed\nstale-entry\n");

  await ensureManagedGitignoreBlock({ gitignorePath: path, ...BLOCK_OPTS });
  expect(await readFile(path, "utf8")).toBe(
    "custom-before\n# >>> managed\none\ntwo\n# <<< managed\n"
  );
});

test("ensureHackDirGitignore writes the canonical managed entries", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");

  const first = await ensureHackDirGitignore({ projectDir });
  expect(first.changed).toBe(true);

  const text = await readFile(resolve(projectDir, ".gitignore"), "utf8");
  expect(text).toContain(HACK_DIR_GITIGNORE_BEGIN_MARKER);
  expect(text).toContain(HACK_DIR_GITIGNORE_END_MARKER);
  for (const entry of HACK_DIR_GITIGNORE_ENTRIES) {
    expect(text).toContain(entry);
  }

  const second = await ensureHackDirGitignore({ projectDir });
  expect(second.changed).toBe(false);
});

test("ensureHackDirGitignore keeps user additions across reruns", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await ensureHackDirGitignore({ projectDir });

  const path = resolve(projectDir, ".gitignore");
  await writeFile(path, `${await readFile(path, "utf8")}my-custom-ignore\n`);

  await ensureHackDirGitignore({ projectDir });
  const text = await readFile(path, "utf8");
  expect(text).toContain("my-custom-ignore");
  expect(text).toContain(HACK_DIR_GITIGNORE_END_MARKER);
});

test("nested .hack/.gitignore makes git ignore generated files, including in linked worktrees", async () => {
  const dir = await createTempDir();
  const sourceRoot = resolve(dir, "source");
  await mkdir(resolve(sourceRoot, ".hack"), { recursive: true });
  await initGitRepo(sourceRoot);
  await writeFile(resolve(sourceRoot, "README.md"), "fixture\n");
  await writeFile(
    resolve(sourceRoot, ".hack", "docker-compose.yml"),
    "services:\n  api: {}\n"
  );
  await ensureHackDirGitignore({ projectDir: resolve(sourceRoot, ".hack") });
  await runGit(["add", "."], sourceRoot);
  await runGit(["commit", "-m", "init"], sourceRoot);

  for (const path of [
    ".hack/.internal/compose.override.yml",
    ".hack/.branch/compose.x.override.yml",
    ".hack/.env",
    ".hack/.env.state.json",
    ".hack/hack.env.local.yaml",
    ".hack/hack.env.qa.local.yaml",
  ]) {
    expect(
      await gitCheckIgnore({ repoRoot: sourceRoot, path }),
      `expected ${path} to be ignored in the primary checkout`
    ).toBe(true);
  }

  // A linked worktree inherits the rules because the file is committed.
  const linkedRoot = resolve(dir, "linked");
  await runGit(["worktree", "add", linkedRoot], sourceRoot);
  for (const path of [
    ".hack/.internal/compose.override.yml",
    ".hack/.branch/compose.x.override.yml",
    ".hack/.env.state.json",
    ".hack/hack.env.qa.local.yaml",
  ]) {
    expect(
      await gitCheckIgnore({ repoRoot: linkedRoot, path }),
      `expected ${path} to be ignored in the linked worktree`
    ).toBe(true);
  }
});

test("legacy root .gitignore .hack/.internal/ entry coexists with the nested file", async () => {
  const dir = await createTempDir();
  const repoRoot = resolve(dir, "legacy");
  await mkdir(resolve(repoRoot, ".hack"), { recursive: true });
  await initGitRepo(repoRoot);
  await writeFile(
    resolve(repoRoot, ".gitignore"),
    "# hack internal (local overrides)\n.hack/.internal/\n"
  );
  await writeFile(
    resolve(repoRoot, ".hack", "docker-compose.yml"),
    "services:\n  api: {}\n"
  );
  await ensureHackDirGitignore({ projectDir: resolve(repoRoot, ".hack") });
  await runGit(["add", "."], repoRoot);
  await runGit(["commit", "-m", "init"], repoRoot);

  // Root entry stays untouched; both rules resolve to the same result.
  const rootIgnore = await readFile(resolve(repoRoot, ".gitignore"), "utf8");
  expect(rootIgnore).toContain(".hack/.internal/");
  expect(rootIgnore).not.toContain(HACK_DIR_GITIGNORE_BEGIN_MARKER);
  expect(
    await gitCheckIgnore({
      repoRoot,
      path: ".hack/.internal/compose.override.yml",
    })
  ).toBe(true);

  // Generated files on disk leave the working tree clean.
  await mkdir(resolve(repoRoot, ".hack", ".internal"), { recursive: true });
  await writeFile(
    resolve(repoRoot, ".hack", ".internal", "compose.override.yml"),
    "services: {}\n"
  );
  await writeFile(resolve(repoRoot, ".hack", ".env.state.json"), "{}\n");
  const status = await runGit(["status", "--porcelain"], repoRoot);
  expect(status).toBe("");
});
