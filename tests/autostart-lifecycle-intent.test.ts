import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyAutostartExit } from "../src/daemon/autostart.ts";
import {
  assertAutostartProjectCurrent,
  withAutostartProjectLock,
} from "../src/lib/autostart-project-lock.ts";
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
          HACK_AUTOSTART_PROJECT_ID: login ? "sample" : undefined,
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
test("login refuses a pending legacy migration without touching dotenv or changing intent", async () => {
  await writeRegistry(false);
  const envFile = join(root, "project", ".hack", ".env");
  await writeFile(envFile, "SAMPLE_VALUE=fixture\n");
  const result = await run(["up", "--json", "-d"], true);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("pending env migration");
  expect(await Bun.file(envFile).text()).toBe("SAMPLE_VALUE=fixture\n");
  expect((await marker()).paused).toBe(false);
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

async function waitForCondition(
  check: () => Promise<boolean>,
  message: string
) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(message);
}

test("source down pauses before waiting for a start and holds admission through runtime shutdown", async () => {
  await writeRegistry(false);
  const registryPath = join(root, "home", ".hack", "projects.json");
  const enteredDown = join(root, "down-entered");
  const releaseDown = join(root, "release-down");
  await writeFile(
    join(root, "bin", "docker"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("down")) { await Bun.write(${JSON.stringify(enteredDown)}, "entered"); const deadline=Date.now()+10000; while (!(await Bun.file(${JSON.stringify(releaseDown)}).exists())) { if(Date.now()>deadline) process.exit(99); await Bun.sleep(10); } } else if (args.includes("ps") || args.includes("inspect")) { process.stdout.write("[]"); }\n`,
    { mode: 0o755 }
  );
  const scope = { projectId: "sample", composeProject: "sample", branch: null };
  const startEntered = Promise.withResolvers<void>();
  const releaseStart = Promise.withResolvers<void>();
  let firstStartPublished = false;
  const firstStart = withAutostartProjectLock({
    scope,
    registryPath,
    run: async () => {
      startEntered.resolve();
      await releaseStart.promise;
      await assertAutostartProjectCurrent({ scope, registryPath });
      firstStartPublished = true;
    },
  }).then(
    () => ({ refused: false }),
    (error: unknown) => ({ refused: true, error })
  );
  await startEntered.promise;
  let downFinished = false;
  const down = run(["down", "--json"]).then((result) => {
    downFinished = true;
    return result;
  });
  let queuedStartEntered = false;
  let secondStart: Promise<unknown> | undefined;
  try {
    await waitForCondition(
      async () => (await marker()).paused === true,
      "source down did not publish its pause before waiting"
    );
    expect(downFinished).toBe(false);
    expect(await Bun.file(enteredDown).exists()).toBe(false);
    releaseStart.resolve();
    const firstOutcome = await firstStart;
    expect(firstOutcome).toMatchObject({
      refused: true,
      error: { code: "E_CANCELLED", detail: { reason: "paused" } },
    });
    expect(firstStartPublished).toBe(false);
    await waitForCondition(
      () => Bun.file(enteredDown).exists(),
      "source down never reached the fake runtime shutdown"
    );
    secondStart = withAutostartProjectLock({
      scope,
      registryPath,
      run: async () => {
        queuedStartEntered = true;
        await assertAutostartProjectCurrent({ scope, registryPath });
      },
    }).then(
      () => ({ refused: false }),
      (error: unknown) => ({ refused: true, error })
    );
    await Bun.sleep(75);
    expect(queuedStartEntered).toBe(false);
    expect(downFinished).toBe(false);
    await Bun.write(releaseDown, "release");
    const result = await down;
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(await secondStart).toMatchObject({
      refused: true,
      error: { code: "E_CANCELLED", detail: { reason: "paused" } },
    });
    expect((await marker()).paused).toBe(true);
  } finally {
    releaseStart.resolve();
    await Bun.write(releaseDown, "release");
    await Promise.allSettled([
      firstStart,
      down,
      ...(secondStart ? [secondStart] : []),
    ]);
  }
}, 20_000);

test("a login child cannot resume a manually paused project or substitute a different registry identity", async () => {
  const paused = await run(["up", "--json", "-d"], true);
  expect(paused.exitCode).not.toBe(0);
  expect(paused.stdout).toContain("E_CANCELLED");
  expect((await marker()).paused).toBe(true);
  await writeRegistry(false);
  const mismatched = await run(
    ["up", "--json", "-d"],
    true,
    join(root, "project"),
    { HACK_AUTOSTART_PROJECT_ID: "different-project" }
  );
  expect(mismatched.exitCode).not.toBe(0);
  expect(mismatched.stdout).toContain("project path changed");
  expect((await marker()).paused).toBe(false);
});

async function legacyWritableRegistry(redirect = false) {
  await writeRegistry(false);
  const path = join(root, "home", ".hack", "projects.json");
  const registry = await Bun.file(path).json();
  Reflect.deleteProperty(registry.projects[0], "autostart");
  if (redirect) {
    const other = join(root, "redirected");
    await mkdir(join(other, ".hack"), { recursive: true });
    await writeFile(
      join(other, ".hack", "hack.config.json"),
      '{"name":"sample"}'
    );
    await writeFile(
      join(other, ".hack", "docker-compose.yml"),
      "services:\n  app:\n    image: example.invalid/app\n"
    );
    registry.projects[0].repoRoot = other;
    registry.projects[0].projectDir = join(other, ".hack");
  }
  await writeFile(path, JSON.stringify(registry));
  await chmod(path, 0o664);
  return { path, before: await Bun.file(path).text() };
}

test("named add refuses laundering an unsafe legacy registry redirected away from cwd", async () => {
  const { path, before } = await legacyWritableRegistry(true);
  const result = await run([
    "autostart",
    "add",
    "--project",
    "sample",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_PERMISSION" },
  });
  expect(await Bun.file(path).text()).toBe(before);
  expect((await stat(path)).mode & 0o777).toBe(0o664);
  expect(await marker()).toBeUndefined();
});

test("named add outside a project refuses unsafe first opt-in but preserves trusted named selection", async () => {
  const { path, before } = await legacyWritableRegistry();
  const refused = await run(
    ["autostart", "add", "--project", "sample", "--json"],
    false,
    root
  );
  expect(refused.exitCode).not.toBe(0);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_PERMISSION" },
  });
  expect(await Bun.file(path).text()).toBe(before);
  await chmod(path, 0o600);
  const trusted = await run(
    ["autostart", "add", "--project", "sample", "--json"],
    false,
    root
  );
  expect(trusted.exitCode, trusted.stdout + trusted.stderr).toBe(0);
  expect((await marker()).paused).toBe(false);
});

test("reviewed cwd legacy first opt-in rebuilds a private registry and reports its repair", async () => {
  const { path } = await legacyWritableRegistry();
  const result = await run([
    "autostart",
    "add",
    "--project",
    "sample",
    "--json",
  ]);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { action: "add" },
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(result.stderr).toContain("registry permissions to 0600");
  expect((await marker()).paused).toBe(false);
});

test("manual up bypasses the auxiliary lock while every legacy down retains serialization", async () => {
  const locks = join(root, "home", ".hack", "autostart-locks");
  await mkdir(locks, { mode: 0o777 });
  await chmod(locks, 0o777);
  const path = join(root, "home", ".hack", "projects.json");
  for (const marked of [false, true]) {
    await writeRegistry(false);
    if (!marked) {
      const registry = await Bun.file(path).json();
      Reflect.deleteProperty(registry.projects[0], "autostart");
      await writeFile(path, JSON.stringify(registry));
    }
    const up = await run(["up", "--json", "-d"]);
    expect(up.stdout + up.stderr).not.toContain("lock directory is unsafe");
    const down = await run(["down", "--json"]);
    expect(down.stdout + down.stderr).toContain("lock directory is unsafe");
  }
});

test("up --always cannot launder a redirected unsafe named registration before opt-in", async () => {
  const { path, before } = await legacyWritableRegistry(true);
  const result = await run([
    "up",
    "--always",
    "--project",
    "sample",
    "--json",
    "-d",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_PERMISSION" },
  });
  expect(await Bun.file(path).text()).toBe(before);
  expect((await stat(path)).mode & 0o777).toBe(0o664);
});

test("down still waits for an admitted login child after its marker is removed", async () => {
  await writeRegistry(false);
  const registryPath = join(root, "home", ".hack", "projects.json");
  const scope = { projectId: "sample", composeProject: "sample", branch: null };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = withAutostartProjectLock({
    scope,
    registryPath,
    run: async () => {
      entered.resolve();
      await release.promise;
      await assertAutostartProjectCurrent({ scope, registryPath });
    },
  }).then(
    () => ({ refused: false }),
    (error: unknown) => ({ refused: true, error })
  );
  await entered.promise;
  const registry = await Bun.file(registryPath).json();
  Reflect.deleteProperty(registry.projects[0], "autostart");
  await writeFile(registryPath, JSON.stringify(registry));
  let finished = false;
  const down = run(["down", "--json"]).then((value) => {
    finished = true;
    return value;
  });
  try {
    await Bun.sleep(650);
    expect(finished).toBe(false);
    release.resolve();
    expect(await start).toMatchObject({
      refused: true,
      error: { code: "E_CANCELLED" },
    });
    await down;
    expect(finished).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([start, down]);
  }
});
