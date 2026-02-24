import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import {
  buildProjectViews,
  serializeProjectView,
} from "../src/lib/project-views.ts";

import type { RegisteredProject } from "../src/lib/projects-registry.ts";
import type {
  RuntimeContainer,
  RuntimeProject,
  RuntimeService,
} from "../src/lib/runtime-projects.ts";

let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-views-"));
});

afterEach(async () => {
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
}): RuntimeProject {
  const services = new Map<string, RuntimeService>();
  for (const [service, containers] of Object.entries(
    opts.containersByService
  )) {
    services.set(service, { service, containers });
  }
  return {
    project: opts.name,
    workingDir: `/tmp/${opts.name}/.hack`,
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
        name: "alpha:agent-1",
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
    "alpha:agent-1",
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

test("buildProjectViews includes zellij sessions when session name matches project name", async () => {
  const alpha = await createProject({ name: "alpha", services: ["api"] });

  const views = await buildProjectViews({
    registryProjects: [alpha],
    runtime: [],
    runtimeOk: true,
    filter: null,
    includeUnregistered: false,
    muxSessions: [
      {
        name: "alpha:research",
        backend: "zellij",
        attached: false,
        path: null,
        windows: null,
        createdAt: null,
      },
    ],
  });

  const alphaView = views.find((view) => view.name === "alpha");
  expect(alphaView?.sessions.map((session) => session.name)).toEqual([
    "alpha:research",
  ]);
  expect(alphaView?.sessions.map((session) => session.backend)).toEqual([
    "zellij",
  ]);
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
    process.env.PATH = previousPath;
    await rm(emptyPathDir, { recursive: true, force: true });
  }
});
