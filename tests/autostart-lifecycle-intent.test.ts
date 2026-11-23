import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withAutostartCommandLock } from "../src/commands/project-autostart-intent.ts";
import { classifyAutostartExit } from "../src/daemon/autostart.ts";
import {
  assertAutostartProjectCurrent,
  withAutostartProjectLock,
} from "../src/lib/autostart-project-lock.ts";
import { resolveDesktopComposeProjectName } from "../src/lib/compose-project-name.ts";
import { readLifecycleState } from "../src/lib/lifecycle-runtime.ts";
import { sanitizeProjectSlug } from "../src/lib/project.ts";
import { restoreEnv } from "./helpers/env.ts";
import {
  mkdirOwnedFixture,
  writeOwnedFixture,
} from "./helpers/owned-fixture.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
const cli = resolve("index.ts");
// Fixture Docker selection inputs: the host's socket, plugins and ACLs never decide.
const DOCKER_TRUST_PRELOAD = resolve(
  import.meta.dir,
  "helpers/autostart-docker-trust-preload.ts"
);
beforeEach(async () => {
  // macOS links /var to /private/var; the product compares resolved paths.
  root = await realpath(await mkdtemp(join(tmpdir(), "autostart-intent-")));
  await mkdirOwnedFixture(join(root, "project", ".hack"), true);
  await mkdirOwnedFixture(join(root, "home", ".hack"), true);
  await mkdirOwnedFixture(join(root, "bin"));
  await writeOwnedFixture(
    join(root, "project", ".hack", "hack.config.json"),
    '{"name":"sample"}'
  );
  await writeOwnedFixture(
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
    [
      process.execPath,
      "--preload",
      DOCKER_TRUST_PRELOAD,
      cli,
      "--no-interactive",
      ...args,
    ],
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

async function writeInterpolatedStack(projectRoot: string, variable: string) {
  const composeFile = join(projectRoot, ".hack", "docker-compose.yml");
  await writeOwnedFixture(
    composeFile,
    `name: "\${${variable}:-sample}"\nservices:\n  app:\n    image: example.invalid/app\n`
  );
  return { projectRoot, composeFile };
}

async function installComposeNameFixture(opts?: {
  readonly failFirstProbe?: boolean;
  readonly holdStart?: boolean;
  readonly foreignCheckout?: string;
  readonly startContainers?: boolean;
}) {
  await writeFile(
    join(root, "bin", "docker"),
    `#!${process.execPath}
import { rm } from "node:fs/promises";
const fixture = ${JSON.stringify(root)};
const options = ${JSON.stringify(opts ?? {})};
const args = process.argv.slice(2);
const mode = args.find((arg) => ["config", "ps", "inspect", "up", "down"].includes(arg));
const running = fixture + "/compose-running";
if (mode === "config" && args[args.indexOf("-f") + 1] === "-") {
  const model = JSON.parse(await Bun.stdin.text());
  if (options.failFirstProbe && !(await Bun.file(fixture + "/name-probed").exists())) {
    await Bun.write(fixture + "/name-probed", "probed");
    process.exit(1);
  }
  const match = /:-([a-z]+)}/.exec(model.name);
  if (!match) process.exit(1);
  if (args.includes("/dev/null")) await Bun.write(fixture + "/unattended-probe", "seen");
  process.stdout.write(JSON.stringify({name: match[1]}));
} else if (mode === "config") {
  process.stdout.write(JSON.stringify({name: "sample", services: {app: {image: "example.invalid/app"}}}));
} else if (mode === "inspect" && args[0] === "image") {
  process.stdout.write("sha256:" + "a".repeat(64) + "\\n");
} else if (mode === "ps" || mode === "inspect") {
  const directory = options.foreignCheckout ?? (await Bun.file(running).exists() ? process.cwd() : null);
  process.stdout.write(JSON.stringify(directory ? [{
    ID: "fixture-container", Service: "app", State: "running",
    Labels: "com.docker.compose.project.working_dir=" + directory
  }] : []));
} else if (mode === "up") {
  if (options.holdStart && args.includes("--no-start")) {
    await Bun.write(fixture + "/compose-start", JSON.stringify(args));
    const deadline = Date.now() + 12000;
    while (!(await Bun.file(fixture + "/release-start").exists())) {
      if (Date.now() > deadline) process.exit(99);
      await Bun.sleep(10);
    }
  }
  if (!options.startContainers) process.exit(1);
  if (args.includes("-d")) await Bun.write(running, "running");
} else if (mode === "down") {
  await Bun.write(fixture + "/compose-down", JSON.stringify(args));
  await rm(running, { force: true });
}
`,
    { mode: 0o755 }
  );
}

test("desktop Stop and Start update Always on intent for an interpolated name", async () => {
  await writeInterpolatedStack(join(root, "project"), "STACK_A");
  await installComposeNameFixture();
  await writeRegistry(false);
  const bound = [
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ];
  await run(["down", ...bound]);
  expect((await marker()).paused).toBe(true);
  await run(["up", "-d", ...bound]);
  expect((await marker()).paused).toBe(false);
});

test("a failed Always on identity lookup stops the command before it can retry", async () => {
  await writeInterpolatedStack(join(root, "project"), "STACK_A");
  await installComposeNameFixture({ failFirstProbe: true });
  await writeRegistry(false);
  const down = [
    "down",
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ];
  const failed = await run(down);
  expect(failed.exitCode).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_COMPOSE_FAILED",
      message: "Could not resolve the Compose project name.",
    },
  });
  const invocation = Bun.file(join(root, "compose-down"));
  expect(await invocation.exists()).toBe(false);
  expect((await marker()).paused).toBe(false);
  const retried = await run(down);
  expect(retried.exitCode, retried.stderr || retried.stdout).toBe(0);
  expect(await invocation.exists()).toBe(true);
  expect((await marker()).paused).toBe(true);
});

