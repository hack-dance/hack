import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RuntimeFixture = {
  readonly composeProject: string;
  readonly id: string;
  readonly mounts?: readonly {
    readonly destination: string;
    readonly source: string;
    readonly type: string;
  }[];
  readonly state: string;
  readonly workingDir: string;
};

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalLogger: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-down-worktree-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalLogger = process.env.HACK_LOGGER;
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  restoreEnv("HOME", originalHome);
  restoreEnv("PATH", originalPath);
  restoreEnv("HACK_LOGGER", originalLogger);
});

test("down retargets the unique stopped runtime owned before a worktree branch rename", async () => {
  const fixture = await createWorktreeFixture();
  runGit({
    cwd: fixture.worktreeRoot,
    args: ["branch", "-m", "codex/old-branch"],
  });
  await writeRuntimeFixtures({
    fixture,
    runtime: [
      {
        composeProject: "downsafe--old-branch",
        id: "old-runtime",
        state: "exited",
        workingDir: join(fixture.worktreeRoot, ".hack"),
      },
    ],
  });

  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: {
      branch: "old-branch",
      composeProject: "downsafe--old-branch",
    },
  });
  expect(result.stderr).toContain("Targeting the owned runtime");
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("-p downsafe--old-branch");
  expect(log).not.toContain("-p downsafe--codex-old-branch");
});

test("down refuses multiple same-checkout runtimes unless --branch is explicit", async () => {
  const fixture = await createWorktreeFixture();
  await writeRuntimeFixtures({
    fixture,
    runtime: [
      {
        composeProject: "downsafe--old-branch",
        id: "old-runtime",
        state: "exited",
        workingDir: join(fixture.worktreeRoot, ".hack"),
      },
      {
        composeProject: "downsafe--feature-current",
        id: "current-runtime",
        state: "running",
        workingDir: join(fixture.worktreeRoot, ".hack"),
      },
    ],
  });

  const ambiguous = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--json",
  ]);

  expect(ambiguous.exitCode).toBe(1);
  expect(JSON.parse(ambiguous.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_USAGE" },
  });
  expect(ambiguous.stderr).toContain("branch instance");
  let log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log.split("\n").some((line) => line.endsWith(" down"))).toBe(false);

  const explicit = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "old-branch",
    "--json",
  ]);

  expect(explicit.exitCode).toBe(0);
  expect(JSON.parse(explicit.stdout)).toMatchObject({
    ok: true,
    data: {
      branch: "old-branch",
      composeProject: "downsafe--old-branch",
    },
  });
  log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("-p downsafe--old-branch");
});

test("down with zero owned runtimes keeps the current branch target", async () => {
  const fixture = await createWorktreeFixture();
  await writeRuntimeFixtures({
    fixture,
    runtime: [
      {
        composeProject: "downsafe--other",
        id: "other-runtime",
        state: "running",
        workingDir: join(fixture.primaryRoot, ".hack"),
      },
    ],
  });

  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: {
      branch: "feature-current",
      composeProject: "downsafe--feature-current",
    },
  });
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("-p downsafe--feature-current");
  expect(log).not.toContain("-p downsafe--other");
});

test("primary checkout down remains on the base Compose project", async () => {
  const fixture = await createWorktreeFixture();
  await writeRuntimeFixtures({ fixture, runtime: [] });

  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.primaryRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { branch: null, composeProject: "downsafe" },
  });
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log.split("\n").some((line) => line.endsWith(" down"))).toBe(true);
  expect(log).not.toContain(" -p ");
});

test("implicit worktree Down keeps the observed base name across lock handoff", async () => {
  const fixture = await createWorktreeFixture();
  const projectDir = join(fixture.worktreeRoot, ".hack");
  await writeFile(join(projectDir, ".env"), "COMPOSE_PROJECT_NAME=alternate\n");
  await writeRuntimeFixtures({
    fixture,
    runtime: [
      {
        composeProject: "downsafe",
        id: "base-runtime",
        state: "running",
        workingDir: projectDir,
      },
    ],
  });
  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--json",
  ]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { branch: null, composeProject: "downsafe" },
  });
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toMatch(/compose -p downsafe .* down\n/);
  expect(log).not.toContain("-p alternate");
});

