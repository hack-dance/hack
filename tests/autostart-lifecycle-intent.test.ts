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
import { quoteShellWord } from "../src/lib/logs.ts";
import { sanitizeProjectSlug } from "../src/lib/project.ts";
import {
  readProjectRuntimeState,
  readProjectRuntimeStateEntry,
  removeProjectRuntimeStateEntry,
  upsertProjectRuntimeStateEntry,
} from "../src/lib/project-runtime-state.ts";
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
  overrides: Readonly<Record<string, string>> = {},
  extraPreload?: string
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      DOCKER_TRUST_PRELOAD,
      ...(extraPreload ? ["--preload", extraPreload] : []),
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
  readonly holdRestart?: boolean;
  readonly holdBeforePin?: boolean;
  readonly foreignCheckout?: string;
  readonly foreignStack?: string;
  readonly foreignContext?: string;
  readonly defaultStack?: string;
  readonly shellStack?: string;
  readonly startContainers?: boolean;
  readonly savedContextOnly?: boolean;
}) {
  await writeFile(
    join(root, "bin", "docker"),
    `#!${process.execPath}
import { rm } from "node:fs/promises";
const fixture = ${JSON.stringify(root)};
const options = ${JSON.stringify(opts ?? {})};
const args = process.argv.slice(2);
const mode = args.find((arg) => ["config", "ps", "inspect", "up", "down", "exec", "stop", "logs"].includes(arg));
const running = fixture + "/compose-running";
const created = fixture + "/compose-created";
const containerId = "f".repeat(64);
const context = process.env.DOCKER_CONTEXT || "none";
const stack = args.includes("-p") ? args[args.indexOf("-p") + 1] : process.env.COMPOSE_PROJECT_NAME || options.defaultStack || "sample";
if (mode === "config" && args[args.indexOf("-f") + 1] === "-") {
  const model = JSON.parse(await Bun.stdin.text());
  if (options.failFirstProbe && !(await Bun.file(fixture + "/name-probed").exists())) {
    await Bun.write(fixture + "/name-probed", "probed");
    process.exit(1);
  }
  const resolveName = (expression) => {
    const match = /^\\$\\{([A-Z_]+):-([a-z]+)\\}$/.exec(expression);
    return match ? process.env[match[1]] || match[2] : expression;
  };
  const name = process.env.COMPOSE_PROJECT_NAME || resolveName(model.name);
  const labels = Object.fromEntries(Object.entries(model.services.probe.labels ?? {}).map(([key, value]) => [key, resolveName(value)]));
  if (args.includes("/dev/null")) await Bun.write(fixture + "/unattended-probe", "seen");
  process.stdout.write(JSON.stringify({name, services: {probe: {labels}}}));
} else if (mode === "config") {
  process.stdout.write(JSON.stringify({name: "sample", services: {app: {image: "example.invalid/app"}}}));
} else if (mode === "inspect" && args[0] === "image") {
  process.stdout.write("sha256:" + "a".repeat(64) + "\\n");
} else if (mode === "ps" && args.includes("--quiet")) {
  if (process.env.DOCKER_CONTEXT !== "saved-files-context") process.exit(9);
  if (!args.includes("-p") || !args.includes("sample")) process.exit(10);
  if (await Bun.file(running).exists()) process.stdout.write(containerId + "\\n");
} else if (mode === "inspect" && args.includes("--type")) {
  process.stdout.write(JSON.stringify({
    id: containerId, service: "app", state: "running", number: "1",
    oneOff: "False", project: "sample", workingDir: process.cwd(), mounts: []
  }) + "\\n");
} else if (mode === "exec") {
  if (args[0] === "compose") {
    if (stack !== (options.shellStack || "sample") || context !== "saved-files-context") process.exit(9);
    process.stdout.write("shell-ready\\n");
    process.exit(0);
  }
  if (args[1] !== containerId || process.env.DOCKER_CONTEXT !== "saved-files-context") process.exit(9);
  process.stdout.write("/app\\x0041ed:10:32\\0");
} else if (mode === "logs") {
  if (stack !== "sample" || context !== "saved-files-context") process.exit(9);
  process.stdout.write("app-1 | saved-overlay-log\\n");
} else if (mode === "ps" || mode === "inspect") {
  if (options.holdBeforePin && mode === "ps" && stack === "sample" && !(await Bun.file(fixture + "/release-start").exists())) {
    await Bun.write(fixture + "/before-pin", "entered");
    const deadline = Date.now() + 12000;
    while (!(await Bun.file(fixture + "/release-start").exists())) {
      if (Date.now() > deadline) process.exit(99);
      await Bun.sleep(10);
    }
  }
  const foreign = (!options.foreignStack || options.foreignStack === stack) && (!options.foreignContext || options.foreignContext === context);
  const inSavedContext = !options.savedContextOnly || context === "saved-files-context";
  const isRunning = await Bun.file(running).exists() && (await Bun.file(running).text()) === stack;
  const isCreated = await Bun.file(created).exists();
  const directory = (foreign ? options.foreignCheckout : undefined) ?? (inSavedContext && (isRunning || isCreated) ? process.cwd() : null);
  process.stdout.write(JSON.stringify(directory ? [{
    ID: "fixture-container", Service: "app", State: isCreated ? "created" : "running",
    Labels: "com.docker.compose.project.working_dir=" + directory
  }] : []));
} else if (mode === "up") {
  if (args.includes("--force-recreate")) {
    await Bun.write(fixture + "/restart-context", context);
    await Bun.write(fixture + "/restart-stack", stack);
  }
  const holdRestart = options.holdRestart && args.includes("--force-recreate");
  if (args.includes("--no-start") && (options.holdStart || holdRestart)) {
    if (holdRestart) {
      await rm(running, { force: true });
      await Bun.write(created, stack);
    }
    await Bun.write(fixture + "/compose-start", JSON.stringify(args));
    const deadline = Date.now() + 12000;
    while (!(await Bun.file(fixture + "/release-start").exists())) {
      if (Date.now() > deadline) process.exit(99);
      await Bun.sleep(10);
    }
  }
  if (!options.startContainers) process.exit(1);
  if (args.includes("-d")) {
    await rm(created, { force: true });
    await Bun.write(running, stack);
  }
} else if (mode === "down") {
  await Bun.write(fixture + "/compose-down", JSON.stringify(args));
  await Bun.write(fixture + "/down-context", context);
  await Bun.write(fixture + "/down-overlay", process.env.COMPOSE_PROJECT_NAME || "none");
  await rm(running, { force: true });
} else if (mode === "stop") {
  await Bun.write(fixture + "/stop-context", context);
  await rm(running, { force: true });
}
`,
    { mode: 0o755 }
  );
}

