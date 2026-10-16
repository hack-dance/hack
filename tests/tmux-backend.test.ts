import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { ExecOptions } from "../src/lib/shell.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const execCalls: Array<{
  readonly command: readonly string[];
  readonly options: ExecOptions;
}> = [];

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (command: readonly string[], options: ExecOptions = {}) => {
      execCalls.push({ command: [...command], options });
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