test("down --service stops only the named service in its own branch checkout", async () => {
  const fixture = await createWorktreeFixture();
  const ownDir = join(fixture.worktreeRoot, ".hack");
  const row = (
    ID: string,
    Service: string,
    workingDir = ownDir,
    oneOff = false
  ) => ({
    ID,
    Service,
    State: "running",
    Labels: `com.docker.compose.project.working_dir=${workingDir},com.docker.compose.oneoff=${oneOff}`,
  });
  const entries = [
    row("api-one", "api"),
    row("api-two", "api"),
    row("other", "db"),
    row("oneoff", "api", ownDir, true),
  ];
  await writeFile(fixture.dockerComposeRowsPath, JSON.stringify(entries));
  const args = [
    "down",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--service",
    "api",
    "--json",
  ];
  const first = await runCliWithCapturedOutput(args);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    ok: true,
    data: {
      branch: "feature-current",
      composeProject: "downsafe--feature-current",
      services: { stopped: ["api"] },
      stoppedContainerIds: ["api-one", "api-two"],
      stoppedAt: expect.any(String),
    },
  });
  await writeFile(
    fixture.dockerComposeRowsPath,
    JSON.stringify([
      ...entries,
      row("foreign", "api", join(fixture.primaryRoot, ".hack")),
    ])
  );
  const foreign = await runCliWithCapturedOutput(args);
  expect(foreign.exitCode).toBe(1);
  expect(JSON.parse(foreign.stdout)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("do not all belong to this checkout"),
    },
  });
  const restart = await runCliWithCapturedOutput([
    "restart",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--target",
    "local",
    "--json",
    "api",
  ]);
  expect(restart.exitCode).toBe(1);
  expect(JSON.parse(restart.stdout)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("Cannot restart api"),
    },
  });
  const start = await runCliWithCapturedOutput([
    "up",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--target",
    "local",
    "--expect-compose-project",
    "downsafe--feature-current",
    "--detach",
    "--json",
  ]);
  expect(start.exitCode).toBe(1);
  expect(JSON.parse(start.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Cannot start this copy") },
  });
  const stale = await runCliWithCapturedOutput([
    ...args,
    "--target",
    "local",
    "--expect-compose-project",
    "oldname--feature-current",
  ]);
  expect(stale.exitCode).toBe(1);
  expect(JSON.parse(stale.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("Compose project changed") },
  });
  const empty = await runCliWithCapturedOutput([
    ...args,
    "--target",
    "local",
    "--expect-compose-project=",
  ]);
  expect(empty.exitCode).toBe(1);
  expect(JSON.parse(empty.stdout)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("nonempty name") },
  });
  const readTarget = [
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--expect-compose-project",
    "oldname--feature-current",
  ];
  const logs = await runCliWithCapturedOutput([
    "logs",
    ...readTarget,
    "--json",
    "--no-follow",
    "api",
  ]);
  expect(logs.exitCode).toBe(1);
  expect(JSON.parse(logs.stdout)).toMatchObject({
    error: { message: expect.stringContaining("Compose project changed") },
  });
  const shell = await runCliWithCapturedOutput([
    "exec",
    ...readTarget,
    "api",
    "--",
    "sh",
  ]);
  expect(shell.exitCode).toBe(1);
  expect(shell.stderr).toContain("Compose project changed");
  const detached = await runCliWithCapturedOutput([
    "exec",
    ...readTarget,
    "--detach",
    "api",
    "--",
    "sh",
  ]);
  expect(detached.exitCode).toBe(1);
  expect(detached.stderr).toContain("requires foreground Compose exec");
  const commands = (await readFile(fixture.dockerLogPath, "utf8"))
    .trim()
    .split("\n");
  expect(commands.filter((command) => command.startsWith("stop "))).toEqual([
    "stop -- api-one api-two",
  ]);
  expect(
    commands.some((command) => command.includes("ps --all --no-trunc"))
  ).toBe(true);
  expect(commands.some((command) => command.endsWith(" down"))).toBe(false);
  expect(commands.some((command) => command.includes("--force-recreate"))).toBe(
    false
  );
}, 30_000);

