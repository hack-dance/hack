import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkHackDirGitignore } from "../src/commands/doctor.ts";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import {
  buildGeneratedFilePathspecs,
  inspectHackDirGitignoreForDoctor,
  inspectTrackedGeneratedFiles,
  untrackGeneratedFiles,
} from "../src/lib/doctor-generated-files.ts";
import { ensureGitignoreEntry, pathExists } from "../src/lib/fs.ts";
import { ensureHackDirGitignore } from "../src/lib/project-env-config.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

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

const STAGING_ORPHAN = ".hack.env.local.yaml.0b88c1d2.tmp";

/**
 * Creates a git repo where machine-local generated files were force-added and
 * committed — the leak scenario the doctor check exists to catch.
 */
async function createLeakedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-generated-"));
  tempDirs.add(dir);
  const repoRoot = resolve(dir, "repo");
  await mkdir(resolve(repoRoot, ".hack", ".branch"), { recursive: true });
  await mkdir(resolve(repoRoot, ".hack", "tickets"), { recursive: true });
  await runGit(["init", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "Hack Test"], repoRoot);
  await runGit(["config", "user.email", "hack@example.com"], repoRoot);

  await writeFile(
    resolve(repoRoot, ".hack", "docker-compose.yml"),
    "services:\n  api: {}\n"
  );
  await writeFile(
    resolve(repoRoot, ".hack", ".branch", "compose.x.override.yml"),
    "services: {}\n"
  );
  await writeFile(
    resolve(repoRoot, ".hack", ".env.state.json"),
    '{"env":"default"}\n'
  );
  await writeFile(
    resolve(repoRoot, ".hack", "tickets", "legacy-cache.json"),
    "{}\n"
  );
  // Staging file left by an env layer write killed before its commit rename.
  await writeFile(
    resolve(repoRoot, ".hack", STAGING_ORPHAN),
    "version: 1\nvalues:\n  global: {}\n"
  );
  await writeFile(
    resolve(repoRoot, PROJECT_ENV_KEY_FILENAME),
    "super-secret-key\n"
  );
  await runGit(["add", "-f", "."], repoRoot);
  await runGit(["commit", "-m", "leak generated files"], repoRoot);
  return repoRoot;
}

test("inspectTrackedGeneratedFiles lists tracked generated files and flags the secret key", async () => {
  const repoRoot = await createLeakedRepo();

  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: repoRoot,
    projectDirName: ".hack",
  });
  expect(inspection).not.toBeNull();
  expect(inspection?.trackedPaths).toEqual([
    PROJECT_ENV_KEY_FILENAME,
    ".hack/.branch/compose.x.override.yml",
    ".hack/.env.state.json",
    `.hack/${STAGING_ORPHAN}`,
    ".hack/tickets/legacy-cache.json",
  ]);
  expect(inspection?.secretKeyTracked).toBe(true);
});

test("inspectTrackedGeneratedFiles returns null outside a git checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-generated-nongit-"));
  tempDirs.add(dir);

  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: dir,
    projectDirName: ".hack",
  });
  expect(inspection).toBeNull();
});

test("tracked .hack/hack.env.local.yaml is not flagged (legacy shared overlay)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-generated-legacy-"));
  tempDirs.add(dir);
  const repoRoot = resolve(dir, "repo");
  await mkdir(resolve(repoRoot, ".hack"), { recursive: true });
  await runGit(["init", "-b", "main"], repoRoot);
  await runGit(["config", "user.name", "Hack Test"], repoRoot);
  await runGit(["config", "user.email", "hack@example.com"], repoRoot);
  await writeFile(
    resolve(repoRoot, ".hack", "hack.env.local.yaml"),
    "version: 1\nenvironment: local\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  await runGit(["add", "."], repoRoot);
  await runGit(["commit", "-m", "legacy shared local overlay"], repoRoot);

  expect(
    buildGeneratedFilePathspecs({ projectDirName: ".hack" })
  ).not.toContain(".hack/hack.env.local.yaml");
  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: repoRoot,
    projectDirName: ".hack",
  });
  expect(inspection?.trackedPaths).toEqual([]);
});

