import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SyncSpawnTimeoutError,
  spawnSyncBounded,
} from "./helpers/bounded-spawn-sync.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");
const selected = ["--fix", "--only", "hack gitignore", "--yes", "--json"];

/**
 * Time budgets (HACK-2259). One source-CLI `doctor` run takes about half a
 * second on Linux and can take several seconds on a cold macOS runner, so the
 * default 5 s test timeout cannot hold more than one. Each run is bounded on
 * its own and fails naming the command; each test's budget covers its runs.
 */
const CLI_RUN_TIMEOUT_MS = 20_000;
const ONE_RUN_BUDGET_MS = CLI_RUN_TIMEOUT_MS + 10_000;
const TWO_RUN_BUDGET_MS = 2 * CLI_RUN_TIMEOUT_MS + 10_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-safe-fix-"));
  const project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await runFixtureGit({ cwd: project, args: ["init", "--quiet"] });
  await Bun.write(join(project, ".hack/docker-compose.yml"), "services: {}\n");
  const tools = join(root, "tools");
  await mkdir(tools);
  const called = join(root, "unexpected-tool");
  for (const name of ["docker", "hackd", "sudo", "security", "systemctl"]) {
    await Bun.write(
      join(tools, name),
      `#!/bin/sh\nprintf unexpected >> '${called}'\nexit 90\n`
    );
    await chmod(join(tools, name), 0o700);
  }
  const invoke = (flags: readonly string[]) => {
    // Synchronous and bounded: a CLI that never starts or never exits is
    // killed and the test fails with the command's name, not a bare timeout.
    let child: Bun.SyncSubprocess<"pipe", "pipe">;
    try {
      child = spawnSyncBounded(
        [
          process.execPath,
          "--no-env-file",
          cli,
          "doctor",
          "--path",
          project,
          ...flags,
        ],
        {
          cwd: root,
          env: privateCliEnv({
            root,
            env: {
              HACK_HOME: join(root, "state"),
              HACK_GLOBAL_CONFIG_PATH: join(root, "state/hack.config.json"),
              PATH: `${tools}:/usr/bin:/bin`,
              HACK_NO_INTERACTIVE: "1",
              HACK_LOGGER: "console",
            },
          }),
          stdout: "pipe",
          stderr: "pipe",
          timeout: CLI_RUN_TIMEOUT_MS,
        }
      );
    } catch (error: unknown) {
      // The helper names only the executable and two arguments; add the
      // doctor flags so a hang identifies its case.
      if (error instanceof SyncSpawnTimeoutError) {
        throw new Error(`hack doctor ${flags.join(" ")}: ${error.message}`);
      }
      throw error;
    }
    const code = child.exitCode;
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  };
  const assertNoTool = async () => {
    expect(await Bun.file(called).exists()).toBe(false);
  };
  return {
    root,
    project,
    invoke: async (flags: readonly string[]) => {
      const result = invoke(flags);
      await assertNoTool();
      return result;
    },
    file: join(project, ".hack/.gitignore"),
  };
}

test(
  "one safe fix preserves user lines and other findings, rechecks, and is idempotent",
  async () => {
    const f = await fixture();
    try {
      await Bun.write(f.file, "# user-owned rule\ncustom.tmp\n");
      const unrelated = join(f.project, ".hack/.env");
      await Bun.write(unrelated, "SYNTHETIC_SENTINEL=not-a-real-secret\n");
      const result = await f.invoke(selected);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.keys(result.json)).toEqual(["ok", "data"]);
      expect(result.json).toMatchObject({
        ok: true,
        data: {
          schema: 1,
          fix: { id: "hack gitignore", changed: true, confirmed: true },
          counts: { ok: 1, warn: 0, error: 0 },
          checks: [
            { id: "hack gitignore", status: "ok", fix: { kind: "safe" } },
          ],
        },
      });
      expect(result.json.data.checks).toHaveLength(1);
      expect(await Bun.file(f.file).text()).toContain(
        "# user-owned rule\ncustom.tmp\n"
      );
      expect(await Bun.file(unrelated).text()).toBe(
        "SYNTHETIC_SENTINEL=not-a-real-secret\n"
      );
      expect(result.stdout).not.toContain("SYNTHETIC_SENTINEL");
      const before = await readFile(f.file);
      const again = await f.invoke(selected);
      expect(again.code).toBe(0);
      expect(again.json.data.fix).toMatchObject({
        changed: false,
        confirmed: true,
      });
      expect(await readFile(f.file)).toEqual(before);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  TWO_RUN_BUDGET_MS
);

const REFUSED_FLAGS: readonly (readonly string[])[] = [
  ["--fix", "--only", "hack gitignore", "--json"],
  ["--only", "hack gitignore", "--yes", "--json"],
  ["--fix", "--yes", "--json"],
  ["--fix", "--json"],
  ...["local ca trust", "daemon", "unknown", "__proto__"].map((id) => [
    "--fix",
    "--only",
    id,
    "--yes",
    "--json",
  ]),
  [...selected, "--migrate-env-config"],
  [...selected, "--native-preflight"],
];

// Missing consent, a broad fix, admin/manual/unknown IDs and mixed modes:
// one case per refusal, each with its own budget.
test.each(REFUSED_FLAGS.map((flags) => [flags.join(" "), flags] as const))(
  "doctor %s refuses before mutation",
  async (_name, flags) => {
    const f = await fixture();
    try {
      const result = await f.invoke(flags);
      expect(result.code).not.toBe(0);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "E_USAGE" },
      });
      expect(await Bun.file(f.file).exists()).toBe(false);
      expect(await readdir(join(f.project, ".hack"))).toEqual([
        "docker-compose.yml",
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  ONE_RUN_BUDGET_MS
);

for (const mode of ["read-only", "symlink"] as const) {
  test(
    `a ${mode} ignore file is retained and cannot be reported fixed`,
    async () => {
      const f = await fixture();
      try {
        const target = join(f.root, "user-content");
        await Bun.write(target, "user content\n");
        if (mode === "symlink") {
          await symlink(target, f.file);
        } else {
          await Bun.write(f.file, "user rule\n");
          await chmod(f.file, 0o400);
        }
        const result = await f.invoke(selected);
        expect(result.code).toBe(1);
        expect(result.json).toMatchObject({
          ok: true,
          data: {
            fix: { changed: false, confirmed: false },
            checks: [{ status: "error" }],
          },
        });
        expect(await Bun.file(target).text()).toBe("user content\n");
        expect(await Bun.file(f.file).text()).toBe(
          mode === "symlink" ? "user content\n" : "user rule\n"
        );
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
    ONE_RUN_BUDGET_MS
  );
}