test("desktop Start pins the resolved name of a never-started Compose copy", async () => {
  const fixture = await createWorktreeFixture();
  await writeFile(
    join(fixture.worktreeRoot, ".hack", "docker-compose.yml"),
    'name: "${HACK_TEST_STACK_NAME:-demo}"\nservices:\n  api:\n    image: alpine:3.20\n'
  );
  await writeFile(
    join(fixture.worktreeRoot, ".hack", "hack.config.json"),
    JSON.stringify({
      name: "downsafe",
      dev_host: "downsafe.hack",
      compose: { startupTimeoutMs: 2500 },
    })
  );
  await writeFile(fixture.dockerComposeRowsPath, "[]");
  const result = await runCliWithCapturedOutput([
    "up",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--target",
    "local",
    "--expect-compose-project",
    "demo--feature-current",
    "--detach",
    "--json",
  ]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toMatch(/compose -p demo--feature-current .* up /);
  expect(log).not.toContain("HACK_TEST_STACK_NAME");
}, 20_000);

test("service Stop reports confirmed replicas on failure and uses the Compose working directory", async () => {
  const fixture = await createWorktreeFixture();
  const projectDir = join(fixture.worktreeRoot, ".hack");
  const dockerConfig = join(projectDir, "relative-docker-config");
  await mkdir(dockerConfig);
  await writeFile(
    join(dockerConfig, "config.json"),
    '{"currentContext":"fixture-scoped-stop"}\n'
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    DOCKER_CONFIG: relative-docker-config",
      "    PATH: /fixture/project-provided-path",
      "    LD_PRELOAD: fixture-loader-value",
      "    NODE_OPTIONS: fixture-interpreter-value",
      "",
    ].join("\n")
  );
  await writeFile(
    fixture.dockerComposeRowsPath,
    JSON.stringify(
      ["api-one", "api-two"].map((ID) => ({
        ID,
        Service: "api",
        State: "running",
        Labels: `com.docker.compose.project.working_dir=${projectDir}`,
      }))
    )
  );
  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--service",
    "api",
    "--json",
  ]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_COMPOSE_FAILED",
      message: "Could not stop api (Docker exit 1).",
      detail: {
        stoppedContainerIds: ["api-one"],
        stoppedContainers: [
          { id: "api-one", startedAt: "2026-11-23T00:00:00.000000111Z" },
        ],
        stoppedAt: expect.any(String),
      },
    },
  });
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("stop -- api-one api-two");
  expect(log).not.toMatch(/ down(?:\s|$)/);
}, 20_000);

test("detached linked worktree down still requires an explicit branch", async () => {
  const fixture = await createWorktreeFixture();
  runGit({ cwd: fixture.worktreeRoot, args: ["checkout", "--detach"] });
  await writeRuntimeFixtures({ fixture, runtime: [] });

  const result = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_USAGE",
      message: expect.stringContaining("Detached linked worktree"),
    },
  });
  const log = await readFile(fixture.dockerLogPath, "utf8").catch(() => "");
  expect(log.split("\n").some((line) => line.endsWith(" down"))).toBe(false);
});

