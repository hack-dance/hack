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
        return { exitCode: 0, stdout: "demo\n", stderr: "" };
      }
      if (command.includes("dump-layout")) {
        return {
          exitCode: 0,
          stdout:
            'layout { tab name="hack-lifecycle-owner-owner-123" { pane name="api" } }',
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    findExecutableInPath: () => "/usr/bin/zellij",
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

async function loadZellijBackend() {
  const { createZellijBackend } = await import(
    `../src/mux/zellij-backend.ts?test=${Date.now()}-${Math.random()}`
  );
  return createZellijBackend();
}

test("zellij backend targets detached sessions with the global session flag", async () => {
  const backend = await loadZellijBackend();
  const created = await backend.createSession({
    name: "demo",
    cwd: "/repo",
    env: { PROJECT_ENV: "qa" },
    lifecycleOwnerToken: "owner-123",
  });
  const ownerToken = await backend.readLifecycleOwnerToken?.({ name: "demo" });
  const windowNames = await backend.listSessionWindowNames?.({ name: "demo" });
  await backend.execInSession({
    name: "demo",
    command: "bun worker.ts",
    env: { PROJECT_ENV: "qa" },
  });
  await backend.sendInput({ name: "demo", keys: "hello" });

  expect(created.ok).toBe(true);
  expect(ownerToken).toBe("owner-123");
  expect(windowNames).toEqual(new Set(["api"]));
  expect(execCalls.map(({ command }) => command)).toEqual([
    ["zellij", "attach", "--create-background", "demo"],
    [
      "zellij",
      "--session",
      "demo",
      "action",
      "rename-tab",
      "hack-lifecycle-owner-owner-123",
    ],
    ["zellij", "list-sessions", "--no-formatting", "--short"],
    ["zellij", "--session", "demo", "action", "dump-layout"],
    ["zellij", "--session", "demo", "action", "dump-layout"],
    ["zellij", "--session", "demo", "run", "--", "sh", "-lc", "bun worker.ts"],
    ["zellij", "--session", "demo", "action", "write-chars", "hello"],
  ]);
  expect(execCalls[1]?.options.env?.ZELLIJ_SESSION_NAME).toBeUndefined();
  expect(execCalls[3]?.options.env?.ZELLIJ_SESSION_NAME).toBeUndefined();
  expect(execCalls[5]?.options.env).toEqual({ PROJECT_ENV: "qa" });
});