async function storeLegacyInterpolatedOverlay(projectDir: string) {
  const current = await readProjectRuntimeStateEntry({
    projectDir,
    composeProject: "sample",
  });
  if (!current) {
    throw new Error("The fixture did not save its launch overlay");
  }
  await upsertProjectRuntimeStateEntry({
    projectDir,
    entry: {
      ...current,
      composeProject: sanitizeProjectSlug("${STACK_A:-sample}"),
      launchComposeBase: undefined,
      pinnedComposeBase: undefined,
    },
  });
  await removeProjectRuntimeStateEntry({
    projectDir,
    composeProject: "sample",
  });
}

test("bound Files uses the legacy overlay saved by ordinary Start", async () => {
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  await writeOwnedFixture(
    join(projectDir, "hack.config.json"),
    '{"name":"sample","dev_host":"sample.hack"}'
  );
  await writeInterpolatedStack(projectRoot, "STACK_A");
  await installComposeNameFixture({ startContainers: true });
  await writeOwnedFixture(
    join(projectDir, "hack.env.qa.yaml"),
    "version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global:\n    DOCKER_CONTEXT: saved-files-context\n"
  );
  try {
    const started = await run(["up", "-d", "--env", "qa", "--json"]);
    expect(started.exitCode, started.stderr || started.stdout).toBe(0);
    await storeLegacyInterpolatedOverlay(projectDir);
    const files = await run([
      "files",
      "ls",
      "--expect-compose-project",
      "sample",
      "--json",
      "app",
      "/app",
    ]);
    expect(files.exitCode, files.stderr || files.stdout).toBe(0);
    expect(JSON.parse(files.stdout)).toMatchObject({
      ok: true,
      data: {
        schema: "hack.files.v1",
        service: "app",
        entry: { path: "/app" },
      },
    });
  } finally {
    await run([
      "down",
      "--target",
      "local",
      "--expect-compose-project",
      "sample",
      "--json",
    ]);
  }
}, 40_000);

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

