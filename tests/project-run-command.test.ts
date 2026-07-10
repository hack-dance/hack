import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runCalls: Array<{
  readonly composeFiles: readonly string[];
  readonly env: Record<string, string> | undefined;
  readonly noDeps: boolean | undefined;
}> = [];
const psJsonByComposeProject = new Map<string, string>();
const warnCalls: string[] = [];
const tempDirs = new Set<string>();

const runtimeBackendMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/runtime-backend.ts",
  overrides: {
    composeRuntimeBackend: {
      name: "compose",
      up: async () => 0,
      down: async () => 0,
      psJson: async (opts: { readonly composeFiles: readonly string[] }) => ({
        exitCode: 0,
        stdout: psJsonByComposeProject.get(opts.composeFiles[0] ?? "") ?? "",
        stderr: "",
      }),
      ps: async () => 0,
      run: async (opts: {
        readonly composeFiles: readonly string[];
        readonly env?: Record<string, string>;
        readonly noDeps?: boolean;
      }) => {
        runCalls.push({
          composeFiles: [...opts.composeFiles],
          env: opts.env ? { ...opts.env } : undefined,
          noDeps: opts.noDeps,
        });
        return 0;
      },
    },
  },
});

const loggerMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/ui/logger.ts",
  overrides: {
    logger: {
      debug: () => {},
      info: () => {},
      warn: (input: { readonly message: string }) => {
        warnCalls.push(input.message);
      },
      error: () => {},
      success: () => {},
      step: () => {},
    },
  },
});

const { runCommand } = await import("../src/commands/project.ts");

beforeAll(() => {
  runtimeBackendMock.activate();
  loggerMock.activate();
});

afterEach(async () => {
  runCalls.length = 0;
  psJsonByComposeProject.clear();
  warnCalls.length = 0;
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

afterAll(() => {
  runtimeBackendMock.deactivate();
  loggerMock.deactivate();
});

function expectNoEnvScopeWarnings(): void {
  expect(
    warnCalls.filter((message) => message.startsWith('Env config scope "'))
  ).toEqual([]);
}

async function runPrintenv({
  projectRoot,
  envName,
}: {
  readonly projectRoot: string;
  readonly envName?: string;
}): Promise<number> {
  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: envName,
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["printenv"],
      },
      raw: {
        argv: envName
          ? ["--path", projectRoot, "--env", envName, "api", "printenv"]
          : ["--path", projectRoot, "api", "printenv"],
        positionals: ["api", "printenv"],
      },
    },
  } as unknown as Parameters<typeof runCommand.handler>[0];

  return await runCommand.handler(input);
}

test("run applies modern env overlays to service-specific compose overrides", async () => {
  const projectRoot = await createProject();
  const exitCode = await runPrintenv({ projectRoot, envName: "qa" });

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);

  const call = runCalls[0];
  expect(call).toBeDefined();
  expect(call?.env).toEqual({
    GLOBAL_FLAG: "qa",
    SHARED_KEY: "base",
  });
  expect(call?.noDeps).toBe(false);
  expect(call?.composeFiles.length ?? 0).toBeGreaterThanOrEqual(2);

  const runtimeOverridePath = call?.composeFiles.find((filePath) =>
    filePath.endsWith("compose.runtime.override.yml")
  );
  expect(runtimeOverridePath).toBeDefined();
  if (!runtimeOverridePath) {
    throw new Error("Missing runtime metadata compose override.");
  }
  const runtimeOverrideText = await readFile(runtimeOverridePath, "utf8");
  expect(runtimeOverrideText).toContain("HACK_RUNTIME_METADATA");
  expect(runtimeOverrideText).toContain("https://project-run-env.hack");

  const overridePath = call?.composeFiles.find((filePath) =>
    filePath.endsWith("compose.env.override.yml")
  );
  expect(overridePath).toBeDefined();
  if (!overridePath) {
    throw new Error("Missing env override compose file.");
  }

  const overrideText = await readFile(overridePath, "utf8");
  expect(overrideText).toContain("api:");
  expect(overrideText).toContain("GLOBAL_FLAG: qa");
  expect(overrideText).toContain("SHARED_KEY: base");
  expect(overrideText).toContain('PORT: "4000"');
  expect(overrideText).toContain("SERVICE_TOKEN: overlay-secret");
  expectNoEnvScopeWarnings();
});

test("run does not warn about sibling service scopes in modern env configs", async () => {
  const projectRoot = await createProject({
    services: ["api", "worker"],
    defaultYaml: [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    SHARED_KEY: "base"',
      "  api:",
      '    PORT: "3000"',
      "  worker:",
      '    WORKER_FLAG: "1"',
      "  host:",
      '    API_BASE_URL: "http://127.0.0.1:3000"',
      "",
    ].join("\n"),
  });

  const exitCode = await runPrintenv({ projectRoot });

  expect(exitCode).toBe(0);
  expect(runCalls[0]?.noDeps).toBe(false);
  expectNoEnvScopeWarnings();
});

