import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import {
  buildProjectViews,
  serializeProjectSummary,
  serializeProjectView,
} from "../src/lib/project-views.ts";

import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
  RuntimeService,
} from "../src/lib/runtime-projects.ts";
import { restoreEnv } from "./helpers/env.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let tempDir: string | null = null;
let originalGlobalConfigPath: string | undefined;
let blockedReadRoot: string | null = null;
const blockedReadPaths: string[] = [];
let nativeReadCount = 0;
let nativeActive = 0;
let nativePeak = 0;
const nativeObservationMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/project-native-observation.ts",
  overrides: {
    observeNativeProject: async () => {
      nativeReadCount++;
      nativeActive++;
      nativePeak = Math.max(nativePeak, nativeActive);
      await new Promise((resolve) => setTimeout(resolve, 5));
      nativeActive--;
      return {
        backend: "native",
        state: "running",
        state_reason: null,
        started_at: null,
        services: [
          {
            name: "api",
            state: "running",
            ready: true,
            completed: null,
            health: "healthy",
            exit_code: null,
            started_at: null,
          },
        ],
      };
    },
  },
});

const projectReadMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/fs.ts",
  overrides: {
    readTextFile: async (file: string) => {
      if (blockedReadRoot && file.startsWith(`${blockedReadRoot}/`)) {
        blockedReadPaths.push(file);
        throw new Error("Legacy input must not be read under a native marker");
      }
      try {
        return await Bun.file(file).text();
      } catch {
        return null;
      }
    },
  },
});

beforeAll(() => {
  projectReadMock.activate();
  nativeObservationMock.activate();
});

afterAll(() => {
  projectReadMock.deactivate();
  nativeObservationMock.deactivate();
});

beforeEach(async () => {
  nativeReadCount = 0;
  nativeActive = 0;
  nativePeak = 0;
  blockedReadRoot = null;
  blockedReadPaths.length = 0;
  tempDir = await mkdtemp(join(tmpdir(), "hack-views-"));
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(tempDir, "global.config.json");
});

