import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { HACK_PROJECT_DIR_PRIMARY } from "../src/constants.ts";
import type { ProjectMeta } from "../src/lib/project-meta.ts";
import type { ProjectView } from "../src/lib/project-views.ts";
import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import type { RuntimeProject } from "../src/lib/runtime-projects.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runtimeQueue: Array<{
  readonly ok: boolean;
  readonly runtime: readonly RuntimeProject[];
  readonly error: string | null;
  readonly checkedAtMs: number;
}> = [];
const identityQueue: Array<
  | {
      readonly ok: true;
      readonly identity: {
        readonly dockerHost: string | null;
        readonly socketPath: string | null;
        readonly socketInode: number | null;
        readonly engineId: string | null;
        readonly engineName: string | null;
        readonly engineVersion: string | null;
      };
    }
  | { readonly ok: false; readonly error: string }
> = [];
const autoRegisterCalls: RuntimeProject[][] = [];

const runtimeProjectsMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/runtime-projects.ts",
  overrides: {
    readRuntimeProjects: async () =>
      runtimeQueue.shift() ?? {
        ok: true,
        runtime: [],
        error: null,
        checkedAtMs: Date.now(),
      },
    autoRegisterRuntimeHackProjects: async (opts: {
      readonly runtime: RuntimeProject[];
    }) => {
      autoRegisterCalls.push(opts.runtime);
    },
    filterRuntimeProjects: (opts: {
      readonly runtime: readonly RuntimeProject[];
      readonly includeGlobal: boolean;
    }) =>
      opts.includeGlobal
        ? opts.runtime
        : opts.runtime.filter((project) => !project.isGlobal),
  },
});

const runtimeHealthMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/daemon/runtime-health.ts",
  overrides: {
    readRuntimeIdentity: async () =>
      identityQueue.shift() ?? {
        ok: true,
        identity: {
          dockerHost: null,
          socketPath: null,
          socketInode: null,
          engineId: "default",
          engineName: null,
          engineVersion: null,
        },
      },
    buildRuntimeFingerprint: (opts: {
      readonly identity: { readonly engineId: string | null };
    }) => opts.identity.engineId ?? "unknown",
  },
});

const { createRuntimeCache } = await import("../src/daemon/runtime-cache.ts");

beforeAll(() => {
  runtimeProjectsMock.activate();
  runtimeHealthMock.activate();
});

beforeEach(() => {
  runtimeQueue.length = 0;
  identityQueue.length = 0;
  autoRegisterCalls.length = 0;
});

afterAll(() => {
  runtimeProjectsMock.deactivate();
  runtimeHealthMock.deactivate();
});

test("runtime cache refresh records healthy snapshot", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map([
        [
          "app",
          {
            service: "app",
            containers: [
              {
                id: "alpha-app-1",
                project: "alpha",
                service: "app",
                state: "running",
                status: "Up 10 seconds",
                name: "alpha-app-1",
                ports: "",
                workingDir: "/tmp/alpha/.hack",
                image: "imbios/bun-node:latest",
                labels: null,
                mounts: [],
                networks: [],
              },
            ],
          },
        ],
      ]),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "test" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.runtime).toEqual(runtime);
  expect(snapshot?.health.ok).toBe(true);
  expect(snapshot?.health.error).toBe(null);
  expect(autoRegisterCalls.length).toBe(1);
});

