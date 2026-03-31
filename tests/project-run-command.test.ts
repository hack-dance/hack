import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";

const runCalls: Array<{
  readonly composeFiles: readonly string[];
  readonly env: Record<string, string> | undefined;
}> = [];
const warnCalls: string[] = [];
const tempDirs = new Set<string>();

mock.module("../src/backends/runtime-backend.ts", () => ({
  composeRuntimeBackend: {
    name: "compose",
    up: async () => 0,
    down: async () => 0,
    psJson: async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
    ps: async () => 0,
    run: async (opts: {
      readonly composeFiles: readonly string[];
      readonly env?: Record<string, string>;
    }) => {
      runCalls.push({
        composeFiles: [...opts.composeFiles],
        env: opts.env ? { ...opts.env } : undefined,
      });
      return 0;
    },
  },
}));

mock.module("../src/ui/logger.ts", () => ({
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
}));

const { runCommand } = await import("../src/commands/project.ts");

afterEach(async () => {
  runCalls.length = 0;
  warnCalls.length = 0;
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

afterAll(() => {
  mock.restore();
});

function expectNoEnvScopeWarnings(): void {
  expect(
    warnCalls.filter((message) => message.startsWith('Env config scope "'))
  ).toEqual([]);
}

test("run applies modern env overlays to service-specific compose overrides", async () => {
  const projectRoot = await createProject();

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: "qa",
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["printenv"],
      },
      raw: {
        argv: ["--path", projectRoot, "--env", "qa", "api", "printenv"],
        positionals: ["api", "printenv"],
      },
    },
  } as unknown as Parameters<typeof runCommand.handler>[0];

  const exitCode = await runCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);

  const call = runCalls[0];
  expect(call).toBeDefined();
  expect(call?.env).toEqual({
    GLOBAL_FLAG: "qa",
    SHARED_KEY: "base",
  });
  expect(call?.composeFiles.length ?? 0).toBeGreaterThanOrEqual(2);

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

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: undefined,
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["printenv"],
      },
      raw: {
        argv: ["--path", projectRoot, "api", "printenv"],
        positionals: ["api", "printenv"],
      },
    },
  } as unknown as Parameters<typeof runCommand.handler>[0];

  const exitCode = await runCommand.handler(input);

  expect(exitCode).toBe(0);
  expectNoEnvScopeWarnings();
});

async function createProject(input?: {
  readonly services?: readonly string[];
  readonly defaultYaml?: string;
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
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "project-run-env-test",
        dev_host: "project-run-env.hack",
      },
      null,
      2
    )}\n`
  );
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