afterEach(async () => {
  if (originalGlobalConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function createProject(opts: {
  readonly name: string;
  readonly services: readonly string[];
  readonly serviceHosts?: Record<string, readonly string[]>;
  readonly configJson?: string;
}): Promise<RegisteredProject> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const projectRoot = join(tempDir, opts.name);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  const composeLines = ["services:"];
  for (const svc of opts.services) {
    const hosts = opts.serviceHosts?.[svc] ?? null;
    if (!hosts) {
      composeLines.push(`  ${svc}: {}`);
      continue;
    }
    composeLines.push(`  ${svc}:`);
    composeLines.push("    labels:");
    composeLines.push(`      caddy: "${hosts.join(", ")}"`);
  }
  await writeFile(
    join(projectDir, PROJECT_COMPOSE_FILENAME),
    `${composeLines.join("\n")}\n`
  );
  if (opts.configJson) {
    await writeFile(join(projectDir, PROJECT_CONFIG_FILENAME), opts.configJson);
  }

  return {
    id: `${opts.name}-id`,
    name: opts.name,
    repoRoot: projectRoot,
    projectDirName: ".hack",
    projectDir,
    devHost: `${opts.name}.hack`,
    createdAt: "2025-01-01T00:00:00Z",
  };
}

function makeRuntimeProject(opts: {
  readonly name: string;
  readonly containersByService: Record<string, RuntimeContainer[]>;
  readonly isGlobal?: boolean;
  readonly workingDir?: string | null;
}): RuntimeProject {
  const services = new Map<string, RuntimeService>();
  for (const [service, containers] of Object.entries(
    opts.containersByService
  )) {
    services.set(service, { service, containers });
  }
  return {
    project: opts.name,
    workingDir: opts.workingDir ?? `/tmp/${opts.name}/.hack`,
    services,
    isGlobal: opts.isGlobal ?? false,
  };
}

function makeContainer(opts: {
  readonly project: string;
  readonly service: string;
  readonly name: string;
  readonly state: string;
}): RuntimeContainer {
  return {
    id: `${opts.project}-${opts.service}-${opts.name}`,
    project: opts.project,
    service: opts.service,
    state: opts.state,
    status: opts.state === "running" ? "Up 5s" : "Exited (0)",
    name: opts.name,
    ports: "",
    workingDir: `/tmp/${opts.project}/.hack`,
    image: "imbios/bun-node:latest",
    labels: {
      "com.docker.compose.project": opts.project,
      "com.docker.compose.service": opts.service,
    },
    mounts: [],
    networks: [],
  };
}

test("buildProjectViews includes defined services and runtime status", async () => {
  const alpha = await createProject({
    name: "alpha",
    services: ["api", "web"],
    serviceHosts: {
      api: ["api.alpha.hack", "api.alpha.hack.gy"],
    },
  });
  const runtime = [
    makeRuntimeProject({
      name: "alpha",
      containersByService: {
        api: [
          makeContainer({
            project: "alpha",
            service: "api",
            name: "alpha-api-1",
            state: "running",
          }),
        ],
      },
    }),
    makeRuntimeProject({
      name: "beta",
      containersByService: {
        web: [
          makeContainer({
            project: "beta",
            service: "web",
            name: "beta-web-1",
            state: "exited",
          }),
        ],
      },
    }),
  ];

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime,
    runtimeOk: true,
    filter: null,
    includeUnregistered: true,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.definedServices).toEqual(["api", "web"]);
  expect(alphaView?.status).toBe("running");
  expect(alphaView?.projectId).toBe("alpha-id");
  expect(alphaView?.serviceHosts?.api).toEqual([
    "api.alpha.hack",
    "api.alpha.hack.gy",
  ]);

  const betaView = views.find((view) => view.name === "beta");
  expect(betaView?.status).toBe("unregistered");

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  expect(serialized?.defined_services).toEqual(["api", "web"]);
  expect(serialized?.project_id).toBe("alpha-id");
  expect(serialized?.service_hosts).toEqual({
    api: ["api.alpha.hack", "api.alpha.hack.gy"],
  });
});

test("buildProjectViews filters retired extensions from upgraded configs", async () => {
  const project = await createProject({
    name: "legacy-extensions",
    services: [],
    configJson: JSON.stringify({
      controlPlane: {
        extensions: {
          "dance.example.custom": { enabled: true },
          "dance.hack.github": { enabled: true },
          "dance.hack.linear": { enabled: true },
          "dance.hack.tickets": { enabled: true },
        },
      },
    }),
  });

  const views = await buildProjectViews({
    registryProjects: [project],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  expect(views[0]?.extensionsEnabled).toEqual(["dance.example.custom"]);
  expect(views[0]?.features).toEqual(["dance.example.custom"]);
});

for (const legacyDir of [null, ".hack", ".dev"] as const) {
  test(`native ${legacyDir ? `plus ${legacyDir}` : "only"} registered roots are unavailable without reading legacy files`, async () => {
    const blocked = await createProject({ name: "blocked", services: [] });
    const healthy = await createProject({ name: "healthy", services: ["web"] });
    await rm(join(blocked.projectDir, PROJECT_COMPOSE_FILENAME));
    await mkdir(join(blocked.projectDir, "hack.project.json"));
    if (legacyDir) {
      const legacyProjectDir = join(blocked.repoRoot, legacyDir);
      await mkdir(join(legacyProjectDir, PROJECT_COMPOSE_FILENAME), {
        recursive: true,
      });
      await mkdir(join(legacyProjectDir, PROJECT_CONFIG_FILENAME), {
        recursive: true,
      });
    }
    const runtime = makeRuntimeProject({
      name: blocked.name,
      workingDir: blocked.projectDir,
      containersByService: {
        web: [
          makeContainer({
            project: blocked.name,
            service: "web",
            name: "old-web",
            state: "running",
          }),
        ],
      },
    });
    blockedReadRoot = blocked.repoRoot;

    const views = await buildProjectViews({
      registryProjects: [blocked, healthy],
      runtime: [runtime],
      runtimeOk: true,
      filter: null,
      includeUnregistered: true,
      muxSessions: [],
    });

    expect(views).toHaveLength(2);
    expect(blockedReadPaths).toEqual([]);
    const blockedView = views.find((view) => view.name === blocked.name);
    expect(blockedView?.status).toBe("unavailable");
    expect(blockedView?.runtimeStatus).toBe("unavailable");
    expect(blockedView?.inputDiagnostic?.code).toBe(
      legacyDir ? "E_NATIVE_PROJECT_CONFLICT" : "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    expect(blockedView?.definedServices).toBeNull();
    expect(blockedView?.extensionsEnabled).toBeNull();
    expect(blockedView?.lifecycle).toBeNull();
    expect(blockedView?.runtime).toBeNull();
    expect(
      views.find((view) => view.name === healthy.name)?.definedServices
    ).toEqual(["web"]);
    if (!blockedView) {
      throw new Error("Missing blocked project view");
    }
    for (const serialized of [
      serializeProjectView(blockedView),
      serializeProjectSummary(blockedView),
    ]) {
      expect(serialized.status).toBe("unavailable");
      expect(serialized.input_diagnostic).toEqual(blockedView.inputDiagnostic);
    }
  });
}

test("buildProjectViews includes explicit project ownership metadata", async () => {
  const alpha = await createProject({
    name: "alpha",
    services: ["api"],
    configJson: JSON.stringify(
      {
        ownership: {
          mode: "shared",
          owner_type: "team",
          owner_id: "team_alpha",
        },
      },
      null,
      2
    ),
  });

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.ownership).toEqual({
    mode: "shared",
    ownerType: "team",
    ownerId: "team_alpha",
    managedBy: "broker",
  });

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  expect(serialized?.ownership).toEqual({
    mode: "shared",
    owner_type: "team",
    owner_id: "team_alpha",
    managed_by: "broker",
  });
});

test("buildProjectViews omits ownership when config parsing fails", async () => {
  const alpha = await createProject({
    name: "alpha",
    services: ["api"],
    configJson: "{ invalid json",
  });

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.ownership).toBeNull();

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  expect(serialized?.ownership).toBeNull();
});

test("buildProjectViews includes lifecycle and startup summaries", async () => {
  const lifecycleConfig = JSON.stringify(
    {
      startup: [
        { name: "aws sso", run: "aws sso login" },
        {
          name: "ssm proxy",
          run: "cd packages/infra && bun run proxy",
          persistent: true,
        },
      ],
      lifecycle: {
        down: {
          before: [{ name: "cleanup", command: "bun run cleanup" }],
        },
      },
    },
    null,
    2
  );

  const alpha = await createProject({
    name: "alpha",
    services: ["api"],
    configJson: lifecycleConfig,
  });
  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.lifecycle?.upBefore.length).toBe(1);
  expect(alphaView?.lifecycle?.upBefore[0]?.service).toBe("aws sso");
  expect(alphaView?.lifecycle?.processes.length).toBe(1);
  expect(alphaView?.lifecycle?.processes[0]?.service).toBe("ssm proxy");
  expect(alphaView?.lifecycle?.downBefore.length).toBe(1);

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  const lifecycle = serialized?.lifecycle as
    | Record<string, unknown>
    | undefined;
  expect(Array.isArray(lifecycle?.up_before)).toBe(true);
  expect(Array.isArray(lifecycle?.processes)).toBe(true);
});

test("buildProjectViews preserves persistent lifecycle hook flags", async () => {
  const lifecycleConfig = JSON.stringify(
    {
      lifecycle: {
        up: {
          before: [
            { name: "proxy", command: "bun run proxy", persistent: true },
          ],
        },
      },
    },
    null,
    2
  );

  const alpha = await createProject({
    name: "alpha",
    services: ["api"],
    configJson: lifecycleConfig,
  });
  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.lifecycle?.upBefore[0]?.persistent).toBe(true);

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  const lifecycle = serialized?.lifecycle as
    | Record<string, unknown>
    | undefined;
  const upBefore = (lifecycle?.up_before ?? []) as Record<string, unknown>[];
  expect(upBefore[0]?.persistent).toBe(true);
});

