import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const children = fixtureChildren("upgrade-check-failure");
const roots: string[] = [];
afterEach(async () => {
  await children.stopAll();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade diagnostics classify failures without exposing messages, output or arbitrary error names", async () => {
  const sentinel = "fixture-value-must-stay-private";
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "upgrade-failure-"))
  );
  roots.push(root);
  const result = await children.run({
    cmd: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures", "upgrade-check-failure-worker.ts"),
    ],
    cwd: root,
    env: privateCliEnv({ root, env: { PATH: "/nonexistent" } }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(sentinel);
  expect(JSON.parse(result.stdout)).toEqual([
    "type-error",
    "parse-error",
    "range-error",
    "env-layer-refused",
    "permission-denied",
    "missing-path",
    "unexpected-error",
    "command-error",
    "unexpected-error",
  ]);
});