for (const { label, login, overlay } of [
  {
    label: "desktop Start on an interpolated stack",
    login: false,
    overlay: false,
  },
  {
    label: "login startup on an interpolated stack",
    login: true,
    overlay: false,
  },
  {
    label: "login startup with a managed name interpolation",
    login: true,
    overlay: true,
  },
]) {
  test(`ordinary Down shares the Compose lock with ${label}`, async () => {
    const projectRoot = join(root, "project");
    if (overlay) {
      await configureManagedNameOverlay({
        defaultOverlay: true,
        interpolate: true,
      });
    } else {
      await writeOwnedFixture(
        join(projectRoot, ".hack", "hack.config.json"),
        '{"name":"sample","dev_host":"sample.hack"}'
      );
      await writeInterpolatedStack(projectRoot, "STACK_A");
    }
    const stack = overlay ? "alternate" : "sample";
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
      await Promise.race([
        waitForCondition(
          () => Bun.file(join(root, "compose-start")).exists(),
          "Start did not reach the held Compose phase"
        ),
        start.then((result) => {
          throw new Error(
            `Start exited before the held Compose phase: ${result.stderr || result.stdout}`
          );
        }),
      ]);
      const upArgs = await Bun.file(join(root, "compose-start")).json();
      expect(upArgs.slice(0, 3)).toEqual(["compose", "-p", stack]);
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
        stack,
      ]);
      expect((await marker()).paused).toBe(true);
    } finally {
      await Bun.write(releaseStart, "release");
      await Promise.allSettled([start, down]);
    }
  }, 25_000);
}

async function configureManagedNameOverlay(opts: {
  readonly defaultOverlay: boolean;
  readonly interpolate?: boolean;
}) {
  const projectDir = join(root, "project", ".hack");
  await writeOwnedFixture(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "sample",
      dev_host: "sample.hack",
      ...(opts.defaultOverlay ? { env: { defaultOverlay: "qa" } } : {}),
    })
  );
  if (opts.interpolate) {
    await writeInterpolatedStack(join(root, "project"), "STACK_NAME");
  } else {
    await writeOwnedFixture(
      join(projectDir, "docker-compose.yml"),
      "name: sample\nservices:\n  app:\n    image: example.invalid/app\n"
    );
  }
  const key = opts.interpolate ? "STACK_NAME" : "COMPOSE_PROJECT_NAME";
  await writeOwnedFixture(
    join(projectDir, "hack.env.qa.yaml"),
    `version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global:\n    ${key}: alternate\n`
  );
}

test("login startup leaves managed COMPOSE_PROJECT_NAME under the existing manual-start policy", async () => {
  await configureManagedNameOverlay({ defaultOverlay: true });
  await installComposeNameFixture({ holdStart: true });
  await writeRegistry(false);
  const started = await run(["up", "-d", "--json"], true);
  expect(started.exitCode).toBe(1);
  expect(JSON.parse(started.stdout)).toMatchObject({
    ok: false,
    error: { detail: { reason: "compose_inputs_require_manual_start" } },
  });
  expect(await Bun.file(join(root, "compose-start")).exists()).toBe(false);
});

test("ordinary Down reuses desktop Start's pinned name and saved managed overlay", async () => {
  await configureManagedNameOverlay({ defaultOverlay: false });
  await installComposeNameFixture({
    startContainers: true,
    foreignCheckout: join(root, "foreign", ".hack"),
    foreignStack: "alternate",
  });
  const started = await run([
    "up",
    "-d",
    "--env",
    "qa",
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ]);
  expect(started.exitCode, started.stderr || started.stdout).toBe(0);
  const stopped = await run(["down", "--json"]);
  expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
  expect(
    (await Bun.file(join(root, "compose-down")).json()).slice(0, 3)
  ).toEqual(["compose", "-p", "sample"]);
  expect(await Bun.file(join(root, "down-overlay")).text()).toBe("alternate");
}, 40_000);

test("desktop pins keep Compose underscores distinct from hyphens", async () => {
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  await writeOwnedFixture(
    join(projectDir, "docker-compose.yml"),
    "name: sample\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  await installComposeNameFixture({ startContainers: true });
  for (const name of ["demo_team", "demo-team"]) {
    const start = await run(
      [
        "up",
        "-d",
        "--target",
        "local",
        "--expect-compose-project",
        name,
        "--json",
      ],
      false,
      project,
      { COMPOSE_PROJECT_NAME: name }
    );
    expect(start.exitCode, start.stderr || start.stdout).toBe(0);
  }
  expect(await readProjectRuntimeState({ projectDir })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        composeProject: "demo_team",
        pinnedComposeBase: "demo_team",
      }),
      expect.objectContaining({
        composeProject: "demo-team",
        pinnedComposeBase: "demo-team",
      }),
    ])
  );
  const down = await run(["down", "--json"], false, project, {
    COMPOSE_PROJECT_NAME: "demo_team",
  });
  expect(down.exitCode, down.stderr || down.stdout).toBe(0);
  expect(
    (await Bun.file(join(root, "compose-down")).json()).slice(0, 3)
  ).toEqual(["compose", "-p", "demo_team"]);
  expect(
    await readProjectRuntimeStateEntry({
      projectDir,
      composeProject: "demo-team",
    })
  ).toMatchObject({
    pinnedComposeBase: "demo-team",
  });
}, 40_000);

