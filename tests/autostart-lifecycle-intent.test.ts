import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyAutostartExit } from "../src/daemon/autostart.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
const cli = resolve("index.ts");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "autostart-intent-"));
  await mkdir(join(root, "project", ".hack"), { recursive: true });
  await mkdir(join(root, "home", ".hack"), { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(
    join(root, "project", ".hack", "hack.config.json"),
    '{"name":"sample"}'
  );
  await writeFile(
    join(root, "project", ".hack", "docker-compose.yml"),
    "services:\n  app:\n    image: example.invalid/app\n"
  );
  await writeRegistry(true);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function writeRegistry(paused: boolean) {
  await writeFile(
    join(root, "home", ".hack", "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "sample",
          name: "sample",
          repoRoot: join(root, "project"),
          projectDir: join(root, "project", ".hack"),
          projectDirName: ".hack",
          createdAt: "2026-01-01T00:00:00.000Z",
          autostart: {
            branch: null,
            paused,
            lastResult: null,
            lastAttemptBootId: null,
          },
        },
      ],
    }),
    { mode: 0o600 }
  );
}
async function marker() {
  const registry = await Bun.file(
    join(root, "home", ".hack", "projects.json")
  ).json();
  return registry.projects[0].autostart;
}
async function run(
  args: string[],
  login = false,
  cwd = join(root, "project"),
  overrides: Readonly<Record<string, string>> = {}
) {
  const child = Bun.spawn(
    [process.execPath, cli, "--no-interactive", ...args],
    {
      cwd,
      env: privateCliEnv({
        root,
        home: join(root, "home"),
        env: {
          PATH: join(root, "bin"),
          HACK_AUTOSTART_LOGIN: login ? "1" : "0",
          ...overrides,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
test("down persists pause before a failing runtime, and a later up clears it", async () => {
  await writeRegistry(false);
  await run(["down", "--json"]);
  expect((await marker()).paused).toBe(true);
  await run(["up", "--json", "-d"]);
  expect((await marker()).paused).toBe(false);
});
test("an unrelated branch does not pause the marked base instance", async () => {
  await writeRegistry(false);
  await run(["down", "--branch", "preview", "--json"]);
  expect((await marker()).paused).toBe(false);
});
test("down through a symlinked checkout pauses the canonical registration", async () => {
  await writeRegistry(false);
  const alias = join(root, "project-link");
  await symlink(join(root, "project"), alias);
  await run(["down", "--path", alias, "--json"]);
  expect((await marker()).paused).toBe(true);
});
test("down accepts legacy alias names when deciding whether to pause", async () => {
  await writeRegistry(false);
  const registryPath = join(root, "home", ".hack", "projects.json");
  const registry = await Bun.file(registryPath).json();
  registry.projects[0].name = "Sample_App";
  await writeFile(registryPath, JSON.stringify(registry));
  await run(["down", "--project", "SAMPLE_APP", "--json"]);
  expect((await marker()).paused).toBe(true);
});
test("login refuses a pending legacy migration without touching dotenv or clearing pause", async () => {
  const envFile = join(root, "project", ".hack", ".env");
  await writeFile(envFile, "SAMPLE_VALUE=fixture\n");
  const result = await run(["up", "--json", "-d"], true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("pending env migration");
  expect(await Bun.file(envFile).text()).toBe("SAMPLE_VALUE=fixture\n");
  expect((await marker()).paused).toBe(true);
  expect(classifyAutostartExit(result)).toEqual({
    status: "skipped",
    reason: "pending_env_migration",
  });
});

test("up --always registers and marks the selected primary instance before runtime dispatch", async () => {
  await writeFile(
    join(root, "home", ".hack", "projects.json"),
    '{"version":1,"projects":[]}'
  );
  await run(["up", "-d", "--always", "--branch", "preview", "--json"]);
  expect(await marker()).toMatchObject({ branch: "preview", paused: false });
});

test("linked worktree opt-in refuses without marking the primary checkout", async () => {
  const git = Bun.which("git");
  if (!git) {
    throw new Error("git is required for the worktree regression fixture");
  }
  await symlink(git, join(root, "bin", "git"));
  const env = privateCliEnv({ root, home: join(root, "home") });
  const primary = join(root, "project");
  const worktree = join(root, "linked");
  for (const args of [
    ["init", "--initial-branch=main", primary],
    ["-C", primary, "add", ".hack"],
    [
      "-C",
      primary,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    ["-C", primary, "worktree", "add", "-b", "preview", worktree],
  ]) {
    const child = Bun.spawn([git, ...args], {
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const message = await new Response(child.stderr).text();
    expect(await child.exited, message).toBe(0);
  }
  const before = await marker();
  const up = await run(["up", "-d", "--always", "--json"], false, worktree);
  expect(up.exitCode).not.toBe(0);
  expect(up.stdout + up.stderr).toContain("primary checkout");
  const add = await run(["autostart", "add", "sample"], false, worktree);
  expect(add.exitCode).not.toBe(0);
  expect(add.stdout + add.stderr).toContain("primary checkout");
  expect(await marker()).toEqual(before);
});

test("native selection with an existing marker reaches the same dispatch as an unmarked project", async () => {
  await writeFile(
    join(root, "project", ".hack", "hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "sample", services: {} })
  );
  const registryPath = join(root, "home", ".hack", "projects.json");
  for (const action of ["down", "up"]) {
    await writeRegistry(false);
    const registry = await Bun.file(registryPath).json();
    Reflect.deleteProperty(registry.projects[0], "autostart");
    await writeFile(registryPath, JSON.stringify(registry));
    const baseline = await run(
      [action, "--json"],
      false,
      join(root, "project"),
      { HACK_RUNTIME_BACKEND: "native" }
    );
    await writeRegistry(action === "up");
    const marked = await run([action, "--json"], false, join(root, "project"), {
      HACK_RUNTIME_BACKEND: "native",
    });
    expect(marked.exitCode).toBe(baseline.exitCode);
    expect(marked.stdout).toBe(baseline.stdout);
    expect(marked.stderr).toBe(baseline.stderr);
    expect((await marker()).paused).toBe(action === "down");
  }
});