test("untrackGeneratedFiles removes offenders from the index, keeps files on disk, and a rerun is clean", async () => {
  const repoRoot = await createLeakedRepo();

  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: repoRoot,
    projectDirName: ".hack",
  });
  expect(inspection?.trackedPaths.length).toBe(5);

  // Same flow as `hack doctor --fix`: untrack, then ensure the nested ignore.
  const untracked = await untrackGeneratedFiles({
    projectRoot: repoRoot,
    paths: inspection?.trackedPaths ?? [],
  });
  expect(untracked).toEqual({ ok: true, error: null });
  await ensureHackDirGitignore({ projectDir: resolve(repoRoot, ".hack") });

  // Files stay on disk.
  for (const path of [
    ".hack/.branch/compose.x.override.yml",
    ".hack/.env.state.json",
    `.hack/${STAGING_ORPHAN}`,
    ".hack/tickets/legacy-cache.json",
    PROJECT_ENV_KEY_FILENAME,
  ]) {
    expect(
      await pathExists(resolve(repoRoot, path)),
      `expected ${path} to remain on disk`
    ).toBe(true);
  }

  // Second inspection is clean once the removal lands in the index.
  const second = await inspectTrackedGeneratedFiles({
    projectRoot: repoRoot,
    projectDirName: ".hack",
  });
  expect(second?.trackedPaths).toEqual([]);
  expect(second?.secretKeyTracked).toBe(false);

  // After committing the fix, nothing untracked leaks back in
  // (the nested .gitignore covers the .hack/ files; the root .gitignore
  // entry for the secret key is ensured by the env key write path).
  await runGit(["add", ".hack/.gitignore"], repoRoot);
  await runGit(["commit", "-m", "untrack generated files"], repoRoot);
  const status = await runGit(["status", "--porcelain"], repoRoot);
  expect(status).toBe(`?? ${PROJECT_ENV_KEY_FILENAME}`);
});

test("untrackGeneratedFiles with no paths is a no-op", async () => {
  const repoRoot = await createLeakedRepo();
  const result = await untrackGeneratedFiles({
    projectRoot: repoRoot,
    paths: [],
  });
  expect(result).toEqual({ ok: true, error: null });
});

test("untracked secret key stays ignored once the root gitignore entry is ensured", async () => {
  const repoRoot = await createLeakedRepo();

  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: repoRoot,
    projectDirName: ".hack",
  });
  expect(inspection?.secretKeyTracked).toBe(true);

  const untracked = await untrackGeneratedFiles({
    projectRoot: repoRoot,
    paths: inspection?.trackedPaths ?? [],
  });
  expect(untracked.ok).toBe(true);

  await ensureHackDirGitignore({ projectDir: resolve(repoRoot, ".hack") });
  await ensureGitignoreEntry({
    gitignorePath: resolve(repoRoot, ".gitignore"),
    entry: PROJECT_ENV_KEY_FILENAME,
    comment: "# project env key",
  });

  const ignored = await runGit(
    ["check-ignore", PROJECT_ENV_KEY_FILENAME],
    repoRoot
  );
  expect(ignored).toBe(PROJECT_ENV_KEY_FILENAME);

  const status = await runGit(["status", "--porcelain"], repoRoot);
  expect(status).not.toContain(`?? ${PROJECT_ENV_KEY_FILENAME}`);
  expect(await pathExists(resolve(repoRoot, PROJECT_ENV_KEY_FILENAME))).toBe(
    true
  );
});