test("cache pruning is confirmation-gated and never selects application data mounts", async () => {
  const fixture = await createWorktreeFixture();
  await writeRuntimeFixtures({
    fixture,
    runtime: [
      {
        composeProject: "downsafe--feature-current",
        id: "current-runtime",
        state: "exited",
        workingDir: join(fixture.worktreeRoot, ".hack"),
        mounts: [
          {
            type: "volume",
            source: "owned-next",
            destination: "/app/apps/web/.next",
          },
          {
            type: "volume",
            source: "owned-turbo",
            destination: "/app/.turbo",
          },
          {
            type: "volume",
            source: "database-data",
            destination: "/var/lib/postgresql/data",
          },
        ],
      },
    ],
  });

  const unconfirmed = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--prune-caches",
    "--json",
  ]);
  expect(unconfirmed.exitCode).toBe(1);
  expect(JSON.parse(unconfirmed.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_INTERACTIVE_REQUIRED",
      detail: { volumes: ["owned-next", "owned-turbo"] },
    },
  });
  let log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log.split("\n").some((line) => line.endsWith(" down"))).toBe(false);
  expect(log).not.toContain("volume rm");

  const confirmed = await runCliWithCapturedOutput([
    "down",
    "--path",
    fixture.worktreeRoot,
    "--prune-caches",
    "--yes",
    "--json",
  ]);
  expect(confirmed.exitCode).toBe(0);
  expect(JSON.parse(confirmed.stdout)).toMatchObject({
    ok: true,
    data: { cacheVolumesRemoved: ["owned-next", "owned-turbo"] },
  });
  log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("volume rm owned-next");
  expect(log).toContain("volume rm owned-turbo");
  expect(log).not.toContain("volume rm database-data");
});

async function detachedCacheFixture() {
  const fixture = await createWorktreeFixture();
  const project = "downsafe--feature-current";
  const down = [
    "down",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "feature-current",
    "--json",
  ];
  const runtime = (
    destination: string,
    root = fixture.worktreeRoot,
    composeProject = project
  ): RuntimeFixture => ({
    composeProject,
    id: "fixture-runtime",
    state: "running",
    workingDir: join(root, ".hack"),
    mounts: [{ type: "volume", source: "owned-next", destination }],
  });
  const set = (...rows: RuntimeFixture[]) =>
    writeRuntimeFixtures({ fixture, runtime: rows });
  const prune = () =>
    runCliWithCapturedOutput([...down, "--prune-caches", "--yes"]);
  await writeFile(join(fixture.primaryRoot, "inventory"), "owned-next\n");
  return { fixture, project, down, runtime, set, prune };
}

test("only the volume's own disposable label qualifies after plain down", async () => {
  const { fixture, down, runtime, set, prune } = await detachedCacheFixture();
  await writeFile(
    join(fixture.primaryRoot, "inventory"),
    "owned-next\nowned-turbo\nowned-next-foreign\n"
  );
  await set(runtime("/app/.next"));
  expect((await runCliWithCapturedOutput(down)).exitCode).toBe(0);
  expect(await readFile(fixture.dockerLogPath, "utf8")).not.toMatch(
    /^(volume |info )/m
  );
  await set(runtime("/app/.next", fixture.worktreeRoot, "downsafe--other"));
  const first = await prune();
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(first.stdout).data).toMatchObject({
    cacheVolumesRemoved: ["owned-turbo"],
    cacheVolumesKept: [
      { name: "owned-next", reason: "mounted-elsewhere" },
      { name: "owned-next-foreign", reason: "ownership-unverified" },
    ],
  });
  await set();
  const again = await prune();
  expect(again.exitCode).toBe(0);
  expect(again.stderr).toContain(
    "Kept volumes without current mounts: owned-next."
  );
  expect(again.stderr).toContain("down --prune-caches before stopping");
  expect(again.stderr).toContain("add hack.cache.disposable=true");
  expect(JSON.parse(again.stdout).data).toMatchObject({
    cacheVolumesRemoved: [],
    cacheVolumesKept: [
      { name: "owned-next", reason: "no-live-mount" },
      { name: "owned-next-foreign", reason: "ownership-unverified" },
    ],
  });
  expect(
    (await readFile(fixture.dockerLogPath, "utf8")).match(/^volume rm .*$/gm)
  ).toEqual(["volume rm owned-turbo"]);
});

