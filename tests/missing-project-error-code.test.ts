import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1339: every project command reports a path without a project with the
 * same closed code. `up`, `down` and `restart` already reported
 * E_PROJECT_NOT_FOUND; `ps` and `logs` reported E_UNEXPECTED (and, without
 * `--json`, a stack trace).
 */

const MESSAGE = "No .hack/ (or legacy .dev/) found. Run: hack init";
/** A JavaScript stack frame as Bun prints it. */
const STACK_FRAME = /^\s+at /m;
/** A source CLI spawn can take several seconds on a loaded runner. */
const SPAWN_TIMEOUT_MS = 30_000;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function emptyProject() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-missing-project-"))
  );
  roots.push(root);
  const dir = join(root, "empty");
  await mkdir(dir);
  return { root, dir };
}

async function cli(opts: {
  readonly root: string;
  readonly args: readonly string[];
}) {
  const child = Bun.spawn(
    [process.execPath, resolve("index.ts"), ...opts.args],
    {
      cwd: opts.root,
      env: privateCliEnv({
        root: opts.root,
        env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console" },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

for (const command of ["ps", "logs", "up", "down", "restart"]) {
  test(
    `${command} -p <empty dir> --json reports E_PROJECT_NOT_FOUND`,
    async () => {
      const { root, dir } = await emptyProject();
      const result = await cli({ root, args: [command, "-p", dir, "--json"] });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: { code: "E_PROJECT_NOT_FOUND", message: MESSAGE },
      });
    },
    SPAWN_TIMEOUT_MS
  );
}

test(
  "ps -p <empty dir> without --json prints one closed line and no stack",
  async () => {
    const { root, dir } = await emptyProject();
    const result = await cli({ root, args: ["ps", "-p", dir] });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`ERROR: E_PROJECT_NOT_FOUND: ${MESSAGE}\n`);
    expect(result.stderr).not.toMatch(STACK_FRAME);
  },
  SPAWN_TIMEOUT_MS
);
