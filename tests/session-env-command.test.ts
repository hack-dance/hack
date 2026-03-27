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
import type { MuxBackend } from "../src/mux/mux-backend.ts";

const createSessionCalls: Array<{
  readonly name: string;
  readonly cwd: string | undefined;
  readonly env: Record<string, string> | undefined;
}> = [];
const execInSessionCalls: Array<{
  readonly name: string;
  readonly command: string;
  readonly env: Record<string, string> | undefined;
}> = [];
const tempDirs = new Set<string>();
let registeredProject: {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly projectDirName: ".hack";
  readonly projectDir: string;
  readonly createdAt: string;
} | null = null;
let listedSessions: Array<{
  readonly backend: "tmux";
  readonly name: string;
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: string | null;
}> = [];

const fakeBackend: MuxBackend = {
  name: "tmux",
  available: true,
  listSessions: async () => listedSessions,
  createSession: async ({ name, cwd, env }) => {
    createSessionCalls.push({
      name,
      cwd,
      env: env ? { ...env } : undefined,
    });
    return {
      ok: true,
      session: {
        backend: "tmux",
        name,
        attached: false,
        path: cwd ?? null,
        windows: 1,
        createdAt: null,
      },
    };
  },
  killSession: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
  execInSession: async ({ name, command, env }) => {
    execInSessionCalls.push({
      name,
      command,
      env: env ? { ...env } : undefined,
    });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
  },
  sendInput: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
};

mock.module("../src/lib/projects-registry.ts", () => ({
  readProjectsRegistry: async () => ({
    version: 1,
    projects: registeredProject ? [registeredProject] : [],
  }),
}));

mock.module("../src/mux/mux-resolver.ts", () => ({
  listMuxSessions: async () => listedSessions,
  resolveDefaultBackendName: () => "tmux",
  resolveMux: async () => ({
    mode: "tmux",
    backends: new Map([["tmux", fakeBackend]]),
  }),
}));

mock.module("../src/mux/tmux-backend.ts", () => ({
  attachTmuxSession: async () => 0,
}));

mock.module("../src/mux/zellij-backend.ts", () => ({
  attachZellijSession: async () => 0,
}));

mock.module("../src/lib/shell.ts", () => ({
  exec: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
  run: async () => 0,
}));

const { sessionCommand } = await import("../src/commands/session.ts");

afterEach(async () => {
  createSessionCalls.length = 0;
  execInSessionCalls.length = 0;
  listedSessions = [];
  registeredProject = null;
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

afterAll(() => {
  mock.restore();
});

test("session start creates an env-scoped workspace with injected env", async () => {
  const projectRoot = await createProject();
  const startCommand = findSubcommand("start");

  const exitCode = await startCommand.handler({
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        up: false,
        new: false,
        name: undefined,
        detach: true,
        env: "qa",
        service: "api",
      },
      positionals: {
        project: "session-env-test",
      },
      raw: {
        argv: [
          "--detach",
          "--env",
          "qa",
          "--service",
          "api",
          "session-env-test",
        ],
        positionals: ["session-env-test"],
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(createSessionCalls).toHaveLength(1);
  expect(createSessionCalls[0]).toEqual({
    name: "session-env-test.env-qa.svc-api",
    cwd: projectRoot,
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
      SERVICE_TOKEN: "overlay-secret",
    },
  });
});

test("session exec injects the selected env into the workspace command", async () => {
  const projectRoot = await createProject();
  const execCommand = findSubcommand("exec");
  listedSessions = [
    {
      backend: "tmux",
      name: "session-env-test.env-qa.svc-api",
      attached: false,
      path: projectRoot,
      windows: 1,
      createdAt: null,
    },
  ];

  const exitCode = await execCommand.handler({
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        env: "qa",
        service: "api",
      },
      positionals: {
        workspace: "session-env-test.env-qa.svc-api",
        command: "bun db:migrate",
      },
      raw: {
        argv: [
          "--env",
          "qa",
          "--service",
          "api",
          "session-env-test.env-qa.svc-api",
          "bun db:migrate",
        ],
        positionals: ["session-env-test.env-qa.svc-api", "bun db:migrate"],
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(execInSessionCalls).toHaveLength(1);
  expect(execInSessionCalls[0]).toEqual({
    name: "session-env-test.env-qa.svc-api",
    command: "bun db:migrate",
    env: {
      API_BASE_URL: "https://qa.example.com",
      GLOBAL_FLAG: "base",
      SERVICE_TOKEN: "overlay-secret",
    },
  });
});

function findSubcommand(name: string) {
  const command = sessionCommand.subcommands.find(
    (entry) => entry.name === name
  );
  if (!(command && "handler" in command)) {
    throw new Error(`Missing session subcommand: ${name}`);
  }
  return command;
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-session-env-"));
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
        name: "session-env-test",
        dev_host: "session-env.hack",
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

  registeredProject = {
    id: "project-1",
    name: "session-env-test",
    repoRoot: projectRoot,
    projectDirName: ".hack",
    projectDir,
    createdAt: "2026-03-27T00:00:00.000Z",
  };

  return projectRoot;
}
