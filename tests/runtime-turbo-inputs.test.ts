import { expect, test } from "bun:test";
import { resolve } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("CLI gate hashes include the root-owned source, tests and fixtures", async () => {
  const root = resolve(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      resolve(root, "node_modules/.bin/turbo"),
      "run",
      "test",
      "typecheck",
      "check",
      "--filter=@hack/cli",
      "--dry=json",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  const summary: unknown = JSON.parse(stdout);
  if (!(record(summary) && Array.isArray(summary.tasks))) {
    throw new Error("Missing Turbo task summary");
  }
  const found: string[] = [];
  for (const task of summary.tasks) {
    if (!record(task) || task.package !== "@hack/cli") {
      continue;
    }
    if (typeof task.task !== "string" || !record(task.inputs)) {
      throw new Error("Missing CLI task inputs");
    }
    found.push(task.task);
    const inputs = Object.keys(task.inputs);
    for (const path of [
      "src/lib/env.ts",
      "tests/runtime-build-output.test.ts",
      "tests/fixtures/source-build/artifact.ts",
      "tsconfig.json",
      "bunfig.toml",
      "biome.jsonc",
    ]) {
      expect(inputs).toContain(`../../${path}`);
    }
    expect(
      inputs.some(
        (path) =>
          path.includes(".hack-local/") || path.includes("/node_modules/")
      )
    ).toBe(false);
  }
  expect(found.sort()).toEqual(["check", "test", "typecheck"]);
}, 15_000);
