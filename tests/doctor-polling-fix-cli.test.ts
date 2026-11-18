import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SyncSpawnTimeoutError,
  spawnSyncBounded,
} from "./helpers/bounded-spawn-sync.ts";
import { runFixtureGit } from "./helpers/fixture-git.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const cli = resolve(import.meta.dir, "../index.ts");
const SELECT = ["--fix", "--only", "polling watchers"] as const;

/** One source-CLI run can take seconds on a cold macOS runner (HACK-2259). */
const CLI_RUN_TIMEOUT_MS = 20_000;
const ONE_RUN_BUDGET_MS = CLI_RUN_TIMEOUT_MS + 10_000;
const THREE_RUN_BUDGET_MS = 3 * CLI_RUN_TIMEOUT_MS + 10_000;

const LEGACY = `services:
  web:
    image: imbios/bun-node:latest
    environment:
      CHOKIDAR_USEPOLLING: "true"
      WATCHPACK_POLLING: "true"
      PORT: "3000"
  worker:
    image: imbios/bun-node:latest
    environment:
      - CHOKIDAR_USEPOLLING=true
`;

async function fixture(compose: string) {
  const root = await mkdtemp(join(tmpdir(), "doctor-polling-fix-"));
  const project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await runFixtureGit({ cwd: project, args: ["init", "--quiet"] });
  const file = join(project, ".hack/docker-compose.yml");
  await Bun.write(file, compose);
  // The repair reads and writes one file; any engine or admin tool is a bug.
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
  const invoke = async (
    flags: readonly string[],
    opts: { readonly toolsAllowed?: boolean } = {}
  ) => {
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
      if (error instanceof SyncSpawnTimeoutError) {
        throw new Error(`hack doctor ${flags.join(" ")}: ${error.message}`);
      }
      throw error;
    }
    if (!opts.toolsAllowed) {
      expect(await Bun.file(called).exists()).toBe(false);
    }
    return {
      code: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  };
  return { root, file, invoke };
}

test(
  "without --yes the diff is shown and nothing is written; --yes applies it once",
  async () => {
    const f = await fixture(LEGACY);
    try {
      const preview = await f.invoke([...SELECT, "--json"]);
      expect(preview.code).toBe(0);
      const json = JSON.parse(preview.stdout);
      expect(json).toMatchObject({
        ok: true,
        data: {
          fix: {
            id: "polling watchers",
            applied: false,
            changed: false,
            confirmed: false,
            removed: [
              { service: "web", variable: "CHOKIDAR_USEPOLLING", line: 5 },
              { service: "web", variable: "WATCHPACK_POLLING", line: 6 },
            ],
          },
          checks: [{ id: "polling watchers", status: "ok" }],
        },
      });
      expect(json.data.fix.diff).toContain(
        '-      CHOKIDAR_USEPOLLING: "true"'
      );
      expect(json.data.checks[0].detail).toContain("Nothing written");
      expect(await Bun.file(f.file).text()).toBe(LEGACY);

      const text = await f.invoke([...SELECT]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("--- a/.hack/docker-compose.yml");
      expect(text.stdout).toContain('-      WATCHPACK_POLLING: "true"');
      expect(await Bun.file(f.file).text()).toBe(LEGACY);

      const applied = await f.invoke([...SELECT, "--yes", "--json"]);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout).data.fix).toMatchObject({
        applied: true,
        changed: true,
        confirmed: true,
      });
      const after = await Bun.file(f.file).text();
      expect(after).not.toContain('CHOKIDAR_USEPOLLING: "true"');
      expect(after).toContain('PORT: "3000"');
      // The list form is project configuration, reported but never edited.
      expect(after).toContain("- CHOKIDAR_USEPOLLING=true");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  THREE_RUN_BUDGET_MS
);

test(
  "a project without generated polling lines is a no-op",
  async () => {
    const clean = "services:\n  web:\n    image: node:22\n";
    const f = await fixture(clean);
    try {
      const result = await f.invoke([...SELECT, "--yes", "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).data.fix).toMatchObject({
        changed: false,
        confirmed: true,
        removed: [],
        diff: "",
      });
      expect(await Bun.file(f.file).text()).toBe(clean);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  ONE_RUN_BUDGET_MS
);

const REFUSED: readonly (readonly string[])[] = [
  ["--only", "polling watchers", "--yes", "--json"],
  [...SELECT, "--migrate-env-config", "--json"],
  [...SELECT, "--native-preflight", "--json"],
];

test.each(REFUSED.map((flags) => [flags.join(" "), flags] as const))(
  "doctor %s refuses before mutation",
  async (_name, flags) => {
    const f = await fixture(LEGACY);
    try {
      const result = await f.invoke(flags);
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "E_USAGE" },
      });
      expect(await Bun.file(f.file).text()).toBe(LEGACY);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  ONE_RUN_BUDGET_MS
);

test(
  "plain doctor --fix never edits the polling lines",
  async () => {
    const f = await fixture(LEGACY);
    try {
      // Broad --fix runs its other repairs (and may call the stub tools);
      // the Compose file must be untouched whatever they report.
      await f.invoke(["--fix"], { toolsAllowed: true });
      expect(await Bun.file(f.file).text()).toBe(LEGACY);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  ONE_RUN_BUDGET_MS
);

test(
  "a symlinked Compose file is refused and its target is unchanged",
  async () => {
    const f = await fixture(LEGACY);
    try {
      const target = join(f.root, "shared-compose.yml");
      await rename(f.file, target);
      await symlink(target, f.file);
      const result = await f.invoke([...SELECT, "--yes", "--json"]);
      expect(result.code).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "E_CONFIG_INVALID" },
      });
      expect(await Bun.file(target).text()).toBe(LEGACY);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
  ONE_RUN_BUDGET_MS
);