test("getProjectsPayload keeps working when resolveProjectMeta fails for one project", async () => {
  const createdAt = new Date().toISOString();

  const projects: RegisteredProject[] = [
    {
      id: "ok",
      name: "ok",
      repoRoot: "/tmp/ok",
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: "/tmp/ok/.hack",
      createdAt,
    },
    {
      id: "bad",
      name: "bad",
      repoRoot: "/tmp/bad",
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: "/tmp/bad/.hack",
      createdAt,
    },
  ];

  const makeView = (name: string): ProjectView => ({
    name,
    devHost: null,
    repoRoot: null,
    projectDir: null,
    definedServices: null,
    extensionsEnabled: null,
    features: null,
    serviceHosts: null,
    runtimeConfigured: null,
    runtimeStatus: "unknown",
    runtime: null,
    branchRuntime: [],
    sessions: [],
    lifecycle: null,
    ownership: null,
    worktrees: null,
    kind: "registered",
    status: "unknown",
  });

  const cache = createRuntimeCache({
    deps: {
      readProjectsRegistry: async () => ({ version: 1, projects }),
      buildProjectViews: async () => [makeView("ok"), makeView("bad")],
      serializeProjectView: (view) => ({ name: view.name, kind: view.kind }),
      resolveProjectMeta: async (opts) => {
        if (opts.projectName === "bad") {
          throw new Error("boom");
        }
        const meta: ProjectMeta = {
          git: {
            isRepo: false,
            head: null,
            branch: null,
            detached: null,
            dirty: null,
            localBranchCount: null,
            worktrees: null,
            error: null,
          },
          hackBranches: { path: "", parseError: null, branches: [] },
          env: {
            contractPath: "",
            contractExists: false,
            contractParseError: null,
            vars: [],
            missingRequired: [],
          },
          sessions: { sessions: [] },
          composeBuild: { services: [] },
          ownership: null,
          configError: null,
        };
        return meta;
      },
    },
  });

  await cache.refresh({ reason: "test" });

  const payload = await cache.getProjectsPayload({
    filter: null,
    includeGlobal: true,
    includeUnregistered: true,
    includeMeta: true,
  });

  expect(payload.projects.length).toBe(2);
  expect(payload.projects[0]).toMatchObject({
    name: "ok",
    meta: {
      git: {
        isRepo: false,
        head: null,
        branch: null,
        detached: null,
        dirty: null,
        localBranchCount: null,
        worktrees: null,
        error: null,
      },
      hackBranches: { path: "", parseError: null, branches: [] },
      env: {
        contractPath: "",
        contractExists: false,
        contractParseError: null,
        vars: [],
        missingRequired: [],
      },
      sessions: { sessions: [] },
      composeBuild: { services: [] },
    },
  });
  expect(payload.projects[1]).toMatchObject({
    name: "bad",
    meta: null,
  });
});

test("runtime cache retains last runtime on failure", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map(),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: false,
    runtime: [],
    error: "docker down",
    checkedAtMs: Date.now(),
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "prime" });
  await cache.refresh({ reason: "fail" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.runtime).toEqual(runtime);
  expect(snapshot?.health.ok).toBe(false);
  expect(snapshot?.health.error).toBe("docker down");
});

test("runtime cache detects runtime resets via fingerprint", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map(),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-b",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-b",
      engineName: "docker-desktop",
      engineVersion: "27.0.0",
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "prime" });
  await cache.refresh({ reason: "reset" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.health.resetCount).toBe(1);
  expect(snapshot?.health.lastResetAtMs).not.toBeNull();
  expect(snapshot?.health.lastResetSummary).toContain("engine id");
  expect(snapshot?.health.lastResetChanges).toEqual(["engine_id"]);
  expect(snapshot?.health.lastRepairAction).toBe("refresh_runtime_snapshot");
  expect(snapshot?.health.lastRepairOutcome).toBe("stabilized");
  expect(snapshot?.health.nextStep).toBe(null);
  expect(autoRegisterCalls.length).toBe(3);
});

test("runtime cache gives a clear next step when reset repair cannot restore prior runtime", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map([
        [
          "app",
          {
            service: "app",
            containers: [
              {
                id: "alpha-app-1",
                project: "alpha",
                service: "app",
                state: "running",
                status: "Up 10 seconds",
                name: "alpha-app-1",
                ports: "",
                workingDir: "/tmp/alpha/.hack",
                image: "imbios/bun-node:latest",
                labels: null,
                mounts: [],
                networks: [],
              },
            ],
          },
        ],
      ]),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: true,
    runtime: [],
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-b",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: true,
    runtime: [],
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-b",
      engineName: null,
      engineVersion: null,
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "prime" });
  await cache.refresh({ reason: "reset" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.health.lastRepairOutcome).toBe("manual_action_required");
  expect(snapshot?.health.nextStep).toContain("hack up");
});

test("getPsPayload matches normalized compose project names", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "dimitrisubstrate",
      workingDir: "/tmp/personal-substrate/.hack",
      services: new Map([
        [
          "app",
          {
            service: "app",
            containers: [
              {
                id: "container-app",
                project: "dimitrisubstrate",
                service: "app",
                state: "running",
                status: "Up 3 minutes",
                name: "dimitrisubstrate-app-1",
                ports: "3000/tcp",
                workingDir: "/tmp/personal-substrate/.hack",
                image: "imbios/bun-node:latest",
                labels: null,
                mounts: [],
                networks: [],
              },
            ],
          },
        ],
      ]),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "ps" });

  const payload = cache.getPsPayload({
    composeProject: "dimitri.substrate",
    project: "dimitri.substrate",
    branch: null,
  });
  expect(payload.items).toEqual([
    {
      Service: "app",
      Name: "dimitrisubstrate-app-1",
      Status: "Up 3 minutes",
      Ports: "3000/tcp",
    },
  ]);
});
