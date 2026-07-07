import { afterAll, beforeAll, expect, test } from "bun:test";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: () => {
      throw new Error("exec should not run when docker is unavailable");
    },
    findExecutableInPath: (executableName: string) =>
      executableName === "docker" ? null : executableName,
  },
});

const { readRuntimeProjects } = await import("../src/lib/runtime-projects.ts");

beforeAll(() => {
  shellMock.activate();
});

afterAll(() => {
  shellMock.deactivate();
});

test("readRuntimeProjects reports docker absence instead of throwing", async () => {
  const result = await readRuntimeProjects({ includeGlobal: false });

  expect(result.ok).toBe(false);
  expect(result.runtime).toEqual([]);
  expect(result.error).toBe("docker is not installed or not on PATH");
});
