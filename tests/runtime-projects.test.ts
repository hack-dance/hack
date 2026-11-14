import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectsRegistry } from "../src/lib/projects-registry.ts";
import type { RuntimeProject } from "../src/lib/runtime-projects.ts";
import { restoreEnv } from "./helpers/env.ts";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let dockerAvailable = false;
let currentIds: string[] = [];
let inspectExitCode = 0;
const memberStates = new Map<string, string>();
const memberExitCodes = new Map<string, number>();
const inspectCalls: string[][] = [];
let tempDir: string | null = null;
let originalHackHome: string | undefined;
let markerBeforeRegistrationFile: string | null = null;

const projectFileMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/fs.ts",
  overrides: {
    pathExists: async (file: string) => {
      let exists = false;
      try {
        await stat(file);
        exists = true;
      } catch {
        exists = false;
      }
      if (file === markerBeforeRegistrationFile) {
        await Bun.write(join(file, "..", "hack.project.json"), "{}\n");
        markerBeforeRegistrationFile = null;
      }
      return exists;
    },
  },
});

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (command: readonly string[]) => {
      if (command[1] === "ps") {
        return {
          stdout: currentIds
            .map((id) => JSON.stringify(makePsRow({ id })))
            .join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command[1] === "inspect") {
        expect(command[2]).toBe("--format");
        expect(command[3]).not.toContain(".Env");
        expect(command[3]).not.toContain(".Log");
        expect(command[3]).not.toContain(".Error");
        expect(command[3]).toContain(".State.StartedAt");
        const ids = [...command.slice(4)];
        inspectCalls.push(ids);
        const returnedIds = inspectExitCode === 0 ? ids : ids.slice(0, 1);
        return {
          stdout: returnedIds
            .map((id) => JSON.stringify(makeInspectRow({ id })))
            .join("\n"),
          stderr:
            inspectExitCode === 0 ? "" : "one inspected container disappeared",
          exitCode: inspectExitCode,
        };
      }
      throw new Error(`unexpected command: ${command.join(" ")}`);
    },
    findExecutableInPath: (executableName: string) =>
      executableName === "docker" && !dockerAvailable ? null : executableName,
  },
});

const {
  autoRegisterRuntimeHackProjects,
  createRuntimeInspectCache,
  getRuntimeInspectCacheDiagnostics,
  readRuntimeProjects,
} = await import("../src/lib/runtime-projects.ts");

beforeAll(() => {
  shellMock.activate();
  projectFileMock.activate();
});

beforeEach(async () => {
  originalHackHome = process.env.HACK_HOME;
  tempDir = await realpath(
    await mkdtemp(join(tmpdir(), "hack-runtime-projects-"))
  );
  process.env.HACK_HOME = join(tempDir, "hack-home");
  markerBeforeRegistrationFile = null;
  dockerAvailable = false;
  currentIds = [];
  inspectExitCode = 0;
  memberStates.clear();
  memberExitCodes.clear();
  inspectCalls.length = 0;
});

afterEach(async () => {
  restoreEnv("HACK_HOME", originalHackHome);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

afterAll(() => {
  shellMock.deactivate();
  projectFileMock.deactivate();
});

test("readRuntimeProjects reports docker absence instead of throwing", async () => {
  const result = await readRuntimeProjects({ includeGlobal: false });

  expect(result.ok).toBe(false);
  expect(result.runtime).toEqual([]);
  expect(result.error).toBe("docker is not installed or not on PATH");
});

test("runtime inspect cache reuses unchanged IDs and reconciles replacements", async () => {
  dockerAvailable = true;
  const firstId = "aaaaaaaaaaaa";
  const replacedId = "bbbbbbbbbbbb";
  const replacementId = "cccccccccccc";
  currentIds = [firstId, replacedId];
  const inspectCache = createRuntimeInspectCache();

  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: true,
  });
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: false,
  });
  currentIds = [firstId, replacementId];
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: false,
  });
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache,
    forceInspect: true,
  });

  expect(inspectCalls).toEqual([
    [firstId, replacedId],
    [replacementId],
    [firstId, replacementId],
  ]);
  expect([...inspectCache.entries.keys()]).toEqual([firstId, replacementId]);
  expect(getRuntimeInspectCacheDiagnostics({ cache: inspectCache })).toEqual({
    inspectCalls: 3,
    inspectIds: 5,
    cacheHits: 3,
    cacheMisses: 3,
    fullRefreshes: 2,
  });
});

test("runtime inspection keeps valid stdout when another container disappears", async () => {
  dockerAvailable = true;
  currentIds = ["aaaaaaaaaaaa", "missing00000"];
  inspectExitCode = 1;

  const result = await readRuntimeProjects({ includeGlobal: true });

  expect(result.ok).toBe(true);
  const app = result.runtime[0]?.services.get("service-aaaaaaaaaaaa");
  expect(app?.containers[0]?.image).toBe("image:aaaaaaaaaaaa");
  expect(app?.containers[0]?.networks[0]?.name).toBe("hack-dev");
});

