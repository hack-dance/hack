import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const { envCommand } = await import("../src/commands/env.ts");

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

  const exitCode = await execCommand.handler({
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
  });

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

  const exitCode = await shellCommand.handler({
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
      },
      positionals: {},
      raw: {
        argv: ["--path", projectRoot, "--env", "qa"],
        positionals: [],
      },
    },
  });

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

function findSubcommand(name: string) {
  const command = envCommand.subcommands.find((entry) => entry.name === name);
  if (!(command && "handler" in command)) {
    throw new Error(`Missing env subcommand: ${name}`);
  }
  return command;
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-env-exec-"));
  tempDirs.add(root);

  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    "services:\n  api:\n    image: alpine:3.20\n"
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
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "base",
    secret: false,
  });
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
