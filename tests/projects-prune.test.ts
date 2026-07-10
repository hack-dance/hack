import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { __testOnlyProjectsCommand } from "../src/commands/projects.ts";
import {
  findDeadProjectRegistrations,
  type RegisteredProject,
  readProjectsRegistry,
  removeProjectsById,
} from "../src/lib/projects-registry.ts";
import type { RuntimeProject } from "../src/lib/runtime-projects.ts";

let tempDir: string | null = null;
let originalHackHome: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHackHome = process.env.HACK_HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  tempDir = await mkdtemp(join(tmpdir(), "hack-projects-prune-"));
  process.env.HACK_HOME = join(tempDir, "hack-home");
});

afterEach(async () => {
  restoreEnv("HACK_HOME", originalHackHome);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalGlobalConfigPath);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function buildRegistration(opts: {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
}): RegisteredProject {
  return {
    id: opts.id,
    name: opts.name,
    repoRoot: opts.repoRoot,
    projectDirName: ".hack",
    projectDir: join(opts.repoRoot, ".hack"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function writeRegistry(
  projects: readonly RegisteredProject[]
): Promise<void> {
  const hackHome = process.env.HACK_HOME;
  if (!hackHome) {
    throw new Error("HACK_HOME not set");
  }
  const path = join(hackHome, "projects.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, projects }, null, 2)}\n`
  );
}

async function createLiveRepo(name: string): Promise<string> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const repoRoot = join(tempDir, name);
  await mkdir(join(repoRoot, ".hack"), { recursive: true });
  return repoRoot;
}

test("findDeadProjectRegistrations flags only entries with a missing repo root", async () => {
  const liveRoot = await createLiveRepo("live-repo");
  const live = buildRegistration({
    id: "live00000001",
    name: "live",
    repoRoot: liveRoot,
  });
  const dead = buildRegistration({
    id: "dead00000001",
    name: "dead",
    repoRoot: join(tempDir ?? "", "gone", "hack-project-stale"),
  });

  const found = await findDeadProjectRegistrations({
    projects: [live, dead],
  });

  expect(found).toHaveLength(1);
  expect(found[0]?.project.id).toBe("dead00000001");
  expect(found[0]?.reason).toBe("missing repo root");
});

test("findDeadProjectRegistrations returns empty for an empty registry", async () => {
  const found = await findDeadProjectRegistrations({ projects: [] });
  expect(found).toEqual([]);
});

test("prune removes dead entries from the registry and keeps live ones", async () => {
  const liveRoot = await createLiveRepo("live-repo");
  const live = buildRegistration({
    id: "live00000001",
    name: "live",
    repoRoot: liveRoot,
  });
  const dead = buildRegistration({
    id: "dead00000001",
    name: "dead",
    repoRoot: join(tempDir ?? "", "gone", "hack-project-stale"),
  });
  await writeRegistry([live, dead]);

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(2);

  const found = await findDeadProjectRegistrations({
    projects: registry.projects,
  });
  const { removed } = await removeProjectsById({
    ids: found.map((entry) => entry.project.id),
  });

  expect(removed.map((entry) => entry.id)).toEqual(["dead00000001"]);

  const after = await readProjectsRegistry();
  expect(after.projects.map((entry) => entry.id)).toEqual(["live00000001"]);
});

test("project-scoped prune selects only one project family", () => {
  const alpha = buildRegistration({
    id: "alpha0000001",
    name: "alpha",
    repoRoot: "/missing/alpha",
  });
  const beta = buildRegistration({
    id: "beta00000001",
    name: "beta",
    repoRoot: "/missing/beta",
  });
  const runtime = [
    runtimeProject("alpha"),
    runtimeProject("alpha--feature-one"),
    runtimeProject("beta--feature-two"),
  ];

  expect(
    __testOnlyProjectsCommand
      .filterPruneRegistryProjects({ projects: [alpha, beta], filter: "alpha" })
      .map((project) => project.name)
  ).toEqual(["alpha"]);
  expect(
    __testOnlyProjectsCommand
      .filterPruneRuntimeProjects({ runtime, filter: "alpha" })
      .map((project) => project.project)
  ).toEqual(["alpha", "alpha--feature-one"]);
});

function runtimeProject(project: string): RuntimeProject {
  return {
    project,
    workingDir: `/missing/${project}`,
    services: new Map(),
    isGlobal: false,
  };
}
