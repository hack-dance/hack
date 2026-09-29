import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import type { ProjectContext } from "../src/lib/project.ts";
import {
  readProjectsRegistry,
  touchProjectRegistration,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalHackHome: string | undefined;
let originalGlobalConfig: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalHackHome = process.env.HACK_HOME;
  originalGlobalConfig = process.env.HACK_GLOBAL_CONFIG_PATH;
  Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  Reflect.deleteProperty(process.env, "HACK_HOME");
  tempDir = await mkdtemp(join(tmpdir(), "hack-registry-touch-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  for (const [key, value] of [
    ["HOME", originalHome],
    ["HACK_HOME", originalHackHome],
    ["HACK_GLOBAL_CONFIG_PATH", originalGlobalConfig],
  ] as const) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});

function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): void {
  const result = Bun.spawnSync(["git", "-C", opts.cwd, ...opts.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed\n${Buffer.from(result.stderr).toString("utf8")}`
    );
  }
}

function projectContextFor(root: string): ProjectContext {
  return {
    projectRoot: root,
    projectDirName: ".hack",
    projectDir: join(root, ".hack"),
    composeFile: join(root, ".hack", PROJECT_COMPOSE_FILENAME),
    envFile: join(root, ".hack", PROJECT_ENV_FILENAME),
    configFile: join(root, ".hack", PROJECT_CONFIG_FILENAME),
  };
}

async function createFixture(): Promise<{
  readonly primary: ProjectContext;
  readonly worktreeRoot: string;
}> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }

  const primaryRoot = join(tempDir, "repo-primary");
  const projectDir = join(primaryRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ name: "touchy", dev_host: "touchy.hack" }, null, 2)}\n`
  );
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");
  await writeFile(join(primaryRoot, "README.md"), "# fixture\n");

  runGit({ cwd: primaryRoot, args: ["init", "-b", "main"] });
  runGit({
    cwd: primaryRoot,
    args: ["config", "user.email", "test@example.com"],
  });
  runGit({ cwd: primaryRoot, args: ["config", "user.name", "Test User"] });
  runGit({ cwd: primaryRoot, args: ["add", "."] });
  runGit({ cwd: primaryRoot, args: ["commit", "-m", "init"] });

  const worktreeRoot = join(tempDir, "repo-worktree");
  runGit({
    cwd: primaryRoot,
    args: ["worktree", "add", "-b", "feature/touch", worktreeRoot],
  });

  return { primary: projectContextFor(primaryRoot), worktreeRoot };
}

test("touchProjectRegistration from a linked worktree records the sibling checkout", async () => {
  const fixture = await createFixture();

  await upsertProjectRegistration({
    project: fixture.primary,
    nowIso: "2026-01-01T00:00:00Z",
  });

  const outcome = await touchProjectRegistration({
    project: projectContextFor(fixture.worktreeRoot),
  });
  expect(outcome).not.toBeNull();
  expect(outcome?.status).toBe("noop");

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(1);
  const worktrees = registry.projects[0]?.worktrees ?? [];
  expect(worktrees).toHaveLength(1);
  expect(worktrees[0]?.path).toBe(await realpath(fixture.worktreeRoot));
  expect(worktrees[0]?.branch).toBe("feature/touch");
});

test("touchProjectRegistration never throws for a broken project context", async () => {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  // Make the registry directory unusable by pointing HOME at a file.
  const fakeHome = join(tempDir, "home-as-file");
  await writeFile(fakeHome, "not a directory\n");
  process.env.HOME = fakeHome;

  const outcome = await touchProjectRegistration({
    project: projectContextFor(join(tempDir, "missing-root")),
  });
  expect(outcome).toBeNull();
});

test("fresh primary observations preserve registry bytes and mtime; explicit registration still refreshes", async () => {
  const { primary } = await createFixture();
  await upsertProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  const path = join(tempDir ?? "missing-fixture", ".hack", "projects.json");
  const before = await readFile(path, "utf8");
  const modified = (await stat(path)).mtimeMs;
  for (let index = 0; index < 32; index++) {
    expect(
      (
        await touchProjectRegistration({
          project: primary,
          nowIso: "2026-01-01T00:00:30Z",
        })
      )?.status
    ).toBe("noop");
  }
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await stat(path)).mtimeMs).toBe(modified);
  await upsertProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:00:30Z",
  });
  expect((await readProjectsRegistry()).projects[0]?.lastSeenAt).toBe(
    "2026-01-01T00:00:30Z"
  );
});

test("expired observations refresh and configuration changes bypass coalescing", async () => {
  const { primary } = await createFixture();
  await upsertProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  await touchProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:01:00Z",
  });
  expect((await readProjectsRegistry()).projects[0]?.lastSeenAt).toBe(
    "2026-01-01T00:01:00Z"
  );
  await writeFile(
    primary.configFile,
    JSON.stringify({ name: "renamed", dev_host: "new.hack" })
  );
  await touchProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:01:01Z",
  });
  expect((await readProjectsRegistry()).projects[0]).toMatchObject({
    name: "renamed",
    devHost: "new.hack",
    lastSeenAt: "2026-01-01T00:01:01Z",
  });
});

test("fresh worktree observations preserve bytes while branch changes are recorded", async () => {
  const { primary, worktreeRoot } = await createFixture();
  const project = projectContextFor(worktreeRoot);
  await upsertProjectRegistration({
    project: primary,
    nowIso: "2026-01-01T00:00:00Z",
  });
  await touchProjectRegistration({ project, nowIso: "2026-01-01T00:00:01Z" });
  const path = join(tempDir ?? "missing-fixture", ".hack", "projects.json");
  const before = await readFile(path, "utf8");
  const lock = `${path}.lock`;
  await writeFile(lock, "fixture-owner");
  expect(
    (
      await touchProjectRegistration({
        project,
        nowIso: "2026-01-01T00:00:02Z",
      })
    )?.status
  ).toBe("noop");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readFile(lock, "utf8")).toBe("fixture-owner");
  await rm(lock);
  runGit({ cwd: worktreeRoot, args: ["checkout", "-b", "feature/changed"] });
  await touchProjectRegistration({ project, nowIso: "2026-01-01T00:00:03Z" });
  expect(
    (await readProjectsRegistry()).projects[0]?.worktrees?.[0]?.branch
  ).toBe("feature/changed");
});

for (const stale of [false, true]) {
  test(`optional expired touch defers a ${stale ? "stale-looking" : "fresh"} busy lock without reclamation`, async () => {
    const { primary } = await createFixture();
    await upsertProjectRegistration({
      project: primary,
      nowIso: "2026-01-01T00:00:00Z",
    });
    const path = join(tempDir ?? "missing-fixture", ".hack", "projects.json");
    const before = await readFile(path, "utf8");
    const lock = `${path}.lock`;
    await writeFile(lock, "fixture-owner");
    if (stale) {
      await utimes(lock, new Date(0), new Date(0));
    }
    const start = performance.now();
    expect(
      await touchProjectRegistration({
        project: primary,
        nowIso: "2026-01-01T00:01:00Z",
      })
    ).toBeNull();
    // Existing required writes wait two seconds; optional discovery must not do so.
    expect(performance.now() - start).toBeLessThan(1500);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(lock, "utf8")).toBe("fixture-owner");
  });
}
