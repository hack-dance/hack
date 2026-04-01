import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandHandlerFor } from "../src/cli/command.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";

const runCalls: Array<{
  readonly cmd: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
}> = [];
const tempDirs = new Set<string>();
const originalShell = process.env.SHELL;

mock.module("../src/lib/shell.ts", () => ({
  run: async (
    cmd: readonly string[],
    opts: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {}
  ) => {
    runCalls.push({
      cmd: [...cmd],
      cwd: opts.cwd,
      env: opts.env ? { ...opts.env } : undefined,
    });
    return 0;
  },
}));

const { envCommand, hostCommand } = await import("../src/commands/env.ts");

afterEach(async () => {
  runCalls.length = 0;
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  process.env.SHELL = originalShell;
});

afterAll(() => {
  mock.restore();
});

test("env exec injects merged overlay env into one-off host commands", async () => {
  const projectRoot = await createProject();
  const execCommand = findSubcommand("exec");

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
        service: "api",
        target: undefined,
      },
      positionals: {
        command: ["bun", "db:migrate"],
      },
      raw: {
        argv: [
          "--path",
          projectRoot,
          "--env",
          "qa",
          "--service",
          "api",
          "bun",
          "db:migrate",
        ],
        positionals: ["bun", "db:migrate"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  const exitCode = await execCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]).toEqual({
    cmd: ["bun", "db:migrate"],
    cwd: projectRoot,
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
      SERVICE_TOKEN: "overlay-secret",
    },
  });
});

test("host exec injects scoped env into one-off host commands", async () => {
  const projectRoot = await createProject();
  const execCommand = findHostSubcommand("exec");

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
        scope: "api",
        target: undefined,
      },
      positionals: {
        command: ["bun", "db:migrate"],
      },
      raw: {
        argv: [
          "--path",
          projectRoot,
          "--env",
          "qa",
          "--scope",
          "api",
          "bun",
          "db:migrate",
        ],
        positionals: ["bun", "db:migrate"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  const exitCode = await execCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]).toEqual({
    cmd: ["bun", "db:migrate"],
    cwd: projectRoot,
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
      SERVICE_TOKEN: "overlay-secret",
    },
  });
});

test("env shell opens the current shell with injected project env", async () => {
  const projectRoot = await createProject();
  process.env.SHELL = "/bin/zsh";
  const shellCommand = findSubcommand("shell");

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
        service: undefined,
        target: undefined,
      },
      positionals: {},
      raw: {
        argv: ["--path", projectRoot, "--env", "qa"],
        positionals: [],
      },
    },
  } as unknown as Parameters<typeof shellCommand.handler>[0];

  const exitCode = await shellCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]).toEqual({
    cmd: ["/bin/zsh", "-l"],
    cwd: projectRoot,
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
    },
  });
});

test("host shell opens the current shell with injected project env", async () => {
  const projectRoot = await createProject();
  process.env.SHELL = "/bin/zsh";
  const shellCommand = findHostSubcommand("shell");

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
        scope: undefined,
        target: undefined,
      },
      positionals: {},
      raw: {
        argv: ["--path", projectRoot, "--env", "qa"],
        positionals: [],
      },
    },
  } as unknown as Parameters<typeof shellCommand.handler>[0];

  const exitCode = await shellCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]).toEqual({
    cmd: ["/bin/zsh", "-l"],
    cwd: projectRoot,
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
    },
  });
});

test("env exec defaults to a host-local view for host-like env values", async () => {
  const projectRoot = await createProject({
    services: ["api", "redis"],
    defaultYaml: [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    DATABASE_URL: "mysql://appuser:secret@host.docker.internal:3306/app?ssl={\\"rejectUnauthorized\\":false}"',
      '    REDISHOST: "redis"',
      "",
    ].join("\n"),
  });
  const execCommand = findSubcommand("exec");

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
        service: undefined,
        target: undefined,
      },
      positionals: {
        command: ["env"],
      },
      raw: {
        argv: ["--path", projectRoot, "env"],
        positionals: ["env"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  const exitCode = await execCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]?.env).toEqual({
    DATABASE_URL:
      'mysql://appuser:secret@127.0.0.1:3306/app?ssl={"rejectUnauthorized":false}',
    REDISHOST: "127.0.0.1",
  });
});

test("env exec can preserve the compose view when requested", async () => {
  const projectRoot = await createProject({
    services: ["api", "redis"],
    defaultYaml: [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    DATABASE_URL: "mysql://appuser:secret@host.docker.internal:3306/app?ssl={\\"rejectUnauthorized\\":false}"',
      '    REDISHOST: "redis"',
      "",
    ].join("\n"),
  });
  const execCommand = findSubcommand("exec");

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
        service: undefined,
        target: "compose",
      },
      positionals: {
        command: ["env"],
      },
      raw: {
        argv: ["--path", projectRoot, "--target", "compose", "env"],
        positionals: ["env"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  const exitCode = await execCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(runCalls).toHaveLength(1);
  expect(runCalls[0]?.env).toEqual({
    DATABASE_URL:
      'mysql://appuser:secret@host.docker.internal:3306/app?ssl={"rejectUnauthorized":false}',
    REDISHOST: "redis",
  });
});

type EnvSubcommandName = (typeof envCommand.subcommands)[number]["name"];
type EnvSubcommand<N extends EnvSubcommandName> = Extract<
  (typeof envCommand.subcommands)[number],
  { readonly name: N }
>;
type HostSubcommandName = (typeof hostCommand.subcommands)[number]["name"];
type HostSubcommand<N extends HostSubcommandName> = Extract<
  (typeof hostCommand.subcommands)[number],
  { readonly name: N }
>;

function findSubcommand<N extends EnvSubcommandName>(
  name: N
): EnvSubcommand<N> & {
  readonly handler: CommandHandlerFor<EnvSubcommand<N>>;
} {
  const command = envCommand.subcommands.find((entry) => entry.name === name);
  if (!(command && "handler" in command)) {
    throw new Error(`Missing env subcommand: ${name}`);
  }
  return command as EnvSubcommand<N> & {
    readonly handler: CommandHandlerFor<EnvSubcommand<N>>;
  };
}

function findHostSubcommand<N extends HostSubcommandName>(
  name: N
): HostSubcommand<N> & {
  readonly handler: CommandHandlerFor<HostSubcommand<N>>;
} {
  const command = hostCommand.subcommands.find((entry) => entry.name === name);
  if (!(command && "handler" in command)) {
    throw new Error(`Missing host subcommand: ${name}`);
  }
  return command as HostSubcommand<N> & {
    readonly handler: CommandHandlerFor<HostSubcommand<N>>;
  };
}

async function createProject(input?: {
  readonly services?: readonly string[];
  readonly defaultYaml?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-exec-"));
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
    resolve(projectDir, "hack.env.default.yaml"),
    input?.defaultYaml ??
      [
        "version: 1",
        "environment: default",
        "secretsprovider: project_key",
        "values:",
        "  global:",
        '    GLOBAL_FLAG: "base"',
        "",
      ].join("\n")
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "env-exec-test",
        dev_host: "env-exec.hack",
      },
      null,
      2
    )}\n`
  );

  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: "qa",
    scope: "global",
    key: "API_BASE_URL",
    value: "https://qa.example.com",
    secret: false,
  });
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: "qa",
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "overlay-secret",
    secret: false,
  });

  return projectRoot;
}
