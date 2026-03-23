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
  execOrThrow: async (cmd: readonly string[]) => {
    return await Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  },
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
