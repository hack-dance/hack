import { afterAll, expect, mock, test } from "bun:test";

mock.module("../src/lib/shell.ts", () => ({
  exec: async () => {
    throw new Error("exec should not run when docker is unavailable");
  },
  findExecutableInPath: (executableName: string) =>
    executableName === "docker" ? null : executableName,
}));

const { readRuntimeProjects } = await import("../src/lib/runtime-projects.ts");

afterAll(() => {
  mock.restore();
});

test("readRuntimeProjects reports docker absence instead of throwing", async () => {
  const result = await readRuntimeProjects({ includeGlobal: false });

  expect(result.ok).toBe(false);
  expect(result.runtime).toEqual([]);
  expect(result.error).toBe("docker is not installed or not on PATH");
});
