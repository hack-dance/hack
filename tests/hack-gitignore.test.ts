import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureManagedGitignoreBlock } from "../src/lib/fs.ts";
import {
  ensureHackDirGitignore,
  HACK_DIR_GITIGNORE_REFUSAL,
  HackDirGitignoreRefusalError,
} from "../src/lib/project-env-config.ts";
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

test("ensureHackDirGitignore creates a new file with mode 0644", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await ensureHackDirGitignore({ projectDir });
  expect((await stat(resolve(projectDir, ".gitignore"))).mode & 0o777).toBe(
    0o644
  );
});

test("ensureHackDirGitignore refuses a dangling .gitignore symlink without creating its target", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await mkdir(projectDir);
  const outside = resolve(dir, "outside-target");
  await symlink(outside, resolve(projectDir, ".gitignore"));

  const error = await ensureHackDirGitignore({ projectDir }).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(HackDirGitignoreRefusalError);
  expect((error as Error).message).toBe(HACK_DIR_GITIGNORE_REFUSAL);
  expect(await lstat(outside).catch(() => null)).toBeNull();
  expect(
    (await lstat(resolve(projectDir, ".gitignore"))).isSymbolicLink()
  ).toBe(true);
});

test("ensureHackDirGitignore refuses a .gitignore symlink to an outside file and leaves it unchanged", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await mkdir(projectDir);
  const outside = resolve(dir, "outside-file");
  await writeFile(outside, "outside\n");
  await symlink(outside, resolve(projectDir, ".gitignore"));

  await expect(ensureHackDirGitignore({ projectDir })).rejects.toBeInstanceOf(
    HackDirGitignoreRefusalError
  );
  expect(await readFile(outside, "utf8")).toBe("outside\n");
});

test("ensureHackDirGitignore refuses a symlinked project dir and writes nothing through it", async () => {
  const dir = await createTempDir();
  const outsideDir = resolve(dir, "outside-dir");
  await mkdir(outsideDir);
  const projectDir = resolve(dir, ".hack");
  await symlink(outsideDir, projectDir);

  await expect(ensureHackDirGitignore({ projectDir })).rejects.toBeInstanceOf(
    HackDirGitignoreRefusalError
  );
  expect(
    await lstat(resolve(outsideDir, ".gitignore")).catch(() => null)
  ).toBeNull();
});

test("ensureHackDirGitignore leaves a read-only outdated .gitignore unchanged instead of replacing it", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await mkdir(projectDir);
  const path = resolve(projectDir, ".gitignore");
  await writeFile(path, "my-own-entry\n");
  await chmod(path, 0o444);
  const before = await lstat(path);
  try {
    expect(await ensureHackDirGitignore({ projectDir })).toEqual({
      changed: false,
      readOnly: true,
    });
    const after = await lstat(path);
    expect(await readFile(path, "utf8")).toBe("my-own-entry\n");
    expect(after.mode & 0o777).toBe(0o444);
    expect(after.ino).toBe(before.ino);
    expect(await readdir(projectDir)).toEqual([".gitignore"]);
  } finally {
    await chmod(path, 0o644);
  }
});

test("ensureHackDirGitignore does not report a read-only .gitignore that is already current", async () => {
  const dir = await createTempDir();
  const projectDir = resolve(dir, ".hack");
  await ensureHackDirGitignore({ projectDir });
  const path = resolve(projectDir, ".gitignore");
  const text = await readFile(path, "utf8");
  await chmod(path, 0o444);
  try {
    expect(await ensureHackDirGitignore({ projectDir })).toEqual({
      changed: false,
      readOnly: false,
    });
    expect(await readFile(path, "utf8")).toBe(text);
  } finally {
    await chmod(path, 0o644);
  }
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
    ".hack/.branch/compose.0b88.override.yml",
    ".hack/.env",
    ".hack/.env.state.json",
    ".hack/hack.env.local.yaml",
    ".hack/hack.env.qa.local.yaml",
    ".hack/.hack.env.local.yaml.0b88c1d2.tmp",
    ".hack/.hack.env.default.yaml.0b88c1d2.tmp",
    ".hack/tickets/state/projection.sqlite",
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
    ".hack/.branch/compose.0b88.override.yml",
    ".hack/.env.state.json",
    ".hack/hack.env.qa.local.yaml",
    ".hack/tickets/git/bare.git/HEAD",
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