for (const login of [false, true]) {
  test(`ordinary Down shares the Compose lock with ${login ? "login startup" : "desktop Start"} on an interpolated stack`, async () => {
    const projectRoot = join(root, "project");
    await writeOwnedFixture(
      join(projectRoot, ".hack", "hack.config.json"),
      '{"name":"sample","dev_host":"sample.hack"}'
    );
    await writeInterpolatedStack(projectRoot, "STACK_A");
    await installComposeNameFixture({ holdStart: true });
    await writeRegistry(false);
    const start = run(
      [
        "up",
        "-d",
        "--json",
        ...(login
          ? []
          : ["--target", "local", "--expect-compose-project", "sample"]),
      ],
      login
    );
    const releaseStart = join(root, "release-start");
    const downInvocation = join(root, "compose-down");
    let down: ReturnType<typeof run> | undefined;
    try {
      await waitForCondition(
        () => Bun.file(join(root, "compose-start")).exists(),
        "Start did not reach the held Compose phase"
      );
      const upArgs = await Bun.file(join(root, "compose-start")).json();
      expect(upArgs.slice(0, 3)).toEqual(["compose", "-p", "sample"]);
      if (login) {
        expect(upArgs).toContain("/dev/null");
        expect(await Bun.file(join(root, "unattended-probe")).exists()).toBe(
          true
        );
      }
      down = run(["down", "--json"]);
      await waitForCondition(
        async () => (await marker()).paused === true,
        "ordinary Down did not publish its Always on pause"
      );
      await Promise.race([Bun.sleep(250), down]);
      expect(await Bun.file(downInvocation).exists()).toBe(false);
      await Bun.write(releaseStart, "release");
      await start;
      const stopped = await down;
      expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
      expect((await Bun.file(downInvocation).json()).slice(0, 3)).toEqual([
        "compose",
        "-p",
        "sample",
      ]);
      expect((await marker()).paused).toBe(true);
    } finally {
      await Bun.write(releaseStart, "release");
      await Promise.allSettled([start, down]);
    }
  }, 25_000);
}

test("ordinary Down refuses an interpolated branch stack owned by another checkout", async () => {
  await writeInterpolatedStack(join(root, "project"), "STACK_A");
  await installComposeNameFixture({
    foreignCheckout: join(root, "foreign", ".hack"),
  });
  const stopped = await run(["down", "--branch", "preview", "--json"]);
  expect(stopped.exitCode).toBe(1);
  expect(JSON.parse(stopped.stdout)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("do not all belong to this checkout"),
    },
  });
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
});

