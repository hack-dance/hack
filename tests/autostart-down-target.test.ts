import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveFinalAutostartDownTarget } from "../src/commands/project-autostart-intent.ts";
import { readActivity } from "../src/lib/activity-log.ts";
import { withAutostartProjectLock } from "../src/lib/autostart-project-lock.ts";
import type { RuntimeProject } from "../src/lib/runtime-projects.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
let primary = "";
let worktree = "";
let originalHome: string | undefined;
let originalGitConfig: string | undefined;
let originalGitSystem: string | undefined;
let env: Record<string, string>;
async function git(args: string[]) {
  const binary = Bun.which("git");
  if (!binary) {
    throw new Error("git is required for the renamed-worktree regression");
  }
  const child = Bun.spawn([binary, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-down-target-"));
  primary = join(root, "primary");
  worktree = join(root, "worktree");
  await mkdir(join(primary, ".hack"), { recursive: true });
  await writeFile(
    join(primary, ".hack", "hack.config.json"),
    '{"name":"example"}'
  );
  await writeFile(
    join(primary, ".hack", "docker-compose.yml"),
    "name: example\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  env = privateCliEnv({
    root,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  originalHome = process.env.HOME;
  originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
  originalGitSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.HOME = env.HOME;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await git(["init", "--initial-branch=main", primary]);
  await git(["-C", primary, "add", ".hack"]);
  await git([
    "-C",
    primary,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await git(["-C", primary, "worktree", "add", "-b", "old-branch", worktree]);
  await git(["-C", worktree, "branch", "-m", "new-branch"]);
});
afterEach(async () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("GIT_CONFIG_GLOBAL", originalGitConfig);
  restoreEnv("GIT_CONFIG_NOSYSTEM", originalGitSystem);
  await rm(root, { recursive: true, force: true });
});
function runtime(branch: string | null): RuntimeProject {
  return {
    project: branch === null ? "example" : `example--${branch}`,
    workingDir: join(worktree, ".hack"),
    services: new Map(),
    isGlobal: false,
  };
}
function dependencies(projects: readonly RuntimeProject[]) {
  return {
    readProjectsRegistry: async () => ({ version: 1 as const, projects: [] }),
    readRuntimeProjects: async () => ({
      ok: true as const,
      runtime: projects,
      error: null,
      checkedAtMs: 1,
    }),
    isLocalTarget: async () => true,
  };
}

test("renamed linked worktree resolves its old owned branch before autostart pause and lock selection", async () => {
  expect(await git(["-C", worktree, "branch", "--show-current"])).toBe(
    "new-branch"
  );
  const notices: string[] = [];
  const target = await resolveFinalAutostartDownTarget(
    { cwd: worktree, writeNotice: ({ message }) => notices.push(message) },
    dependencies([runtime("old-branch")])
  );
  expect(target).toEqual({ branch: "old-branch" });
  expect(notices).toHaveLength(2);
  expect(notices[0]).toContain("Linked worktree detected");
  expect(notices[1]).toContain("Targeting the owned runtime");
});

test("owned base runtime remains an explicit null target after a linked branch rename", async () => {
  const target = await resolveFinalAutostartDownTarget(
    { cwd: worktree },
    dependencies([runtime(null)])
  );
  expect(target).toEqual({ branch: null });
});

test("ambiguous renamed-worktree runtimes refuse instead of guessing a pause or lock target", async () => {
  await expect(
    resolveFinalAutostartDownTarget(
      { cwd: worktree },
      dependencies([runtime("old-branch"), runtime("another")])
    )
  ).rejects.toThrow("Refusing an ambiguous implicit down");
});

test("explicit branch and primary base never inspect Docker runtime", async () => {
  const deps = {
    ...dependencies([]),
    readRuntimeProjects: async (): Promise<never> => {
      throw new Error("runtime must not be inspected");
    },
  };
  expect(
    await resolveFinalAutostartDownTarget(
      { cwd: worktree, branch: "chosen" },
      deps
    )
  ).toEqual({ branch: "chosen" });
  expect(await resolveFinalAutostartDownTarget({ cwd: primary }, deps)).toEqual(
    { branch: null }
  );
});

test("remote defaults and native inputs retain their original dispatch without local retargeting", async () => {
  const deps = {
    ...dependencies([]),
    isLocalTarget: async () => false,
    readRuntimeProjects: async (): Promise<never> => {
      throw new Error("remote runtime must not be inspected");
    },
  };
  expect(
    await resolveFinalAutostartDownTarget({ cwd: worktree }, deps)
  ).toBeUndefined();
  await writeFile(
    join(worktree, ".hack", "hack.project.json"),
    '{"schema_version":1,"name":"example","services":{}}'
  );
  expect(
    await resolveFinalAutostartDownTarget({ cwd: worktree }, dependencies([]))
  ).toBeUndefined();
});

test("unavailable runtime refuses before a final target is published", async () => {
  await expect(
    resolveFinalAutostartDownTarget(
      { cwd: worktree },
      {
        ...dependencies([]),
        readRuntimeProjects: async () => ({
          ok: false,
          runtime: [],
          error: "fixture unavailable",
          checkedAtMs: 1,
        }),
      }
    )
  ).rejects.toMatchObject({ code: "E_DOCKER_UNAVAILABLE" });
});

for (const ownedBranch of ["old-branch", null]) {
  test(`source down pauses and locks the owned ${ownedBranch ?? "base"} runtime after a real worktree branch rename`, async () => {
    const ownedComposeProject =
      ownedBranch === null ? "example" : `example--${ownedBranch}`;
    const home = env.HOME;
    if (!home) {
      throw new Error("fixture HOME is required");
    }
    const registryDir = join(home, ".hack");
    await mkdir(registryDir, { recursive: true });
    const registryPath = join(registryDir, "projects.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "example-id",
            name: "example",
            repoRoot: primary,
            projectDir: join(primary, ".hack"),
            projectDirName: ".hack",
            createdAt: "2026-01-01T00:00:00Z",
            worktrees: [
              {
                path: worktree,
                branch: "new-branch",
                lastSeenAt: "2026-01-01T00:00:00Z",
              },
            ],
            autostart: {
              branch: ownedBranch,
              paused: false,
              lastResult: null,
              lastAttemptBootId: null,
            },
          },
        ],
      }),
      { mode: 0o600 }
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    const calls = join(root, "docker-calls");
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes("down")) { const f=Bun.file(${JSON.stringify(calls)}); await Bun.write(f, (await f.exists() ? await f.text() : "")+JSON.stringify(args)+"\\n"); } else if(args.includes("ps")||args.includes("inspect")) process.stdout.write("[]");\n`,
      { mode: 0o755 }
    );
    const gitPath = Bun.which("git");
    if (!gitPath) {
      throw new Error("fixture git required");
    }
    const { symlink } = await import("node:fs/promises");
    await symlink(gitPath, join(bin, "git"));
    const driver = join(root, "down-driver.ts");
    const runtimeModule = resolve("src/lib/runtime-projects.ts");
    const cliModule = resolve("src/cli/run.ts");
    await writeFile(
      driver,
      `
import { mock } from "bun:test";
const actual = await import(${JSON.stringify(runtimeModule)});
const replacement = { ...actual, readRuntimeProjects: async () => ({
  ok: true, error: null, checkedAtMs: 1,
  runtime: [{project: ${JSON.stringify(ownedComposeProject)}, workingDir: ${JSON.stringify(join(worktree, ".hack"))}, services: new Map(), isGlobal: false}]
}) };
mock.module(${JSON.stringify(runtimeModule)}, () => replacement);
const { runCli } = await import(${JSON.stringify(cliModule)});
process.exitCode = await runCli(["down", "--json", "--no-interactive"]);
`
    );

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lock = withAutostartProjectLock({
      registryPath,
      scope: {
        projectId: "example-id",
        composeProject: "example",
        branch: ownedBranch,
      },
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const child = Bun.spawn([process.execPath, driver], {
      cwd: worktree,
      env: { ...env, PATH: bin },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    try {
      const deadline = Date.now() + 8000;
      while (
        Date.now() < deadline &&
        child.exitCode === null &&
        !(await Bun.file(registryPath).json()).projects[0].autostart.paused
      ) {
        await Bun.sleep(10);
      }
      if (
        !(await Bun.file(registryPath).json()).projects[0].autostart.paused &&
        child.exitCode !== null
      ) {
        const [stdout, stderr, code] = await output;
        throw new Error(
          `source down exited before pause (code ${code}): ${stdout}${stderr}`
        );
      }
      expect(
        (await Bun.file(registryPath).json()).projects[0].autostart.paused
      ).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(await Bun.file(calls).exists()).toBe(false);
      release.resolve();
      await lock;
      const [stdout, stderr, code] = await output;
      expect(code, stdout + stderr).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        data: { branch: ownedBranch },
      });
      const downArgs = JSON.parse((await Bun.file(calls).text()).trim());
      if (ownedBranch === null) {
        expect(downArgs).not.toContain("--project-name");
        expect(downArgs).not.toContain("-p");
      } else {
        expect(downArgs).toContain(ownedComposeProject);
      }
      expect(downArgs).not.toContain("example--new-branch");
      const activity = await readActivity({
        path: join(registryDir, "activity.jsonl"),
        limit: 10,
      });
      expect(activity.at(-1)).toMatchObject({
        action: "down",
        branch: ownedBranch,
      });
    } finally {
      release.resolve();
      await lock;
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await output;
    }
  }, 15_000);
}
