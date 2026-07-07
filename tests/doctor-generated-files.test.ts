import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import {
  buildGeneratedFilePathspecs,
  inspectTrackedGeneratedFiles,
  untrackGeneratedFiles,
} from "../src/lib/doctor-generated-files.ts";
import { pathExists } from "../src/lib/fs.ts";
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

/**
 * Creates a git repo where machine-local generated files were force-added and
 * committed — the leak scenario the doctor check exists to catch.
 */
async function createLeakedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hack-doctor-generated-"));
  tempDirs.add(dir);
  const repoRoot = resolve(dir, "repo");
  await mkdir(resolve(repoRoot, ".hack", ".branch"), { recursive: true });
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
  expect(inspection?.trackedPaths.length).toBe(3);

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
