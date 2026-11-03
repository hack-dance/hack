import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { ExecOptions } from "../src/lib/shell.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const execCalls: Array<{
  readonly command: readonly string[];
  readonly options: ExecOptions;
}> = [];
let presenceResult = { exitCode: 0, stdout: "", stderr: "" };

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (command: readonly string[], options: ExecOptions = {}) => {
      execCalls.push({ command: [...command], options });
      if (command.includes("has-session")) {
        return presenceResult;
      }
      if (command.includes("list-sessions")) {
        return {
          exitCode: 0,
          stdout: "demo\t0\t/repo\t1\t1783569600\n",
          stderr: "",
        };
      }
      if (command.includes("show-options")) {
        return { exitCode: 1, stdout: "", stderr: "missing option" };
      }
      if (command.includes("show-environment")) {
        return {
          exitCode: 0,
          stdout: "HACK_LIFECYCLE_OWNER_TOKEN=owner-123\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    findExecutableInPath: () => "/usr/bin/tmux",
  },
});

beforeAll(() => {
  shellMock.activate();
});

beforeEach(() => {
  execCalls.length = 0;
  presenceResult = { exitCode: 0, stdout: "", stderr: "" };
});

afterAll(() => {
  shellMock.deactivate();
});

async function loadTmuxBackend() {
  const { createTmuxBackend } = await import(
    `../src/mux/tmux-backend.ts?test=${Date.now()}-${Math.random()}`
  );
  return createTmuxBackend();
}

test("tmux creates lifecycle ownership atomically and reads the env fallback", async () => {
  const backend = await loadTmuxBackend();
  const created = await backend.createSession({
    name: "demo",
    cwd: "/repo",
    lifecycleOwnerToken: "owner-123",
  });
  const ownerToken = await backend.readLifecycleOwnerToken?.({ name: "demo" });

  expect(created.ok).toBe(true);
  expect(ownerToken).toBe("owner-123");
  expect(execCalls[0]?.command).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "demo",
    "-c",
    "/repo",
    "-e",
    "HACK_LIFECYCLE_OWNER_TOKEN=owner-123",
  ]);
  expect(execCalls.map(({ command }) => command)).toContainEqual([
    "tmux",
    "show-environment",
    "-t",
    "demo",
    "HACK_LIFECYCLE_OWNER_TOKEN",
  ]);
});

test("tmux presence uses an exact session target and distinguishes unknown failures", async () => {
  const backend = await loadTmuxBackend();
  const presence = () => backend.readSessionPresence?.({ name: "demo" });
  expect(await presence()).toBe("present");
  expect(execCalls[0]?.command).toEqual(["tmux", "has-session", "-t", "=demo"]);

  for (const stderr of [
    "can't find session: demo",
    "no server running on /tmp/owned-tmux/default",
    "error connecting to /tmp/owned-tmux/default (No such file or directory)",
  ]) {
    presenceResult = { exitCode: 1, stdout: "", stderr };
    expect(await presence()).toBe("absent");
  }
  for (const stderr of [
    "",
    "can't find session: foreign",
    "error connecting to /tmp/owned-tmux/default (Permission denied)",
    "no server running on /tmp/owned-tmux/default\nPermission denied",
  ]) {
    presenceResult = { exitCode: 1, stdout: "", stderr };
    expect(await presence()).toBe("unknown");
  }
  presenceResult = {
    exitCode: 2,
    stdout: "",
    stderr: "can't find session: demo",
  };
  expect(await presence()).toBe("unknown");
});

test("tmux kills a session by exact name, never by tmux's prefix fallback", async () => {
  const backend = await loadTmuxBackend();
  await backend.killSession({ name: "demo" });
  expect(execCalls[0]?.command).toEqual([
    "tmux",
    "kill-session",
    "-t",
    "=demo",
  ]);
});

test("tmux session listing keeps delimiter-heavy paths out of the session name", async () => {
  const { parseTmuxSessionListing } = await import(
    "../src/mux/tmux-backend.ts"
  );
  const stdout = [
    "demo--lifecycle\t0\t/work/my app\t2\t1783569600",
    "tabbed\t1\t/work/a\tb:c|d_e\t1\t1783569601",
    "quiet\t0\t\t1\t1783569602",
    // What tmux prints without a UTF-8 client: separators become `_`. It is
    // not a session row, and its text must not surface as a stoppable ID.
    "demo--lifecycle_0_/work/my app_2_1783569600",
    "short\t0\t/work",
    "bad-tail\t0\t/work\tmany\t1783569603",
    "",
  ].join("\n");

  expect(parseTmuxSessionListing(stdout)).toEqual([
    {
      backend: "tmux",
      name: "demo--lifecycle",
      attached: false,
      path: "/work/my app",
      windows: 2,
      createdAt: new Date(1_783_569_600_000).toISOString(),
    },
    {
      backend: "tmux",
      name: "tabbed",
      attached: true,
      path: "/work/a\tb:c|d_e",
      windows: 1,
      createdAt: new Date(1_783_569_601_000).toISOString(),
    },
    {
      backend: "tmux",
      name: "quiet",
      attached: false,
      path: null,
      windows: 1,
      createdAt: new Date(1_783_569_602_000).toISOString(),
    },
  ]);
});