test.each([
  "remounted as data",
  "Docker info failure",
  "volume inspect failure",
  "another checkout",
  "failed restart up",
  "untrusted old receipt",
])("past cache mount gives no removal authority after %s", async (scenario) => {
  const { fixture, project, down, runtime, set, prune } =
    await detachedCacheFixture();
  await set(runtime("/app/.next"));
  expect((await runCliWithCapturedOutput(down)).exitCode).toBe(0);
  const alternateRoot =
    scenario === "another checkout"
      ? fixture.primaryRoot
      : fixture.worktreeRoot;
  await set(runtime("/data", alternateRoot));
  if (scenario === "remounted as data" || scenario === "another checkout") {
    const live = await prune();
    expect(live.exitCode).toBe(0);
    expect(JSON.parse(live.stdout).data.cacheVolumesKept).toEqual([
      {
        name: "owned-next",
        reason:
          scenario === "another checkout"
            ? "mounted-elsewhere"
            : "not-disposable",
      },
    ]);
  } else if (scenario === "failed restart up") {
    await writeFile(join(fixture.primaryRoot, "fail-up"), "");
    const restart = await runCliWithCapturedOutput([
      "restart",
      ...down.slice(1),
    ]);
    expect(restart.exitCode).not.toBe(0);
    expect(await readFile(fixture.dockerLogPath, "utf8")).toMatch(
      /^compose .* up /m
    );
  } else if (scenario === "untrusted old receipt") {
    const directory = join(
      process.env.HOME ?? "",
      ".hack",
      "compose-cache-receipts"
    );
    await mkdir(directory, { recursive: true });
    const key = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(["fixture-engine", project]))
      .digest("hex");
    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({
        checkout: join(fixture.worktreeRoot, ".hack"),
        mounts: [
          {
            name: "owned-next",
            destinations: ["/app/.next"],
            services: ["api"],
            fingerprint: "",
          },
        ],
      }),
      { mode: 0o666 }
    );
    await chmod(join(directory, `${key}.json`), 0o666);
  } else {
    const failure = join(
      fixture.primaryRoot,
      scenario === "Docker info failure" ? "fail-info" : "fail-inspect"
    );
    await writeFile(failure, "");
    expect((await runCliWithCapturedOutput(down)).exitCode).toBe(0);
    await rm(failure);
  }
  await set();
  const detached = await prune();
  expect(detached.exitCode).toBe(0);
  expect(JSON.parse(detached.stdout).data).toMatchObject({
    cacheVolumesRemoved: [],
    cacheVolumesKept: [{ name: "owned-next", reason: "no-live-mount" }],
  });
  expect(await readFile(fixture.dockerLogPath, "utf8")).not.toMatch(
    /^volume rm /m
  );
});

test("prune keeps a volume recreated during stop", async () => {
  const { fixture, set, prune, runtime } = await detachedCacheFixture();
  await set({
    ...runtime("/app/.next"),
    mounts: [
      { type: "volume", source: "owned-replaced", destination: "/app/.next" },
    ],
  });
  await writeFile(join(fixture.primaryRoot, "replace-on-down"), "");
  const result = await prune();
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).data).toMatchObject({
    cacheVolumesRemoved: [],
    cacheVolumesKept: [
      { name: "owned-next", reason: "no-live-mount" },
      { name: "owned-replaced", reason: "identity-changed" },
    ],
  });
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log.match(/^volume inspect owned-replaced$/gm)).toHaveLength(2);
  expect(log).not.toMatch(/^volume rm /m);
});