test("Down refuses a normalized saved pin for a different Compose identity", async () => {
  const project = join(root, "project");
  await installComposeNameFixture();
  await upsertProjectRuntimeStateEntry({
    projectDir: join(project, ".hack"),
    entry: {
      composeProject: "demo-team",
      pinnedComposeBase: "demo_team",
      envName: null,
      updatedAt: new Date().toISOString(),
    },
  });
  const down = await run(["down", "--json"], false, project, {
    COMPOSE_PROJECT_NAME: "demo-team",
  });
  expect(down.exitCode).toBe(1);
  expect(down.stderr + down.stdout).toContain("ambiguous Compose project name");
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
});

test("Down refuses an unpinned state record shared by a legacy and exact Compose name", async () => {
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  await installComposeNameFixture();
  await writeOwnedFixture(
    join(projectDir, "docker-compose.yml"),
    "name: demo_team\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  await upsertProjectRuntimeStateEntry({
    projectDir,
    entry: {
      composeProject: "demo-team",
      envName: null,
      updatedAt: new Date().toISOString(),
    },
  });
  const down = await run(["down", "--json"], false, project, {
    COMPOSE_PROJECT_NAME: "demo-team",
  });
  expect(down.exitCode).toBe(1);
  expect(down.stderr + down.stdout).toContain("ambiguous Compose project name");
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
  expect(
    await readProjectRuntimeStateEntry({
      projectDir,
      composeProject: "demo-team",
    })
  ).not.toBeNull();
});

test("ordinary Down checks ownership of a stack named by a managed override", async () => {
  await configureManagedNameOverlay({ defaultOverlay: true });
  await installComposeNameFixture({
    foreignCheckout: join(root, "foreign", ".hack"),
    foreignStack: "alternate",
  });
  const stopped = await run(["down", "--json"]);
  expect(stopped.exitCode).toBe(1);
  expect(JSON.parse(stopped.stdout)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("do not all belong to this checkout"),
    },
  });
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
}, 40_000);

