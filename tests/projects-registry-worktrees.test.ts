import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import type { ProjectContext } from "../src/lib/project.ts";
import {
  readProjectsRegistry,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempDir = await mkdtemp(join(tmpdir(), "hack-registry-worktrees-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
});

function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): void {
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
}

function projectContextFor(root: string): ProjectContext {
  return {
    projectRoot: root,
    projectDirName: ".hack",
    projectDir: join(root, ".hack"),
    composeFile: join(root, ".hack", PROJECT_COMPOSE_FILENAME),
    envFile: join(root, ".hack", PROJECT_ENV_FILENAME),
    configFile: join(root, ".hack", PROJECT_CONFIG_FILENAME),
  };
}

async function createFixture(): Promise<{
  readonly primary: ProjectContext;
  readonly worktreeRoot: string;
}> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }

  const primaryRoot = join(tempDir, "repo-primary");
  const projectDir = join(primaryRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "alpha", dev_host: "alpha.hack" }, null, 2)}\n`
  );
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");
  await writeFile(join(primaryRoot, "README.md"), "# fixture\n");

  runGit({ cwd: primaryRoot, args: ["init", "-b", "main"] });
  runGit({
    cwd: primaryRoot,
    args: ["config", "user.email", "test@example.com"],
  });
  runGit({ cwd: primaryRoot, args: ["config", "user.name", "Test User"] });
  runGit({ cwd: primaryRoot, args: ["add", "."] });
  runGit({ cwd: primaryRoot, args: ["commit", "-m", "init"] });

  const worktreeRoot = join(tempDir, "repo-worktree");
  runGit({
    cwd: primaryRoot,
    args: ["worktree", "add", "-b", "feature/tracked", worktreeRoot],
  });

  return { primary: projectContextFor(primaryRoot), worktreeRoot };
}

test("touching a registered project from a linked worktree records the sibling checkout", async () => {
  const fixture = await createFixture();

  const initial = await upsertProjectRegistration({
    project: fixture.primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  expect(initial.status).toBe("created");

  const fromWorktree = await upsertProjectRegistration({
    project: projectContextFor(fixture.worktreeRoot),
    nowIso: "2026-01-02T00:00:00Z",
  });
  expect(fromWorktree.status).toBe("noop");

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(1);
  const worktrees = registry.projects[0]?.worktrees ?? [];
  expect(worktrees).toHaveLength(1);
  expect(worktrees[0]?.path).toBe(await realpath(fixture.worktreeRoot));
  expect(worktrees[0]?.branch).toBe("feature/tracked");
  expect(worktrees[0]?.lastSeenAt).toBe("2026-01-02T00:00:00Z");
});

test("repeat touches from the same worktree dedupe by path", async () => {
  const fixture = await createFixture();

  await upsertProjectRegistration({
    project: fixture.primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  await upsertProjectRegistration({
    project: projectContextFor(fixture.worktreeRoot),
    nowIso: "2026-01-02T00:00:00Z",
  });
  await upsertProjectRegistration({
    project: projectContextFor(fixture.worktreeRoot),
    nowIso: "2026-01-03T00:00:00Z",
  });

  const registry = await readProjectsRegistry();
  const worktrees = registry.projects[0]?.worktrees ?? [];
  expect(worktrees).toHaveLength(1);
  expect(worktrees[0]?.lastSeenAt).toBe("2026-01-03T00:00:00Z");
});

test("worktree entries are pruned when the checkout path disappears", async () => {
  const fixture = await createFixture();

  await upsertProjectRegistration({
    project: fixture.primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  await upsertProjectRegistration({
    project: projectContextFor(fixture.worktreeRoot),
    nowIso: "2026-01-02T00:00:00Z",
  });

  await rm(fixture.worktreeRoot, { recursive: true, force: true });

  const afterPrune = await upsertProjectRegistration({
    project: fixture.primary,
    nowIso: "2026-01-03T00:00:00Z",
  });
  expect(afterPrune.status).toBe("updated");

  const registry = await readProjectsRegistry();
  expect(registry.projects[0]?.worktrees ?? []).toHaveLength(0);
});

test("registry files without worktrees still parse (v1 backward compat)", async () => {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const registryPath = join(tempDir, ".hack", "projects.json");
  await mkdir(join(tempDir, ".hack"), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: 1,
        projects: [
          {
            id: "abc123",
            name: "legacy",
            repoRoot: join(tempDir, "legacy-root"),
            projectDirName: ".hack",
            projectDir: join(tempDir, "legacy-root/.hack"),
            createdAt: "2025-01-01T00:00:00Z",
          },
        ],
      },
      null,
      2
    )}\n`
  );

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(1);
  expect(registry.projects[0]?.name).toBe("legacy");
  expect(registry.projects[0]?.worktrees).toBeUndefined();
});
