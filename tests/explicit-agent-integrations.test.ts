import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const children = fixtureChildren("explicit integration CLI fixture");
let root: string | undefined;
afterEach(async () => {
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

/** Keep the existing 5s test bound; teardown settles the sole owned child on failure. */
test("CLI retirement preserves project/global originals; selected skill and MCP remain opt-in", async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-explicit-agent-cli-"))
  );
  const result = await children.run({
    cmd: [
      process.execPath,
      resolve(import.meta.dir, "helpers/explicit-agent-integrations-runner.ts"),
      root,
    ],
    cwd: root,
    env: privateCliEnv({
      root,
      home: join(root, "home"),
      env: {
        PATH: join(root, "empty-path"),
        HACK_HOME: join(root, "state"),
        CODEX_HOME: join(root, "home/.codex"),
        HACK_GLOBAL_CONFIG_PATH: join(root, "state/hack.config.json"),
        HACK_NO_INTERACTIVE: "1",
        HACK_DAEMON_DISABLE: "1",
        HACK_LOGGER: "console",
      },
    }),
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("explicit-integrations-fixture:ok");
  expect(result.stdout + result.stderr).not.toContain(
    "Hack integration inventory:"
  );
  expect(result.stdout + result.stderr).toContain("retired in v5");
});