async function createWorktreeFixture(): Promise<{
  readonly dockerComposeRowsPath: string;
  readonly dockerInspectPath: string;
  readonly dockerLogPath: string;
  readonly dockerRowsPath: string;
  readonly primaryRoot: string;
  readonly worktreeRoot: string;
}> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const primaryRoot = join(tempDir, "repo-primary");
  const hackDir = join(primaryRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({ name: "downsafe", dev_host: "downsafe.hack" }, null, 2)}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "name: downsafe",
      "services:",
      "  api:",
      "    image: alpine:3.20",
      "",
    ].join("\n")
  );
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
    args: ["worktree", "add", "-b", "feature/current", worktreeRoot],
  });

  const binDir = join(tempDir, "bin");
  const dockerRowsPath = join(tempDir, "docker-rows.jsonl");
  const dockerComposeRowsPath = join(tempDir, "compose-rows.json");
  const dockerInspectPath = join(tempDir, "docker-inspect.json");
  const dockerLogPath = join(tempDir, "docker.log");
  await mkdir(binDir, { recursive: true });
  await writeFile(dockerRowsPath, "");
  await writeFile(dockerComposeRowsPath, "");
  await writeFile(dockerInspectPath, "[]\n");
  const dockerPath = join(binDir, "docker");
  await writeFile(
    dockerPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${dockerLogPath}"`,
      'if [ "${DOCKER_CONFIG#*/hack-docker-transport-}" != "$DOCKER_CONFIG" ]; then',
      '  grep -q \'"currentContext":"fixture-scoped-stop"\' "$DOCKER_CONFIG/config.json" || exit 29',
      '  [ -z "${LD_PRELOAD:-}${NODE_OPTIONS:-}" ] || exit 30',
      '  [ "$PATH" != /fixture/project-provided-path ] || exit 31',
      '  if [ "$1" = "inspect" ]; then',
      '    printf \'%s\\n\' \'{"Id":"api-one","State":{"Status":"running","StartedAt":"2026-11-23T00:00:00.000000111Z"}}\' \'{"Id":"api-two","State":{"Status":"running","StartedAt":"2026-11-23T00:00:00.000000222Z"}}\'',
      "    exit 0",
      "  fi",
      '  if [ "$1" = "stop" ]; then',
      '    printf "%s\\n" "api-one" "unrelated"',
      '    printf "%s\\n" "fixture could not stop api-two" >&2',
      "    exit 1",
      "  fi",
      "fi",
      'if [ "$1" = "ps" ]; then',
      `  case " $* " in *"com.docker.compose.project.working_dir"*) cat "${dockerComposeRowsPath}"; exit 0;; esac`,
      `  cat "${dockerRowsPath}"`,
      "  exit 0",
      "fi",
      'if [ "$1" = compose ] && [ -f .env ] && [ "$(cat .env)" = COMPOSE_PROJECT_NAME=alternate ]; then case " $* " in *" -f - config --format json "*) cat >/dev/null; echo \'{"name":"alternate"}\'; exit 0;; esac; fi',
      'if [ "$1" = compose ]; then case " $* " in *" -f - config --format json "*) grep -q HACK_TEST_STACK_NAME || exit 1; echo \'{"name":"demo","services":{"probe":{"labels":{"hack.compose.configured-name":"demo"}}}}\'; exit 0;; esac; fi',
      `if [ "$1" = compose ]; then case " $* " in *" -p demo--feature-current "*" up -d "*) printf '[{"ID":"api-created","Service":"api","State":"running","Labels":"com.docker.compose.project.working_dir=%s"}]\\n' "$PWD" > "${dockerComposeRowsPath}";; esac; fi`,
      `if [ "$1" = compose ] && [ -s "${dockerComposeRowsPath}" ]; then case " $* " in *" ps "*) cat "${dockerComposeRowsPath}"; exit 0;; esac; fi`,
      'if [ "$1" = "inspect" ]; then',
      `  cat "${dockerInspectPath}"`,
      "  exit 0",
      "fi",
      `if [ "$1" = info ]; then [ ! -e "${primaryRoot}/fail-info" ] || exit 1; echo fixture-engine; exit 0; fi`,
      'if [ "$1 $2" = "volume ls" ]; then',
      `  if [ -e "${primaryRoot}/inventory" ]; then while read -r name; do [ -e "${tempDir}/removed-$name" ] || printf '%s\\n' "$name"; done < "${primaryRoot}/inventory"; fi`,
      "  exit 0",
      "fi",
      `if [ "$1" = compose ]; then case " $* " in *" down "*) [ ! -e "${primaryRoot}/replace-on-down" ] || touch "${primaryRoot}/changed-volume";; *" up "*) [ ! -e "${primaryRoot}/fail-up" ] || exit 1;; esac; fi`,
      'if [ "$1 $2" = "volume inspect" ]; then',
      `  [ ! -e "${primaryRoot}/fail-inspect" ] || exit 1`,
      `  [ ! -e "${tempDir}/removed-$3" ] || { echo "get $3: no such volume" >&2; exit 1; }`,
      `  created=2026-01-01T00:00:00Z; [ "$3" != owned-replaced ] || [ ! -e "${primaryRoot}/changed-volume" ] || created=2026-01-01T00:00:01Z`,
      '  case "$3" in',
      '    owned-next|owned-replaced|owned-claimed) key=next; project=downsafe--feature-current; extra="" ;;',
      `    owned-turbo) key=turbo; project=downsafe--feature-current; extra=',"hack.cache.disposable":"true"' ;;`,
      '    owned-next-foreign) key=next; project=downsafe--foreign; extra=\',"hack.cache.disposable":"true"\' ;;',
      '    database-data) key=data; project=downsafe--feature-current; extra="" ;;',
      "    *) exit 1 ;;",
      "  esac",
      `  printf '[{"Name":"%s","CreatedAt":"%s","Labels":{"com.docker.compose.project":"%s","com.docker.compose.volume":"%s"%s}}]\\n' "$3" "$created" "$project" "$key" "$extra"`,
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "volume rm" ]; then',
      `  touch "${tempDir}/removed-$3"`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  await chmod(dockerPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;

  return {
    dockerComposeRowsPath,
    dockerInspectPath,
    dockerLogPath,
    dockerRowsPath,
    primaryRoot,
    worktreeRoot,
  };
}

