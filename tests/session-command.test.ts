import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

const selectResponses: string[] = [];
const selectCalls: Array<{
  readonly message: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly hint?: string;
  }[];
}> = [];
const createdSessions: string[] = [];
const runCalls: string[][] = [];

let originalSetupSyncMode: string | undefined;
let originalLogger: string | undefined;
let originalTmux: string | undefined;

mock.module("@clack/prompts", () => ({
  access: async () => true,
  autocompleteMultiselect: async () => [],
  cancel: () => {},
  confirm: async () => true,
  intro: () => {},
  multiselect: async () => [],
  outro: () => {},
  isCancel: () => false,
  log: {
    error: () => {},
    info: () => {},
    message: () => {},
    success: () => {},
    step: () => {},
    warn: () => {},
  },
  note: () => {},
  password: async () => "",
  select: async (opts: {
    readonly message: string;
    readonly options: readonly {
      readonly value: string;
      readonly label: string;
      readonly hint?: string;
    }[];
  }) => {
    selectCalls.push(opts);
    return selectResponses.shift() ?? "";
  },
  spinner: () => ({
    start: () => {},
    stop: () => {},
  }),
  text: async () => "",
}));

mock.module("../src/lib/projects-registry.ts", () => ({
  readProjectsRegistry: async () => ({
    version: 1,
    projects: [
      {
        id: "alpha-id",
        name: "alpha",
        repoRoot: "/tmp/alpha",
        projectDirName: ".hack",
        projectDir: "/tmp/alpha/.hack",
        devHost: "alpha.hack",
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
  }),
  upsertProjectRegistration: async () => ({
    status: "noop",
    project: {
      id: "alpha-id",
      name: "alpha",
      repoRoot: "/tmp/alpha",
      projectDirName: ".hack",
      projectDir: "/tmp/alpha/.hack",
      devHost: "alpha.hack",
      createdAt: "2025-01-01T00:00:00Z",
    },
  }),
  resolveRegisteredProjectByName: async () => null,
  resolveRegisteredProjectById: async () => null,
  removeProjectsById: async () => ({ removed: [] }),
}));

mock.module("../src/lib/shell.ts", () => ({
  exec: async (cmd: readonly string[]) => {
    if (cmd[0] === "tmux" && cmd[1] === "list-sessions") {
      return {
        exitCode: 0,
        stdout:
          "alpha|||HACK_SESSION_FIELD|||1|||HACK_SESSION_FIELD|||/tmp/alpha\n",
        stderr: "",
      };
    }

    if (cmd[0] === "tmux" && cmd[1] === "new-session") {
      createdSessions.push(cmd[4] ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  },
  execOrThrow: async () =>
    await Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
  run: async (cmd: readonly string[]) => {
    runCalls.push([...cmd]);
    return 0;
  },
  findExecutableInPath: () => "/usr/bin/mock-bin",
  CommandError: class CommandError extends Error {},
}));

beforeEach(() => {
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  originalTmux = process.env.TMUX;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
  process.env.TMUX = undefined;
  selectResponses.length = 0;
  selectCalls.length = 0;
  createdSessions.length = 0;
  runCalls.length = 0;
});

afterEach(() => {
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }

  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }

  if (originalTmux === undefined) {
    process.env.TMUX = undefined;
  } else {
    process.env.TMUX = originalTmux;
  }
});

afterAll(() => {
  mock.restore();
});

test("session picker creates double-dash sibling sessions for attached projects", async () => {
  selectResponses.push("session:alpha", "new");

  const { runCli } = await import("../src/cli/run.ts");
  const exitCode = await runCli(["session"]);

  expect(exitCode).toBe(0);
  expect(selectCalls).toHaveLength(2);
  expect(selectCalls[1]?.options[1]?.hint).toBe("alpha--2");
  expect(createdSessions).toEqual(["alpha--2"]);
  expect(runCalls).toContainEqual(["tmux", "attach", "-d", "-t", "alpha--2"]);
});

test("resolveWorkspaceProjectName maps isolated workspace names to the base project", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveWorkspaceProjectName({
      workspaceName: "alpha--agent-1",
      projects: [
        {
          id: "project-1",
          name: "alpha",
          repoRoot: "/tmp/alpha",
          projectDirName: ".hack",
          projectDir: "/tmp/alpha/.hack",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    })
  ).toBe("alpha");
});

test("resolveWorkspaceProjectName preserves direct workspace-to-project matches", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveWorkspaceProjectName({
      workspaceName: "alpha",
      projects: [
        {
          id: "project-1",
          name: "alpha",
          repoRoot: "/tmp/alpha",
          projectDirName: ".hack",
          projectDir: "/tmp/alpha/.hack",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    })
  ).toBe("alpha");
});

test("resolveNextIsolatedWorkspaceName creates siblings from the project base", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveNextIsolatedWorkspaceName({
      workspaceName: "alpha--agent-1",
      sessions: [{ name: "alpha" }, { name: "alpha--2" }, { name: "alpha--3" }],
    })
  ).toBe("alpha--4");
});

test("resolveRunUpCwd uses the repo root instead of the .hack directory", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveRunUpCwd({
      project: {
        id: "project-1",
        name: "alpha",
        repoRoot: "/tmp/alpha",
        projectDirName: ".hack",
        projectDir: "/tmp/alpha/.hack",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    })
  ).toBe("/tmp/alpha");
});

test("resolveWorkspaceBackendName detects zellij-backed workspaces", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveWorkspaceBackendName({
      workspaceName: "alpha--agent-1",
      sessions: [
        {
          backend: "zellij",
          name: "alpha--agent-1",
          attached: null,
          path: null,
          windows: null,
          createdAt: null,
        },
      ],
    })
  ).toBe("zellij");
});

test("resolveTmuxOnlyWorkspaceError explains tmux-only pane tooling on zellij", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveTmuxOnlyWorkspaceError({
      workspaceName: "alpha--agent-1",
      sessions: [
        {
          backend: "zellij",
          name: "alpha--agent-1",
          attached: null,
          path: null,
          windows: null,
          createdAt: null,
        },
      ],
    })
  ).toContain("tmux-only");
});

test("resolveWorkspaceBackendNameForCreate prefers the existing workspace backend over the default", async () => {
  const { __testOnlySessionCommand } = await import(
    "../src/commands/session.ts"
  );
  expect(
    __testOnlySessionCommand.resolveWorkspaceBackendNameForCreate({
      preferredBackendName: "zellij",
      defaultBackendName: "tmux",
    })
  ).toBe("zellij");
});
