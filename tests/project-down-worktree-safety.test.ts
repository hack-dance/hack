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

async function createWorktreeFixture(): Promise<{
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
  const dockerInspectPath = join(tempDir, "docker-inspect.json");
  const dockerLogPath = join(tempDir, "docker.log");
  await mkdir(binDir, { recursive: true });
  await writeFile(dockerRowsPath, "");
  await writeFile(dockerInspectPath, "[]\n");
  const dockerPath = join(binDir, "docker");
  await writeFile(
    dockerPath,
    [
      "#!/bin/sh",
      `echo "$@" >> "${dockerLogPath}"`,
      'if [ "$1" = "ps" ]; then',
      `  cat "${dockerRowsPath}"`,
      "  exit 0",
      "fi",
      'if [ "$1" = "inspect" ]; then',
      `  cat "${dockerInspectPath}"`,
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect owned-next" ]; then',
      '  printf \'[{"Name":"owned-next","Labels":{"com.docker.compose.project":"downsafe--feature-current","com.docker.compose.volume":"next"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume inspect owned-turbo" ]; then',
      '  printf \'[{"Name":"owned-turbo","Labels":{"com.docker.compose.project":"downsafe--feature-current","com.docker.compose.volume":"turbo","hack.cache.disposable":"true"}}]\\n\'',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-next" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1 $2 $3" = "volume rm owned-turbo" ]; then',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  await chmod(dockerPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;

  return {
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
