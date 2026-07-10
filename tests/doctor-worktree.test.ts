import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import {
  findCrossCheckoutInstances,
  inspectWorktreeSecretKeys,
} from "../src/lib/doctor-worktree.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
} from "../src/lib/runtime-projects.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function runGit(args: readonly string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

async function createWorktreeFixture(): Promise<{
  readonly primaryRoot: string;
  readonly linkedRoot: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-doctor-worktree-"));
  tempDirs.add(sandbox);

  const primaryRoot = resolve(sandbox, "primary");
  await mkdir(primaryRoot, { recursive: true });
  await writeFile(resolve(primaryRoot, "README.md"), "# fixture\n");
  await runGit(["init", "-b", "main"], primaryRoot);
  await runGit(["config", "user.name", "Hack Test"], primaryRoot);
  await runGit(["config", "user.email", "hack@example.com"], primaryRoot);
  await runGit(["add", "."], primaryRoot);
  await runGit(["commit", "-m", "init"], primaryRoot);

  const linkedRoot = resolve(sandbox, "linked");
  await runGit(
    ["worktree", "add", "-b", "feature/doctor", linkedRoot],
    primaryRoot
  );

  return { primaryRoot, linkedRoot };
}

test("inspectWorktreeSecretKeys flags divergent keys with exact paths", async () => {
  const fixture = await createWorktreeFixture();

  const primaryKeyPath = resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME);
  const linkedKeyPath = resolve(fixture.linkedRoot, PROJECT_ENV_KEY_FILENAME);
  await writeFile(primaryKeyPath, "key-one\n");
  await writeFile(linkedKeyPath, "key-two\n");

  const inspection = await inspectWorktreeSecretKeys({
    projectRoot: fixture.linkedRoot,
  });

  expect(inspection).not.toBeNull();
  expect(inspection?.checkouts).toHaveLength(2);
  expect(inspection?.divergent).toBe(true);
  expect(inspection?.divergentKeyPaths).toContain(
    await realpath(primaryKeyPath)
  );
  expect(inspection?.divergentKeyPaths).toContain(
    await realpath(linkedKeyPath)
  );
});

test("inspectWorktreeSecretKeys reports convergence for a single shared key", async () => {
  const fixture = await createWorktreeFixture();

  await writeFile(
    resolve(fixture.primaryRoot, ".git", PROJECT_ENV_KEY_FILENAME),
    "shared-key\n"
  );

  const inspection = await inspectWorktreeSecretKeys({
    projectRoot: fixture.linkedRoot,
  });

  expect(inspection?.divergent).toBe(false);
  expect(inspection?.sharedKeyDigest).not.toBeNull();
});

test("inspectWorktreeSecretKeys treats matching local and shared keys as converged", async () => {
  const fixture = await createWorktreeFixture();

  await writeFile(
    resolve(fixture.primaryRoot, PROJECT_ENV_KEY_FILENAME),
    "same-key\n"
  );
  await writeFile(
    resolve(fixture.primaryRoot, ".git", PROJECT_ENV_KEY_FILENAME),
    "same-key\n"
  );

  const inspection = await inspectWorktreeSecretKeys({
    projectRoot: fixture.primaryRoot,
  });

  expect(inspection?.divergent).toBe(false);
});

test("inspectWorktreeSecretKeys returns null outside git checkouts", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "hack-doctor-plain-"));
  tempDirs.add(sandbox);

  const inspection = await inspectWorktreeSecretKeys({ projectRoot: sandbox });
  expect(inspection).toBeNull();
});

function runtimeProject(opts: {
  readonly name: string;
  readonly workingDir: string | null;
  readonly running: boolean;
}): RuntimeProject {
  const container: RuntimeContainer = {
    id: `${opts.name}-api-1`,
    project: opts.name,
    service: "api",
    state: opts.running ? "running" : "exited",
    status: opts.running ? "Up 5 minutes" : "Exited (0)",
    name: `${opts.name}-api-1`,
    ports: "",
    workingDir: opts.workingDir,
    image: null,
    labels: null,
    mounts: [],
    networks: [],
  };
  return {
    project: opts.name,
    workingDir: opts.workingDir,
    services: new Map([["api", { service: "api", containers: [container] }]]),
    isGlobal: false,
  };
}

test("findCrossCheckoutInstances flags family instances from other checkouts", () => {
  const currentDir = "/repos/app/.hack";
  const instances = findCrossCheckoutInstances({
    baseProjectName: "app",
    currentProjectDir: currentDir,
    runtime: [
      runtimeProject({
        name: "app",
        workingDir: "/repos/app-worktree/.hack",
        running: true,
      }),
      runtimeProject({
        name: "app--feature-x",
        workingDir: "/repos/app-worktree/.hack",
        running: true,
      }),
      runtimeProject({ name: "app", workingDir: currentDir, running: true }),
      runtimeProject({
        name: "unrelated",
        workingDir: "/x/.hack",
        running: true,
      }),
    ],
  });

  expect(instances).toHaveLength(2);
  const base = instances.find((instance) => instance.branch === null);
  expect(base?.composeProject).toBe("app");
  expect(base?.running).toBe(true);
  const branch = instances.find((instance) => instance.branch === "feature-x");
  expect(branch?.composeProject).toBe("app--feature-x");
});

test("findCrossCheckoutInstances ignores instances from the current checkout", () => {
  const currentDir = "/repos/app/.hack";
  const instances = findCrossCheckoutInstances({
    baseProjectName: "app",
    currentProjectDir: currentDir,
    runtime: [
      runtimeProject({ name: "app", workingDir: currentDir, running: true }),
      runtimeProject({
        name: "app--feature-y",
        workingDir: currentDir,
        running: false,
      }),
    ],
  });

  expect(instances).toHaveLength(0);
});