test("buildProjectViews marks runtime status unknown when runtime is unavailable", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });
  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: false,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.status).toBe("unknown");
});

test("buildProjectViews includes matching project sessions from tmux", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });
  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [
      {
        name: "alpha",
        backend: "tmux",
        attached: true,
        path: alpha.repoRoot,
        windows: 2,
        createdAt: 1_735_000_000,
      },
      {
        name: "alpha--agent-1",
        backend: "tmux",
        attached: false,
        path: join(alpha.repoRoot, "apps"),
        windows: 1,
        createdAt: 1_735_000_123,
      },
      {
        name: "manual-scratch",
        backend: "tmux",
        attached: false,
        path: alpha.repoRoot,
        windows: 1,
        createdAt: 1_735_000_456,
      },
      {
        name: "other",
        backend: "tmux",
        attached: false,
        path: "/tmp/other",
        windows: 1,
        createdAt: 1_735_000_789,
      },
    ],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.sessions.map((session) => session.name)).toEqual([
    "alpha",
    "alpha--agent-1",
    "manual-scratch",
  ]);
  expect(alphaView?.sessions.map((session) => session.source)).toEqual([
    "hack",
    "hack",
    "external",
  ]);

  const serialized = alphaView ? serializeProjectView(alphaView) : null;
  const serializedSessions = serialized?.sessions as
    | Record<string, unknown>[]
    | undefined;
  expect(serializedSessions?.length).toBe(3);
  expect(serializedSessions?.[0]?.name).toBe("alpha");
  expect(serializedSessions?.[0]?.backend).toBe("tmux");
  expect(serializedSessions?.[0]?.source).toBe("hack");
});