const supervisorBinary = process.env.HACK_TEST_SUPERVISOR_BINARY;
for (const desktopStarts of [true, false]) {
  test.skipIf(!supervisorBinary)(
    desktopStarts
      ? "ordinary Down stops the host process launched by desktop Start"
      : "desktop Stop retires the legacy host process launched by ordinary Start",
    async () => {
      const projectRoot = join(root, "project");
      const projectDir = join(projectRoot, ".hack");
      await writeOwnedFixture(
        join(projectDir, "hack.config.json"),
        JSON.stringify({
          name: "sample",
          dev_host: "sample.hack",
          lifecycle: {
            runner: "supervisor",
            processes: [{ name: "sleeper", command: "exec /bin/sleep 120" }],
          },
        })
      );
      await writeInterpolatedStack(projectRoot, "STACK_A");
      await installComposeNameFixture({ startContainers: true });
      const env = {
        HACK_LIFECYCLE_SUPERVISOR_BINARY: supervisorBinary ?? "",
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      };
      const bound = [
        "--target",
        "local",
        "--expect-compose-project",
        "sample",
        "--json",
      ];
      try {
        const started = await run(
          ["up", "-d", ...(desktopStarts ? bound : ["--json"])],
          false,
          projectRoot,
          env
        );
        expect(started.exitCode, started.stderr || started.stdout).toBe(0);
        const state = await readLifecycleState({ projectDir });
        expect(state[0]).toMatchObject({
          backend: "supervisor",
          composeProject: desktopStarts
            ? "sample"
            : sanitizeProjectSlug("${STACK_A:-sample}"),
        });
        const pid = state[0]?.processes[0]?.processGroupId ?? 0;
        expect(pid).toBeGreaterThan(1);
        expect(() => process.kill(-pid, 0)).not.toThrow();
        const stopped = await run(
          ["down", ...(desktopStarts ? ["--json"] : bound)],
          false,
          projectRoot,
          env
        );
        expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
        expect(await readLifecycleState({ projectDir })).toHaveLength(0);
        expect(() => process.kill(-pid, 0)).toThrow();
      } finally {
        await run(["down", ...bound], false, projectRoot, env);
      }
    },
    30_000
  );
}

test("desktop Starts from different expressions lock the same resolved branch stack", async () => {
  const secondRoot = join(root, "second");
  await mkdirOwnedFixture(join(secondRoot, ".hack"), true);
  const firstProject = await writeInterpolatedStack(
    join(root, "project"),
    "STACK_A"
  );
  const secondProject = await writeInterpolatedStack(secondRoot, "STACK_B");
  await installComposeNameFixture();
  const previous = {
    HACK_GLOBAL_CONFIG_PATH: process.env.HACK_GLOBAL_CONFIG_PATH,
    HACK_AUTOSTART_LOGIN: process.env.HACK_AUTOSTART_LOGIN,
    PATH: process.env.PATH,
  };
  process.env.HACK_GLOBAL_CONFIG_PATH = join(
    root,
    "home",
    ".hack",
    "hack.config.json"
  );
  process.env.HACK_AUTOSTART_LOGIN = "0";
  process.env.PATH = join(root, "bin");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = async (
    project: Awaited<ReturnType<typeof writeInterpolatedStack>>,
    run: () => Promise<void>
  ) => {
    const name = await resolveDesktopComposeProjectName({ project });
    expect(name).toBe("sample");
    return await withAutostartCommandLock({
      action: "up",
      cwd: project.projectRoot,
      branch: "preview",
      expectComposeProject: `${name}--preview`,
      run,
    });
  };
  const first = start(firstProject, async () => {
    entered.resolve();
    await release.promise;
  });
  let second: Promise<void> | undefined;
  try {
    await Promise.race([entered.promise, first]);
    const lockName = createHash("sha256")
      .update("sample--preview")
      .digest("hex");
    expect(
      await Bun.file(
        join(root, "home", ".hack", "autostart-locks", `${lockName}.lock`)
      ).exists()
    ).toBe(true);
    let secondRan = false;
    second = start(secondProject, async () => {
      secondRan = true;
    });
    await Promise.race([Bun.sleep(250), second]);
    expect(secondRan).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    for (const [key, value] of Object.entries(previous)) {
      restoreEnv(key, value);
    }
  }
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
  await writeOwnedFixture(envFile, "SAMPLE_VALUE=fixture\n");
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

test("login treats an unfinished env migration as a manual-start refusal, not a failed start", async () => {
  await writeRegistry(false);
  const projectRoot = await realpath(join(root, "project"));
  const journalDir = join(
    root,
    "home",
    ".hack",
    "env-migrations",
    createHash("sha256").update(projectRoot).digest("hex")
  );
  await mkdir(journalDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(journalDir, "journal.json"),
    JSON.stringify({
      version: 1,
      kind: "hack-env-migration",
      project: { projectRoot },
      state: "applying",
    }),
    { mode: 0o600 }
  );
  const result = await run(["up", "--json", "-d"], true);
  expect(result.exitCode).not.toBe(0);
  expect(classifyAutostartExit(result)).toEqual({
    status: "skipped",
    reason: "pending_env_migration",
  });
  expect((await marker()).paused).toBe(false);
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
    await mkdirOwnedFixture(join(other, ".hack"), true);
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
