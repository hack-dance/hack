import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findIncompleteRuntimeProjects,
  findMissingRegistryEntries,
  findOrphanRuntimeProjects,
  scopeRuntimeHygieneToProject,
} from "../src/lib/project-runtime-hygiene.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import type { RuntimeProject } from "../src/lib/runtime-projects.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test("findMissingRegistryEntries reports missing project dirs and compose files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-runtime-hygiene-"));
  tempDirs.add(root);

  const presentProjectDir = resolve(root, "present", ".hack");
  const missingComposeDir = resolve(root, "missing-compose", ".hack");
  const missingProjectDir = resolve(root, "missing-project", ".hack");

  await mkdir(presentProjectDir, { recursive: true });
  await writeFile(
    resolve(presentProjectDir, "docker-compose.yml"),
    "services:\n"
  );
  await mkdir(missingComposeDir, { recursive: true });

  const projects: RegisteredProject[] = [
    buildRegisteredProject({
      id: "present",
      name: "present",
      projectDir: presentProjectDir,
    }),
    buildRegisteredProject({
      id: "missing-compose",
      name: "missing-compose",
      projectDir: missingComposeDir,
    }),
    buildRegisteredProject({
      id: "missing-project",
      name: "missing-project",
      projectDir: missingProjectDir,
    }),
  ];

  const missing = await findMissingRegistryEntries({ projects });

  expect(missing).toHaveLength(2);
  expect(missing[0]).toMatchObject({
    project: {
      id: "missing-compose",
      name: "missing-compose",
    },
    reason: "missing compose file",
  });
  expect(missing[1]).toMatchObject({
    project: {
      id: "missing-project",
      name: "missing-project",
    },
    reason: "missing project dir",
  });
});

test("findOrphanRuntimeProjects reports missing working dirs and compose files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-runtime-hygiene-"));
  tempDirs.add(root);

  const healthyDir = resolve(root, "healthy", ".hack");
  const missingComposeDir = resolve(root, "missing-compose", ".hack");
  const missingWorkingDir = resolve(root, "missing-working-dir", ".hack");

  await mkdir(healthyDir, { recursive: true });
  await writeFile(resolve(healthyDir, "docker-compose.yml"), "services:\n");
  await mkdir(missingComposeDir, { recursive: true });

  const runtime: RuntimeProject[] = [
    buildRuntimeProject({
      project: "healthy",
      workingDir: healthyDir,
      containerIds: ["healthy-1"],
    }),
    buildRuntimeProject({
      project: "missing-compose",
      workingDir: missingComposeDir,
      containerIds: ["missing-compose-1", "missing-compose-2"],
    }),
    buildRuntimeProject({
      project: "missing-working-dir",
      workingDir: missingWorkingDir,
      containerIds: ["missing-dir-1"],
    }),
  ];

  const orphaned = await findOrphanRuntimeProjects({ runtime });

  expect(orphaned).toEqual([
    {
      project: "missing-compose",
      workingDir: missingComposeDir,
      reason: "missing compose file",
      containerIds: ["missing-compose-1", "missing-compose-2"],
    },
    {
      project: "missing-working-dir",
      workingDir: missingWorkingDir,
      reason: "missing working dir",
      containerIds: ["missing-dir-1"],
    },
  ]);
});

test("findIncompleteRuntimeProjects reports regular services stuck in Created", () => {
  const runtime = buildRuntimeProject({
    project: "interrupted",
    workingDir: "/tmp/interrupted/.hack",
    containerIds: ["api-1", "worker-1"],
  });
  runtime.services.get("app")?.containers.forEach((container) => {
    Object.assign(container, { state: "created", status: "Created" });
  });

  expect(findIncompleteRuntimeProjects({ runtime: [runtime] })).toEqual([
    {
      project: "interrupted",
      workingDir: "/tmp/interrupted/.hack",
      createdServices: ["app"],
      containerIds: ["api-1", "worker-1"],
    },
  ]);
});

test("findIncompleteRuntimeProjects ignores terminal services and lifecycle pseudo-services", () => {
  const terminal = buildRuntimeProject({
    project: "terminal",
    workingDir: "/tmp/terminal/.hack",
    containerIds: ["terminal-1"],
  });
  terminal.services.get("app")?.containers.forEach((container) => {
    Object.assign(container, { state: "exited", status: "Exited (0)" });
  });
  const lifecycle = buildRuntimeProject({
    project: "lifecycle",
    workingDir: "/tmp/lifecycle/.hack",
    containerIds: ["lifecycle-1"],
  });
  lifecycle.services.get("app")?.containers.forEach((container) => {
    Object.assign(container, {
      state: "created",
      status: "Created",
      labels: { "hack.lifecycle.process": "true" },
    });
  });

  expect(
    findIncompleteRuntimeProjects({ runtime: [terminal, lifecycle] })
  ).toEqual([]);
});

test("scopeRuntimeHygieneToProject excludes unrelated registered and runtime projects", () => {
  const projectRoot = "/tmp/current-repo";
  const projectDir = "/tmp/current-repo/.hack";
  const scoped = scopeRuntimeHygieneToProject({
    projectRoot,
    projectDir,
    projects: [
      buildRegisteredProject({
        id: "current",
        name: "current",
        projectDir,
      }),
      buildRegisteredProject({
        id: "other",
        name: "other",
        projectDir: "/tmp/other-repo/.hack",
      }),
    ],
    runtime: [
      buildRuntimeProject({
        project: "current",
        workingDir: projectDir,
        containerIds: ["current-1"],
      }),
      buildRuntimeProject({
        project: "current--feat-branch",
        workingDir: "/tmp/current-repo-branch/.hack",
        containerIds: ["current-branch-1"],
      }),
      buildRuntimeProject({
        project: "other",
        workingDir: "/tmp/other-repo/.hack",
        containerIds: ["other-1"],
      }),
    ],
  });

  expect(scoped.projects.map((project) => project.id)).toEqual(["current"]);
  expect(scoped.runtime.map((project) => project.project)).toEqual([
    "current",
    "current--feat-branch",
  ]);
});

function buildRegisteredProject(input: {
  readonly id: string;
  readonly name: string;
  readonly projectDir: string;
}): RegisteredProject {
  return {
    id: input.id,
    name: input.name,
    repoRoot: resolve(input.projectDir, ".."),
    projectDirName: ".hack",
    projectDir: input.projectDir,
    createdAt: "2026-04-20T12:00:00.000Z",
  };
}

function buildRuntimeProject(input: {
  readonly project: string;
  readonly workingDir: string;
  readonly containerIds: readonly string[];
}): RuntimeProject {
  return {
    project: input.project,
    workingDir: input.workingDir,
    isGlobal: false,
    services: new Map([
      [
        "app",
        {
          service: "app",
          containers: input.containerIds.map((id) => ({
            id,
            project: input.project,
            service: "app",
            state: "running",
            status: "Up 1 minute",
            name: `${input.project}-app-1`,
            ports: "",
            workingDir: input.workingDir,
            image: "alpine:3.20",
            labels: null,
            mounts: [],
            networks: [],
          })),
        },
      ],
    ]),
  };
}