test("buildProjectViews treats double-dash and legacy colon hack sessions as project sessions", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [
      {
        name: "alpha--agent-1",
        backend: "tmux",
        attached: false,
        path: null,
        windows: 1,
        createdAt: 1_735_000_100,
      },
      {
        name: "alpha:agent-legacy",
        backend: "tmux",
        attached: false,
        path: null,
        windows: 1,
        createdAt: 1_735_000_101,
      },
    ],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.sessions.map((session) => session.name)).toEqual([
    "alpha--agent-1",
    "alpha:agent-legacy",
  ]);
  expect(alphaView?.sessions.map((session) => session.source)).toEqual([
    "hack",
    "hack",
  ]);
});

test("buildProjectViews matches tmux sessions when path is a symlink to repo root", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });
  if (!tempDir) {
    throw new Error("tempDir not set");
  }

  const aliasPath = join(tempDir, "alpha-alias");
  await symlink(alpha.repoRoot, aliasPath);

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [
      {
        name: "manual-alpha-shell",
        backend: "tmux",
        attached: false,
        path: aliasPath,
        windows: 1,
        createdAt: 1_735_111_000,
      },
    ],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.sessions.map((session) => session.name)).toEqual([
    "manual-alpha-shell",
  ]);
});

test("buildProjectViews includes tmux sessions when session name matches project name", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [
      {
        name: "alpha--research",
        backend: "tmux",
        attached: false,
        path: null,
        windows: null,
        createdAt: null,
      },
    ],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.sessions.map((session) => session.name)).toEqual([
    "alpha--research",
  ]);
  expect(alphaView?.sessions.map((session) => session.backend)).toEqual([
    "tmux",
  ]);
});