test("runtime auto-registration skips native/mixed roots and still registers legacy peers", async () => {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }
  const roots = ["native", "mixed-primary", "mixed-legacy", "legacy"];
  const runtime: RuntimeProject[] = [];
  for (const name of roots) {
    const projectRoot = join(tempDir, name);
    const projectDirName = name === "mixed-legacy" ? ".dev" : ".hack";
    const projectDir = join(projectRoot, projectDirName);
    await mkdir(projectDir, { recursive: true });
    if (name !== "native") {
      await Bun.write(
        join(projectDir, "docker-compose.yml"),
        `name: ${name}\nservices:\n  web: {}\n`
      );
      await Bun.write(
        join(projectDir, "hack.config.json"),
        JSON.stringify({ name })
      );
    }
    if (name !== "legacy") {
      await mkdir(join(projectRoot, ".hack", "hack.project.json"), {
        recursive: true,
      });
    }
    runtime.push({
      project: name,
      workingDir: projectDir,
      services: new Map(),
      isGlobal: false,
    });
  }

  await autoRegisterRuntimeHackProjects({ runtime });

  const registry = await readProjectsRegistry();
  expect(registry.projects.map((project) => project.name)).toEqual(["legacy"]);
  expect(registry.projects[0]?.repoRoot).toBe(join(tempDir, "legacy"));
});

test("runtime auto-registration skips an input family that changes before registration", async () => {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }
  const projectDir = join(tempDir, "changed", ".hack");
  const composeFile = join(projectDir, "docker-compose.yml");
  await Bun.write(composeFile, "name: changed\nservices:\n  web: {}\n");
  markerBeforeRegistrationFile = composeFile;

  await autoRegisterRuntimeHackProjects({
    runtime: [
      {
        project: "changed",
        workingDir: projectDir,
        services: new Map(),
        isGlobal: false,
      },
    ],
  });

  expect(await Bun.file(join(projectDir, "hack.project.json")).exists()).toBe(
    true
  );
  expect((await readProjectsRegistry()).projects).toEqual([]);
});

function makePsRow(opts: { readonly id: string }): Record<string, string> {
  return {
    ID: opts.id,
    State: memberStates.get(opts.id) ?? "running",
    Status: "Up 10 seconds",
    Names: `container-${opts.id}`,
    Ports: "3000/tcp",
    Labels: [
      "com.docker.compose.project=alpha",
      `com.docker.compose.service=service-${opts.id}`,
      "com.docker.compose.project.working_dir=/tmp/alpha/.hack",
    ].join(","),
  };
}

function makeInspectRow(opts: {
  readonly id: string;
}): Record<string, unknown> {
  return {
    Id: `${opts.id}${"0".repeat(52)}`,
    State: {
      Status: memberStates.get(opts.id) ?? "running",
      ExitCode: memberExitCodes.get(opts.id) ?? 0,
      StartedAt: "2026-01-01T00:00:00Z",
      Health: { Status: "healthy" },
    },
    Config: {
      Image: `image:${opts.id}`,
      Labels: {
        "com.docker.compose.project": "alpha",
        "com.docker.compose.service": `service-${opts.id}`,
        "com.docker.compose.project.working_dir": "/tmp/alpha/.hack",
      },
    },
    Mounts: [],
    NetworkSettings: {
      Networks: {
        "hack-dev": {
          IPAddress: "172.20.0.2",
          Gateway: "172.20.0.1",
          Aliases: [`container-${opts.id}`],
        },
      },
    },
  };
}

test("cached static metadata never becomes fresh service health or start evidence", async () => {
  dockerAvailable = true;
  currentIds = ["aaaaaaaaaaaa"];
  const cache = createRuntimeInspectCache();
  const first = await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: true,
  });
  const cached = await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: false,
  });
  const member = (result: typeof first) =>
    [...(result.runtime[0]?.services.values() ?? [])][0]?.containers[0];
  expect(member(first)?.observation?.health).toBe("healthy");
  expect(member(first)?.observation?.exitCode).toBeNull();
  expect(member(cached)?.observation).toBeNull();
  expect(inspectCalls).toHaveLength(1);
});

test("failed reinspection keeps static identity but clears old current-state evidence", async () => {
  dockerAvailable = true;
  currentIds = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"];
  const cache = createRuntimeInspectCache();
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: true,
  });
  inspectExitCode = 1;
  const result = await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: true,
  });
  const services = result.runtime[0]?.services;
  expect(
    services?.get("service-aaaaaaaaaaaa")?.containers[0]?.observation?.health
  ).toBe("healthy");
  const second = services?.get("service-bbbbbbbbbbbb")?.containers[0];
  expect(second?.image).toBe("image:bbbbbbbbbbbb");
  expect(second?.observation).toBeNull();
});

test("event refresh reinspects changed and terminated IDs without polling unchanged running peers", async () => {
  dockerAvailable = true;
  const job = "aaaaaaaaaaaa";
  const api = "bbbbbbbbbbbb";
  currentIds = [job, api];
  const cache = createRuntimeInspectCache();
  await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: true,
  });
  memberStates.set(job, "exited");
  const finished = await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: false,
  });
  const completed = finished.runtime[0]?.services.get(`service-${job}`)
    ?.containers[0];
  expect(completed?.observation?.exitCode).toBe(0);
  expect(
    finished.runtime[0]?.services.get(`service-${api}`)?.containers[0]
      ?.observation
  ).toBeNull();
  memberExitCodes.set(job, 2);
  const failed = await readRuntimeProjects({
    includeGlobal: true,
    inspectCache: cache,
    forceInspect: false,
  });
  expect(
    failed.runtime[0]?.services.get(`service-${job}`)?.containers[0]
      ?.observation?.exitCode
  ).toBe(2);
  expect(inspectCalls).toEqual([[job, api], [job], [job]]);
});