test("ordinary Restart preserves the desktop pin when a foreign stack has the overlay name", async () => {
  await configureManagedNameOverlay({ defaultOverlay: true });
  await installComposeNameFixture({
    startContainers: true,
    foreignCheckout: join(root, "foreign", ".hack"),
    foreignStack: "alternate",
  });
  const start = await run([
    "up",
    "-d",
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ]);
  expect(start.exitCode, start.stderr || start.stdout).toBe(0);
  const restart = await run(["restart", "--json"]);
  expect(restart.exitCode, restart.stderr || restart.stdout).toBe(0);
  const invocation = Bun.file(join(root, "restart-stack"));
  expect(await invocation.text()).toBe("sample");

  await rm(join(root, "restart-stack"));
  await installComposeNameFixture({
    startContainers: true,
    foreignCheckout: join(root, "foreign", ".hack"),
    foreignStack: "sample",
  });
  const refused = await run(["restart", "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout).toContain("do not all belong to this checkout");
  expect(await invocation.exists()).toBe(false);
}, 40_000);

test("unbound service Stop finds the desktop-pinned stack even with a managed name override", async () => {
  await configureManagedNameOverlay({ defaultOverlay: true });
  await installComposeNameFixture({ startContainers: true });
  const start = await run([
    "up",
    "-d",
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ]);
  expect(start.exitCode, start.stderr || start.stdout).toBe(0);
  const stop = await run(["down", "--service", "app", "--json"]);
  expect(stop.exitCode, stop.stderr || stop.stdout).toBe(0);
  expect(JSON.parse(stop.stdout)).toMatchObject({
    ok: true,
    data: { composeProject: "sample", services: { stopped: ["app"] } },
  });
  expect(await Bun.file(join(root, "stop-context")).exists()).toBe(true);
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
}, 40_000);

test("bound service Stop waits for ordinary Restart after it creates the containers", async () => {
  const projectDir = join(root, "project", ".hack");
  await writeOwnedFixture(
    join(projectDir, "hack.config.json"),
    '{"name":"sample","dev_host":"sample.hack"}'
  );
  await writeOwnedFixture(
    join(projectDir, "docker-compose.yml"),
    "name: sample\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  await installComposeNameFixture({ holdRestart: true, startContainers: true });
  const started = await run(["up", "-d", "--json"]);
  expect(started.exitCode, started.stderr || started.stdout).toBe(0);
  const restart = run(["restart", "--json"]);
  const release = Bun.file(join(root, "release-start"));
  let stop: ReturnType<typeof run> | undefined;
  try {
    await waitForCondition(
      () => Bun.file(join(root, "compose-created")).exists(),
      "Restart did not reach the create phase"
    );
    stop = run([
      "down",
      "--service",
      "app",
      "--target",
      "local",
      "--expect-compose-project",
      "sample",
      "--json",
    ]);
    const premature = await Promise.race([
      Bun.sleep(1800).then(() => false),
      stop.then(() => true),
    ]);
    expect(premature).toBe(false);
    await Bun.write(release, "release");
    const restarted = await restart;
    expect(restarted.exitCode, restarted.stderr || restarted.stdout).toBe(0);
    const stopped = await stop;
    expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({
      ok: true,
      data: { services: { stopped: ["app"] } },
    });
    expect(await Bun.file(join(root, "compose-running")).exists()).toBe(false);
  } finally {
    await Bun.write(release, "release");
    await Promise.allSettled([restart, stop]);
  }
}, 40_000);

for (const command of ["down", "restart"]) {
  test(`${command} keeps the service's worktree copy after waiting for its lock`, async () => {
    const { git, worktree } = await createLinkedCheckout();
    await writeOwnedFixture(
      join(worktree, ".hack", "hack.config.json"),
      '{"name":"sample","dev_host":"sample.hack"}'
    );
    const shim = join(root, "bin", "git");
    const selectedPath = join(root, "branch-selected");
    const selected = Bun.file(selectedPath);
    await rm(shim);
    await writeFile(
      shim,
      `#!/bin/sh
if [ "$3 $4" = "branch --show-current" ]; then
  ${quoteShellWord(git)} "$@" || exit $?
  : > ${quoteShellWord(selectedPath)}
  exit 0
fi
exec ${quoteShellWord(git)} "$@"
`,
      { mode: 0o755 }
    );
    await installComposeNameFixture({ startContainers: true });
    await Bun.write(join(root, "compose-running"), "sample--preview");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withAutostartProjectLock({
      registryPath: join(root, "home", ".hack", "projects.json"),
      scope: {
        projectId: "",
        composeProject: `checkout:${await realpath(join(worktree, ".hack"))}\0preview`,
        branch: null,
      },
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await Promise.race([entered.promise, holder]);
    const services = command === "down" ? ["--service", "app"] : ["app"];
    const operation = run(
      [
        command,
        ...services,
        "--target",
        "local",
        "--expect-compose-project",
        "sample--preview",
        "--json",
      ],
      false,
      worktree
    );
    try {
      await waitForCondition(
        () => selected.exists(),
        "The command did not select the worktree branch"
      );
      const rename = Bun.spawnSync(
        [git, "-C", worktree, "branch", "-m", "renamed"],
        {
          env: privateCliEnv({ root, home: join(root, "home") }),
        }
      );
      expect(rename.exitCode).toBe(0);
      release.resolve();
      const result = await operation;
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: { composeProject: "sample--preview", branch: "preview" },
      });
    } finally {
      release.resolve();
      await Promise.allSettled([holder, operation]);
    }
  }, 40_000);
}

test("desktop Start can stop a sibling branch from an attached lifecycle hook", async () => {
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const configPath = join(projectDir, "hack.config.json");
  const config = { name: "sample", dev_host: "sample.hack" };
  await writeOwnedFixture(configPath, JSON.stringify(config));
  await writeOwnedFixture(
    join(projectDir, "docker-compose.yml"),
    "name: sample\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  await installComposeNameFixture({ startContainers: true });
  const env = { PATH: `${join(root, "bin")}:/usr/bin:/bin` };
  const preview = await run(
    ["up", "-d", "--branch", "preview", "--json"],
    false,
    projectRoot,
    env
  );
  expect(preview.exitCode, preview.stderr || preview.stdout).toBe(0);

  const hook = join(root, "stop-preview.ts");
  await writeOwnedFixture(
    hook,
    `
const child = Bun.spawn([process.execPath, ${JSON.stringify(cli)}, "--no-interactive", "down", "--target", "local", "--branch", "preview", "--json"], {
  timeout: 8000, stdin: "ignore", stdout: "inherit", stderr: "inherit",
});
process.exit(await child.exited);
`
  );
  await writeOwnedFixture(
    configPath,
    JSON.stringify({
      ...config,
      lifecycle: {
        up: {
          before: [
            {
              name: "stop-preview",
              command: [process.execPath, hook].map(quoteShellWord).join(" "),
            },
          ],
        },
      },
    })
  );
  const start = await run(
    [
      "up",
      "-d",
      "--target",
      "local",
      "--expect-compose-project",
      "sample",
      "--json",
    ],
    false,
    projectRoot,
    env
  );
  expect(start.exitCode, start.stderr || start.stdout).toBe(0);
  expect(
    (await Bun.file(join(root, "compose-down")).json()).slice(0, 3)
  ).toEqual(["compose", "-p", "sample--preview"]);
  expect(
    (await readProjectRuntimeState({ projectDir })).map(
      (entry) => entry.composeProject
    )
  ).toEqual(["sample"]);
  expect(await Bun.file(join(root, "compose-running")).text()).toBe("sample");
}, 30_000);

test("parallel sibling writes keep each copy's runtime pin and overlay", async () => {
  const projectDir = join(root, "project", ".hack");
  const entries = Array.from({ length: 8 }, (_, index) => ({
    composeProject: `sample--copy-${index}`,
    envName: `overlay-${index}`,
    pinnedComposeBase: "sample",
    updatedAt: "2026-11-23T00:00:00.000Z",
  }));
  await Promise.all(
    entries.map((entry) =>
      upsertProjectRuntimeStateEntry({ projectDir, entry })
    )
  );
  expect(await readProjectRuntimeState({ projectDir })).toEqual(entries);
});

test("ordinary Down waits for desktop Start to publish its pin before selecting the stack", async () => {
  const projectDir = join(root, "project", ".hack");
  await configureManagedNameOverlay({ defaultOverlay: true });
  await writeRegistry(false);
  await installComposeNameFixture({
    startContainers: true,
    holdBeforePin: true,
  });
  const start = run([
    "up",
    "-d",
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ]);
  const release = Bun.file(join(root, "release-start"));
  let down: ReturnType<typeof run> | undefined;
  try {
    await waitForCondition(
      () => Bun.file(join(root, "before-pin")).exists(),
      "Start did not reach the ownership preflight"
    );
    expect(
      await readProjectRuntimeStateEntry({
        projectDir,
        composeProject: "sample",
      })
    ).toBeNull();
    down = run(["down", "--json"]);
    await waitForCondition(
      async () => (await marker()).paused,
      "Down did not publish pause before waiting"
    );
    await Promise.race([Bun.sleep(250), down]);
    expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
    await Bun.write(release, "release");
    const started = await start;
    expect(started.exitCode, started.stderr || started.stdout).toBe(0);
    const stopped = await down;
    expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
    expect(
      (await Bun.file(join(root, "compose-down")).json()).slice(0, 3)
    ).toEqual(["compose", "-p", "sample"]);
    expect(await Bun.file(join(root, "compose-running")).exists()).toBe(false);
  } finally {
    await Bun.write(release, "release");
    await Promise.allSettled([start, down]);
  }
}, 40_000);

test("ordinary Down publishes pause before reading an invalid managed overlay", async () => {
  await configureManagedNameOverlay({ defaultOverlay: true });
  await writeOwnedFixture(
    join(root, "project", ".hack", "hack.env.qa.yaml"),
    "invalid: [\n"
  );
  await writeRegistry(false);
  await installComposeNameFixture();
  const stopped = await run(["down", "--json"]);
  expect(stopped.exitCode).toBe(1);
  expect(stopped.stderr || stopped.stdout).toContain("Failed to parse");
  expect((await marker()).paused).toBe(true);
  expect(await Bun.file(join(root, "compose-down")).exists()).toBe(false);
});

test("bound service Shell, Logs, Restart and Stop use the legacy stack's saved Docker context", async () => {
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  await writeOwnedFixture(
    join(projectDir, "hack.config.json"),
    '{"name":"sample","dev_host":"sample.hack"}'
  );
  await writeInterpolatedStack(projectRoot, "STACK_A");
  await installComposeNameFixture({
    startContainers: true,
    savedContextOnly: true,
  });
  await writeOwnedFixture(
    join(projectDir, "hack.env.qa.yaml"),
    "version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global:\n    DOCKER_CONTEXT: saved-files-context\n"
  );
  const started = await run(["up", "-d", "--env", "qa", "--json"]);
  expect(started.exitCode, started.stderr || started.stdout).toBe(0);
  await storeLegacyInterpolatedOverlay(projectDir);
  const shell = await run([
    "exec",
    "--expect-compose-project",
    "sample",
    "app",
    "--",
    "sh",
  ]);
  expect(shell.exitCode, shell.stderr || shell.stdout).toBe(0);
  expect(shell.stdout).toContain("shell-ready");
  const logs = await run([
    "logs",
    "--expect-compose-project",
    "sample",
    "--no-follow",
    "app",
  ]);
  expect(logs.exitCode, logs.stderr || logs.stdout).toBe(0);
  expect(logs.stdout).toContain("saved-overlay-log");
  const bound = [
    "--target",
    "local",
    "--expect-compose-project",
    "sample",
    "--json",
  ];
  const restarted = await run(["restart", "app", ...bound]);
  expect(restarted.exitCode, restarted.stderr || restarted.stdout).toBe(0);
  expect(await Bun.file(join(root, "restart-context")).text()).toBe(
    "saved-files-context"
  );
  const stopped = await run(["down", "--service", "app", ...bound]);
  expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
  expect(await Bun.file(join(root, "stop-context")).text()).toBe(
    "saved-files-context"
  );
}, 40_000);

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
test("Exec and Restart use the configured secret namespace of an overridden Compose stack", async () => {
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  await writeOwnedFixture(
    join(projectDir, "hack.config.json"),
    '{"name":"sample","dev_host":"sample.hack"}'
  );
  await writeOwnedFixture(
    join(projectDir, "docker-compose.yml"),
    "name: demo_team\nservices:\n  app:\n    image: example.invalid/app\n"
  );
  await writeOwnedFixture(
    join(projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [{ key: "DOCKER_CONTEXT", source: "keychain", required: true }],
    })
  );
  const trace = join(root, "secret-namespace");
  const preload = join(root, "fake-keychain.ts");
  await writeOwnedFixture(
    preload,
    `
import { appendFile } from "node:fs/promises";
import { keychain } from ${JSON.stringify(resolve("src/lib/keychain.ts"))};
keychain.get = async ({ service }) => {
  await appendFile(${JSON.stringify(trace)}, service + "\\n");
  return service === "hack-demo-team" ? "saved-files-context" : null;
};
keychain.set = keychain.delete = async () => { throw new Error("Unexpected fixture keychain mutation"); };
`
  );
  await installComposeNameFixture({
    startContainers: true,
    savedContextOnly: true,
    shellStack: "alternate",
  });
  const env = {
    COMPOSE_PROJECT_NAME: "alternate",
    HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "0",
  };
  for (const command of [
    ["up", "-d", "--json"],
    ["exec", "app", "--", "sh"],
    ["restart", "--json"],
    ["down", "--json"],
  ]) {
    await Bun.write(trace, "");
    const result = await run(command, false, project, env, preload);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(new Set((await Bun.file(trace).text()).trim().split("\n"))).toEqual(
      new Set(["hack-demo-team"])
    );
  }
}, 40_000);

test.skipIf(!supervisorBinary)(
  "Start verifies a live legacy lifecycle owner before starting the upgraded copy",
  async () => {
    const project = join(root, "project");
    const projectDir = join(project, ".hack");
    const processDefinition = {
      name: "sleeper",
      command: "exec /bin/sleep 120",
    };
    await writeOwnedFixture(
      join(projectDir, "hack.config.json"),
      JSON.stringify({
        name: "sample",
        dev_host: "sample.hack",
        lifecycle: { runner: "supervisor", processes: [processDefinition] },
      })
    );
    await writeInterpolatedStack(project, "STACK_A");
    await installComposeNameFixture({ startContainers: true });
    const legacyKey = sanitizeProjectSlug("${STACK_A:-sample}");
    const seed = join(root, "seed-legacy-owner.ts");
    await writeOwnedFixture(
      seed,
      `
import { createLifecycleProcessController } from ${JSON.stringify(resolve("src/lib/project-lifecycle-controller.ts"))};
const starter = createLifecycleProcessController({
  runner: "supervisor",
  project: { projectRoot: ${JSON.stringify(project)}, projectDir: ${JSON.stringify(projectDir)} },
  projectName: ${JSON.stringify(legacyKey)}, branch: null, composeProject: ${JSON.stringify(legacyKey)},
  env: {}, definitionHash: "legacy-fixture", mux: () => Promise.reject(new Error("Unexpected mux")),
});
await starter.startMany({ processes: [${JSON.stringify(processDefinition)}] });
await starter.finalize();
`
    );
    const env = {
      HACK_LIFECYCLE_SUPERVISOR_BINARY: supervisorBinary ?? "",
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    };
    const seeded = Bun.spawn([process.execPath, seed], {
      cwd: project,
      env: privateCliEnv({ root, home: join(root, "home"), env }),
      stdout: "ignore",
      stderr: "pipe",
    });
    const seedError = await new Response(seeded.stderr).text();
    try {
      expect(await seeded.exited, seedError).toBe(0);
      await upsertProjectRuntimeStateEntry({
        projectDir,
        entry: {
          composeProject: legacyKey,
          envName: null,
          updatedAt: new Date().toISOString(),
        },
      });
      const [previous] = await readLifecycleState({ projectDir });
      const oldPid = previous?.processes[0]?.processGroupId ?? 0;
      expect(oldPid).toBeGreaterThan(1);
      expect(() => process.kill(-oldPid, 0)).not.toThrow();
      const start = await run(["up", "-d", "--json"], false, project, env);
      expect(start.exitCode, start.stdout + start.stderr).toBe(0);
      const owners = await readLifecycleState({ projectDir });
      expect(owners).toHaveLength(1);
      const nextPid = owners[0]?.processes[0]?.processGroupId ?? 0;
      expect(nextPid).toBeGreaterThan(1);
      expect(() => process.kill(-nextPid, 0)).not.toThrow();
      if (nextPid !== oldPid) {
        expect(() => process.kill(-oldPid, 0)).toThrow();
      }
      const down = await run(["down", "--json"], false, project, env);
      expect(down.exitCode, down.stdout + down.stderr).toBe(0);
      expect(() => process.kill(-nextPid, 0)).toThrow();
      expect(await readLifecycleState({ projectDir })).toHaveLength(0);
    } finally {
      await run(["down", "--json"], false, project, env);
    }
  },
  40_000
);

test.skipIf(!supervisorBinary)(
  "plain Down finds the name and overlay supplied only at ordinary Start",
  async () => {
    const project = join(root, "project");
    const projectDir = join(project, ".hack");
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
    await writeOwnedFixture(
      join(projectDir, "docker-compose.yml"),
      "name: demo_team\nservices:\n  app:\n    image: example.invalid/app\n"
    );
    await writeOwnedFixture(
      join(projectDir, "hack.env.qa.yaml"),
      "version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global:\n    COMPOSE_PROJECT_NAME: alternate\n    DOCKER_CONTEXT: saved-files-context\n"
    );
    await installComposeNameFixture({
      startContainers: true,
      savedContextOnly: true,
      defaultStack: "demo_team",
      foreignCheckout: join(root, "foreign", ".hack"),
      foreignStack: "demo_team",
      foreignContext: "none",
    });
    const env = {
      HACK_LIFECYCLE_SUPERVISOR_BINARY: supervisorBinary ?? "",
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    };
    try {
      const started = await run(
        ["up", "-d", "--env", "qa", "--json"],
        false,
        project,
        env
      );
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      expect(
        await readProjectRuntimeStateEntry({
          projectDir,
          composeProject: "alternate",
        })
      ).toMatchObject({
        launchComposeBase: "alternate",
        launchBranch: null,
        envProjectName: "demo-team",
        envName: "qa",
      });
      const [state] = await readLifecycleState({ projectDir });
      expect(state).toMatchObject({ composeProject: "alternate" });
      const pid = state?.processes[0]?.processGroupId ?? 0;
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(-pid, 0)).not.toThrow();
      const stopped = await run(["down", "--json"], false, project, env);
      expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
      expect(
        (await Bun.file(join(root, "compose-down")).json()).slice(0, 3)
      ).toEqual(["compose", "-p", "alternate"]);
      expect(await Bun.file(join(root, "down-context")).text()).toBe(
        "saved-files-context"
      );
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      await run(["down", "--json"], false, project, env);
    }
  },
  30_000
);

for (const { desktopStarts, action, description } of [
  {
    desktopStarts: true,
    action: "down",
    description:
      "ordinary Down stops the host process launched by desktop Start",
  },
  {
    desktopStarts: false,
    action: "down",
    description:
      "desktop Stop retires the host process launched by ordinary Start",
  },
  {
    desktopStarts: false,
    action: "restart",
    description:
      "desktop Restart replaces the host process launched by ordinary Start",
  },
]) {
  test.skipIf(!supervisorBinary)(
    description,
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
          composeProject: "sample",
        });
        const pid = state[0]?.processes[0]?.processGroupId ?? 0;
        expect(pid).toBeGreaterThan(1);
        expect(() => process.kill(-pid, 0)).not.toThrow();
        const stopped = await run(
          [action, ...(desktopStarts ? ["--json"] : bound)],
          false,
          projectRoot,
          env
        );
        expect(stopped.exitCode, stopped.stderr || stopped.stdout).toBe(0);
        expect(() => process.kill(-pid, 0)).toThrow();
        expect(await readLifecycleState({ projectDir })).toHaveLength(
          action === "restart" ? 1 : 0
        );
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

async function createLinkedCheckout() {
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
  return { git, worktree };
}

test("linked worktree opt-in refuses without marking the primary checkout", async () => {
  const { worktree } = await createLinkedCheckout();
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