const runDependencyScenarios = [
  {
    name: "skips dependency startup when the local base stack is already up",
    createProjectInput: {
      runningServices: ["api"],
    },
    envName: undefined,
    expectedNoDeps: true,
  },
  {
    name: "keeps dependency startup when runtime state exists but the target service is not running",
    createProjectInput: {
      runtimeComposeProject: "project-run-env-test",
    },
    envName: undefined,
    expectedNoDeps: false,
  },
  {
    name: "keeps dependency startup when the requested overlay differs from the live stack env",
    createProjectInput: {
      runtimeComposeProject: "project-run-env-test",
      runningServices: ["api"],
    },
    envName: "qa",
    expectedNoDeps: false,
  },
  {
    name: "skips dependency startup when omitted env resolves to the live default overlay",
    createProjectInput: {
      config: {
        env: {
          defaultOverlay: "qa",
        },
      },
      runtimeComposeProject: "project-run-env-test",
      runtimeEnvName: "qa",
      runningServices: ["api"],
    },
    envName: undefined,
    expectedNoDeps: true,
  },
  {
    name: "keeps dependency startup when explicit base bypasses a matching default overlay stack",
    createProjectInput: {
      config: {
        env: {
          defaultOverlay: "qa",
        },
      },
      runtimeComposeProject: "project-run-env-test",
      runtimeEnvName: "qa",
      runningServices: ["api"],
    },
    envName: "base",
    expectedNoDeps: false,
  },
  {
    name: "keeps dependency startup when omitted env resolves to qa but the live stack recorded base",
    createProjectInput: {
      config: {
        env: {
          defaultOverlay: "qa",
        },
      },
      runtimeComposeProject: "project-run-env-test",
      runtimeEnvName: null,
      runningServices: ["api"],
    },
    envName: undefined,
    expectedNoDeps: false,
  },
] as const;

for (const scenario of runDependencyScenarios) {
  test(scenario.name, async () => {
    const projectRoot = await createProject(scenario.createProjectInput);
    const exitCode = await runPrintenv({
      projectRoot,
      envName: scenario.envName,
    });

    expect(exitCode).toBe(0);
    expect(runCalls[0]?.noDeps).toBe(scenario.expectedNoDeps);
  });
}

async function createProject(input?: {
  readonly services?: readonly string[];
  readonly defaultYaml?: string;
  readonly runtimeComposeProject?: string;
  readonly runtimeEnvName?: string | null;
  readonly runningServices?: readonly string[];
  readonly config?: Record<string, unknown>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-project-run-env-"));
  tempDirs.add(root);

  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  const services = input?.services ?? ["api"];
  const composeServices = services
    .map((service) => `  ${service}:\n    image: alpine:3.20\n`)
    .join("");

  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    `services:\n${composeServices}`
  );
  const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME);
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "project-run-env-test",
        dev_host: "project-run-env.hack",
        ...(input?.config ?? {}),
      },
      null,
      2
    )}\n`
  );
  if (input?.runtimeComposeProject) {
    await mkdir(resolve(projectDir, ".internal"), { recursive: true });
    await writeFile(
      resolve(projectDir, ".internal", "runtime-state.json"),
      `${JSON.stringify(
        {
          entries: [
            {
              composeProject: input.runtimeComposeProject,
              envName: input.runtimeEnvName ?? null,
              updatedAt: "2026-03-31T00:00:00.000Z",
            },
          ],
        },
        null,
        2
      )}\n`
    );
  }
  const psLines =
    input?.runningServices?.map((service) =>
      JSON.stringify({
        Service: service,
        State: "running",
      })
    ) ?? [];
  psJsonByComposeProject.set(composeFile, psLines.join("\n"));
  await writeFile(
    resolve(projectDir, "hack.env.default.yaml"),
    input?.defaultYaml ??
      [
        "version: 1",
        "environment: default",
        "secretsprovider: project_key",
        "values:",
        "  global:",
        '    GLOBAL_FLAG: "base"',
        '    SHARED_KEY: "base"',
        "  api:",
        '    PORT: "3000"',
        "",
      ].join("\n")
  );
  await writeFile(
    resolve(projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    GLOBAL_FLAG: "qa"',
      "  api:",
      '    PORT: "4000"',
      '    SERVICE_TOKEN: "overlay-secret"',
      "",
    ].join("\n")
  );

  return projectRoot;
}