test("buildProjectViews matches runtime by working directory when compose project slug differs", async () => {
  const dottedProject = await createProject({
    name: "sample.dotted",
    services: ["app", "qdrant"],
  });
  const runtime = [
    makeRuntimeProject({
      name: "sampledotted",
      workingDir: dottedProject.projectDir,
      containersByService: {
        app: [
          makeContainer({
            project: "sampledotted",
            service: "app",
            name: "sampledotted-app-1",
            state: "running",
          }),
        ],
        qdrant: [
          makeContainer({
            project: "sampledotted",
            service: "qdrant",
            name: "sampledotted-qdrant-1",
            state: "running",
          }),
        ],
      },
    }),
  ];

  const views = await buildProjectViews({
    registryProjects: [dottedProject],
    runtime,
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });

  const view = views.find((entry) => entry.name === dottedProject.name);
  expect(view?.runtime?.project).toBe("sampledotted");
  expect(view?.runtimeStatus).toBe("running");
  expect(view?.status).toBe("running");
});

test("buildProjectViews tolerates missing optional mux binaries", async () => {
  const emptyPathDir = await mkdtemp(join(tmpdir(), "hack-empty-path-"));
  const previousPath = process.env.PATH;
  process.env.PATH = emptyPathDir;

  try {
    const views = await buildProjectViews({
      registryProjects: [],
      runtime: [],
      runtimeOk: true,
      filter: null,
      includeUnregistered: false,
    });
    expect(views).toEqual([]);
  } finally {
    restoreEnv("PATH", previousPath);
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});

test("project views accept an unambiguous legacy alias without rewriting runtime identity", async () => {
  const legacy = await createProject({ name: "my_app", services: [] });
  const runtime = makeRuntimeProject({
    name: "original_runtime",
    containersByService: {},
    workingDir: legacy.projectDir,
  });
  const views = await buildProjectViews({
    registryProjects: [legacy],
    runtime: [runtime],
    runtimeOk: true,
    filter: "my-app",
    includeUnregistered: true,
  });
  expect(views).toHaveLength(1);
  expect(views[0]?.name).toBe("my_app");
  expect(views[0]?.runtime?.project).toBe("original_runtime");
  const other = await createProject({ name: "my-app", services: [] });
  await expect(
    buildProjectViews({
      registryProjects: [legacy, other],
      runtime: [],
      runtimeOk: true,
      filter: "my_app",
      includeUnregistered: true,
    })
  ).rejects.toThrow("Ambiguous project name");
});

test("full and summary rows share Compose state, readiness, completion and timestamps", async () => {
  const registration = await createProject({
    name: "state-fixture",
    services: ["api", "task"],
  });
  await writeFile(
    join(registration.projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    depends_on:\n      task: {condition: service_completed_successfully}\n  task: {}\n"
  );
  const api = {
    ...makeContainer({
      project: registration.name,
      service: "api",
      name: "api",
      state: "running",
    }),
    observation: {
      state: "running",
      health: null,
      exitCode: null,
      startedAt: "2026-01-01T00:00:00Z",
    },
  };
  const task = {
    ...makeContainer({
      project: registration.name,
      service: "task",
      name: "task",
      state: "exited",
    }),
    observation: {
      state: "exited",
      health: null,
      exitCode: 0,
      startedAt: "2026-01-01T00:00:01Z",
    },
  };
  const views = await buildProjectViews({
    registryProjects: [registration],
    runtime: [
      makeRuntimeProject({
        name: registration.name,
        workingDir: registration.projectDir,
        containersByService: { api: [api], task: [task] },
      }),
    ],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });
  const view = views[0];
  if (!view) {
    throw new Error("missing fixture view");
  }
  const full = serializeProjectView(view);
  const summary = serializeProjectSummary(view);
  for (const key of ["backend", "state", "services", "started_at"]) {
    expect(summary[key]).toEqual(full[key]);
  }
  expect(full.backend).toBe("compose");
  expect(full.state).toBe("running");
  expect(full.started_at).toBe("2026-01-01T00:00:00Z");
  expect(full.services).toMatchObject([
    { name: "api", ready: true },
    { name: "task", completed: true, exit_code: 0 },
  ]);
});

test("registered authored native rows use the observer only with explicit live-read admission", async () => {
  const registration = await createProject({
    name: "native-observed",
    services: ["api"],
  });
  await rm(join(registration.projectDir, PROJECT_COMPOSE_FILENAME));
  await writeFile(join(registration.projectDir, "hack.project.json"), "{}\n");
  blockedReadRoot = registration.repoRoot;
  const options = {
    registryProjects: [registration],
    runtime: [],
    runtimeOk: false,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  };
  const passive = await buildProjectViews(options);
  expect(nativeReadCount).toBe(0);
  expect(passive[0]?.observation?.state).toBe("unknown");
  const live = await buildProjectViews({ ...options, observeNative: true });
  expect(nativeReadCount).toBe(1);
  const row = live[0];
  if (!row) {
    throw new Error("missing native row");
  }
  expect(serializeProjectView(row)).toMatchObject({
    backend: "native",
    state: "running",
  });
  expect(serializeProjectSummary(row).services).toEqual(
    serializeProjectView(row).services
  );
  expect(blockedReadPaths).toEqual([]);
});

test("native listing bounds status subprocess fan-out regardless of registry size", async () => {
  const registrations: RegisteredProject[] = [];
  for (let index = 0; index < 9; index++) {
    const registration = await createProject({
      name: `native-${index}`,
      services: [],
    });
    await rm(join(registration.projectDir, PROJECT_COMPOSE_FILENAME));
    await writeFile(join(registration.projectDir, "hack.project.json"), "{}\n");
    registrations.push(registration);
  }
  const views = await buildProjectViews({
    registryProjects: registrations,
    runtime: [],
    runtimeOk: false,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
    observeNative: true,
  });
  expect(views).toHaveLength(9);
  expect(nativeReadCount).toBe(9);
  expect(nativePeak).toBe(4);
  expect(nativeActive).toBe(0);
});

test.each([
  { dependency: "", member: "absent", expected: "running" },
  {
    dependency: "    depends_on: [tool]\n",
    member: "absent",
    expected: "degraded",
  },
  {
    dependency: "    depends_on:\n      tool: {required: false}\n",
    member: "absent",
    expected: "running",
  },
  { dependency: "", member: "exited", expected: "degraded" },
])("profile activation keeps required aggregation honest: %j", async ({
  dependency,
  member,
  expected,
}) => {
  const registration = await createProject({
    name: "profiles-fixture",
    services: ["api", "tool"],
  });
  await writeFile(
    join(registration.projectDir, PROJECT_COMPOSE_FILENAME),
    `services:\n  api:\n    image: example\n${dependency}  tool:\n    image: example\n    profiles: [tools]\n`
  );
  const api = makeContainer({
    project: registration.name,
    service: "api",
    name: "api",
    state: "running",
  });
  const tools =
    member === "absent"
      ? []
      : [
          {
            ...makeContainer({
              project: registration.name,
              service: "tool",
              name: "tool",
              state: member,
            }),
            observation: {
              state: member,
              health: null,
              exitCode: 0,
              startedAt: null,
            },
          },
        ];
  const [view] = await buildProjectViews({
    registryProjects: [registration],
    runtime: [
      makeRuntimeProject({
        name: registration.name,
        workingDir: registration.projectDir,
        containersByService: {
          api: [api],
          ...(tools.length ? { tool: tools } : {}),
        },
      }),
    ],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [],
  });
  if (!view) {
    throw new Error("missing fixture view");
  }
  expect(serializeProjectView(view).state).toBe(expected);
  expect(serializeProjectSummary(view).state).toBe(expected);
  expect(view.observation?.services).toHaveLength(2);
});