async function writeRuntimeFixtures(opts: {
  readonly fixture: {
    readonly dockerInspectPath: string;
    readonly dockerRowsPath: string;
  };
  readonly runtime: readonly RuntimeFixture[];
}): Promise<void> {
  const rows = opts.runtime.map((runtime) =>
    JSON.stringify({
      ID: runtime.id,
      State: runtime.state,
      Status: runtime.state,
      Names: `${runtime.composeProject}-api-1`,
      Ports: "",
    })
  );
  await writeFile(
    opts.fixture.dockerRowsPath,
    rows.length > 0 ? `${rows.join("\n")}\n` : ""
  );
  await writeFile(
    opts.fixture.dockerInspectPath,
    `${JSON.stringify(
      opts.runtime.map((runtime) => ({
        Id: runtime.id,
        Config: {
          Image: "alpine:3.20",
          Labels: {
            "com.docker.compose.project": runtime.composeProject,
            "com.docker.compose.project.working_dir": runtime.workingDir,
            "com.docker.compose.service": "api",
          },
        },
        Mounts: (runtime.mounts ?? []).map((mount) => ({
          Type: mount.type,
          ...(mount.type === "volume" ? { Name: mount.source } : {}),
          Source:
            mount.type === "volume"
              ? `/var/lib/docker/volumes/${mount.source}/_data`
              : mount.source,
          Destination: mount.destination,
          Mode: "rw",
          RW: true,
        })),
        NetworkSettings: { Networks: {} },
      }))
    )}\n`
  );
}

function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): void {
  const result = Bun.spawnSync(["git", "-C", opts.cwd, ...opts.args], {
    env: fixtureGitEnv(),
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

async function runCliWithCapturedOutput(
  args: readonly string[]
): Promise<CapturedRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