test("inspectHackDirGitignoreForDoctor reports missing, outdated and current, and skips non-git dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-gitignore-"));
  tempDirs.add(dir);
  const repoRoot = resolve(dir, "repo");
  const projectDir = resolve(repoRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBeNull();

  await runGit(["init", "-b", "main"], repoRoot);
  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe(
    "missing"
  );

  const gitignore = resolve(projectDir, ".gitignore");
  await writeFile(gitignore, "custom-entry\n");
  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe(
    "outdated"
  );

  await ensureHackDirGitignore({ projectDir });
  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe(
    "current"
  );
  expect(await readFile(gitignore, "utf8")).toStartWith("custom-entry\n");
});

const COMPOSE_TEXT = "services:\n  api:\n    image: alpine:3.20\n";

/** A git repo with `.hack/docker-compose.yml`, so doctor finds the project. */
async function createGitProject(): Promise<{
  readonly dir: string;
  readonly repoRoot: string;
  readonly projectDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-gitignore-"));
  tempDirs.add(dir);
  const repoRoot = resolve(dir, "repo");
  const projectDir = resolve(repoRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, "docker-compose.yml"), COMPOSE_TEXT);
  await runGit(["init", "-b", "main"], repoRoot);
  return { dir, repoRoot, projectDir };
}

test("a read-only .hack/.gitignore without the managed block is reported, never replaced (HACK-1363)", async () => {
  const { repoRoot, projectDir } = await createGitProject();
  const gitignore = resolve(projectDir, ".gitignore");
  await writeFile(gitignore, "custom-entry\n");
  await chmod(gitignore, 0o444);
  try {
    expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe(
      "read-only"
    );
    const check = await checkHackDirGitignore({ startDir: repoRoot });
    expect(check.status).toBe("warn");
    expect(check.message).toBe(
      ".hack/.gitignore is read-only and lacks Hack's current managed block; Hack leaves it unchanged. Make it writable (chmod u+w .hack/.gitignore), then run 'hack doctor --fix' and commit it."
    );
    expect(await readFile(gitignore, "utf8")).toBe("custom-entry\n");
    expect((await lstat(gitignore)).mode & 0o777).toBe(0o444);
  } finally {
    await chmod(gitignore, 0o644);
  }
});

test("a read-only .hack/.gitignore that is already current is ok", async () => {
  const { projectDir } = await createGitProject();
  await ensureHackDirGitignore({ projectDir });
  const gitignore = resolve(projectDir, ".gitignore");
  await chmod(gitignore, 0o444);
  try {
    expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe(
      "current"
    );
  } finally {
    await chmod(gitignore, 0o644);
  }
});

test("a .hack symlinked outside the repository is reported unsafe, not skipped as a non-git dir (HACK-1363)", async () => {
  const { dir, repoRoot, projectDir } = await createGitProject();
  const outsideDir = resolve(dir, "outside-hack");
  await mkdir(outsideDir);
  await writeFile(resolve(outsideDir, "docker-compose.yml"), COMPOSE_TEXT);
  await rm(projectDir, { recursive: true });
  await symlink(outsideDir, projectDir);

  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBe("unsafe");
  const check = await checkHackDirGitignore({ startDir: repoRoot });
  expect(check.status).toBe("warn");
  expect(check.message).toBe(
    ".hack/.gitignore or its directory is a symlink or not a regular file; Hack will not read or write through it. Replace it with a regular file."
  );
  expect(await readdir(outsideDir)).toEqual(["docker-compose.yml"]);
});

test("a project root outside git is still skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-gitignore-"));
  tempDirs.add(dir);
  const projectDir = resolve(dir, "plain", ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(resolve(projectDir, "docker-compose.yml"), COMPOSE_TEXT);

  expect(await inspectHackDirGitignoreForDoctor({ projectDir })).toBeNull();
  const check = await checkHackDirGitignore({
    startDir: resolve(dir, "plain"),
  });
  expect(check).toMatchObject({
    status: "ok",
    message: "Skipped (not a git checkout)",
  });
});
