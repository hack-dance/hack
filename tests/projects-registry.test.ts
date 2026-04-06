import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempDir = await mkdtemp(join(tmpdir(), "hack-registry-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createProject(opts: {
  readonly rootName: string;
  readonly name?: string;
  readonly devHost?: string;
}) {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const projectRoot = join(tempDir, opts.rootName);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  await writeJson(join(projectDir, PROJECT_CONFIG_FILENAME), {
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.devHost ? { dev_host: opts.devHost } : {}),
  });
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");

  return {
    projectRoot,
    projectDirName: ".hack" as const,
    projectDir,
    composeFile: join(projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: join(projectDir, PROJECT_ENV_FILENAME),
    configFile: join(projectDir, PROJECT_CONFIG_FILENAME),
  };
}

test("upsertProjectRegistration creates a new entry", async () => {
  const project = await createProject({ rootName: "repo-a", name: "alpha" });
  const res = await upsertProjectRegistration({
    project,
    nowIso: "2025-01-01T00:00:00Z",
  });
  expect(res.status).toBe("created");

  const registry = await readProjectsRegistry();
  expect(registry.projects.length).toBe(1);
  expect(registry.projects[0]?.name).toBe("alpha");
});

test("upsertProjectRegistration returns conflict when name is taken", async () => {
  const existingRoot = await createProject({
    rootName: "repo-a",
    name: "alpha",
  });
  const registryPath = join(tempDir!, ".hack", "projects.json");
  await writeJson(registryPath, {
    version: 1,
    projects: [
      {
        id: "abc123",
        name: "alpha",
        repoRoot: existingRoot.projectRoot,
        projectDirName: ".hack",
        projectDir: existingRoot.projectDir,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
  });

  const incoming = await createProject({ rootName: "repo-b", name: "alpha" });
  const res = await upsertProjectRegistration({
    project: incoming,
    nowIso: "2025-01-02T00:00:00Z",
  });
  expect(res.status).toBe("conflict");
});

test("upsertProjectRegistration moves entry when old path missing", async () => {
  const registryPath = join(tempDir!, ".hack", "projects.json");
  await writeJson(registryPath, {
    version: 1,
    projects: [
      {
        id: "abc123",
        name: "alpha",
        repoRoot: join(tempDir!, "missing-root"),
        projectDirName: ".hack",
        projectDir: join(tempDir!, "missing-root/.hack"),
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
  });

  const incoming = await createProject({ rootName: "repo-b", name: "alpha" });
  const res = await upsertProjectRegistration({
    project: incoming,
    nowIso: "2025-01-02T00:00:00Z",
  });
  expect(res.status).toBe("updated");

  const registry = await readProjectsRegistry();
  expect(registry.projects[0]?.projectDir).toBe(
    await realpath(incoming.projectDir)
  );
});

test("upsertProjectRegistration clears stale registry lock", async () => {
  const project = await createProject({ rootName: "repo-a", name: "alpha" });
  const lockPath = join(tempDir!, ".hack", "projects.json.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "123\n");
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  const res = await upsertProjectRegistration({
    project,
    nowIso: "2025-01-03T00:00:00Z",
  });
  expect(res.status).toBe("created");

  const resolved = await resolveRegisteredProjectByName({ name: "alpha" });
  expect(resolved?.projectDir).toBe(await realpath(project.projectDir));
});

test("upsertProjectRegistration reuses the existing project identity for linked worktrees", async () => {
  const mainProject = await createProject({
    rootName: "repo-main",
    name: "alpha",
  });
  await initializeGitRepo({ projectRoot: mainProject.projectRoot });

  const worktreeRoot = join(tempDir!, "repo-worktree");
  await createGitWorktree({
    projectRoot: mainProject.projectRoot,
    worktreeRoot,
    branch: "feature/worktree",
  });

  const worktreeProject = {
    projectRoot: worktreeRoot,
    projectDirName: ".hack" as const,
    projectDir: join(worktreeRoot, ".hack"),
    composeFile: join(worktreeRoot, ".hack", PROJECT_COMPOSE_FILENAME),
    envFile: join(worktreeRoot, ".hack", PROJECT_ENV_FILENAME),
    configFile: join(worktreeRoot, ".hack", PROJECT_CONFIG_FILENAME),
  };

  const initial = await upsertProjectRegistration({
    project: mainProject,
    nowIso: "2025-01-04T00:00:00Z",
  });
  const linked = await upsertProjectRegistration({
    project: worktreeProject,
    nowIso: "2025-01-05T00:00:00Z",
  });

  expect(initial.status).toBe("created");
  expect(linked.status).toBe("noop");
  if (initial.status !== "created") {
    throw new Error(`Unexpected initial status: ${initial.status}`);
  }
  if (linked.status !== "noop") {
    throw new Error(`Unexpected linked status: ${linked.status}`);
  }
  expect(linked.project.id).toBe(initial.project.id);

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(1);
  expect(registry.projects[0]?.projectDir).toBe(
    await realpath(mainProject.projectDir)
  );
});

async function initializeGitRepo(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  await writeFile(join(opts.projectRoot, "README.md"), "# test\n");
  runGit({ cwd: opts.projectRoot, args: ["init"] });
  runGit({
    cwd: opts.projectRoot,
    args: ["config", "user.email", "test@example.com"],
  });
  runGit({
    cwd: opts.projectRoot,
    args: ["config", "user.name", "Test User"],
  });
  runGit({ cwd: opts.projectRoot, args: ["add", "."] });
  runGit({
    cwd: opts.projectRoot,
    args: ["commit", "-m", "test: seed registry fixture"],
  });
  runGit({ cwd: opts.projectRoot, args: ["branch", "-M", "main"] });
}

async function createGitWorktree(opts: {
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly branch: string;
}): Promise<void> {
  runGit({
    cwd: opts.projectRoot,
    args: ["worktree", "add", "-b", opts.branch, opts.worktreeRoot],
  });

  const readme = await readFile(join(opts.worktreeRoot, "README.md"), "utf8");
  expect(readme).toContain("# test");
}

function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): string {
  const result = Bun.spawnSync(["git", "-C", opts.cwd, ...opts.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed\n${Buffer.from(result.stderr).toString("utf8")}`
    );
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}
