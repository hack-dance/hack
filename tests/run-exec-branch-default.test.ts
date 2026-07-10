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

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalSyncMode: string | undefined;
let originalLogger: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-run-branch-default-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  process.env.HOME = tempDir;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalSyncMode === undefined) {
    Reflect.deleteProperty(process.env, "HACK_SETUP_SYNC_MODE");
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSyncMode;
  }
  if (originalLogger === undefined) {
    Reflect.deleteProperty(process.env, "HACK_LOGGER");
  } else {
    process.env.HACK_LOGGER = originalLogger;
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

/**
 * Create a primary repo with a committed .hack project plus a linked
 * worktree, and put a stub `docker` on PATH that records every invocation.
 */
async function createWorktreeFixture(): Promise<{
  readonly worktreeRoot: string;
  readonly dockerLogPath: string;
}> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }

  const primaryRoot = join(tempDir, "repo-primary");
  const hackDir = join(primaryRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({ name: "runbranch", dev_host: "runbranch.hack" }, null, 2)}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    ["services:", "  api:", "    image: alpine:3.20", ""].join("\n")
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
    args: ["worktree", "add", "-b", "feature/run-default", worktreeRoot],
  });

  const binDir = join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });
  const dockerLogPath = join(tempDir, "docker-invocations.log");
  const stubPath = join(binDir, "docker");
  await writeFile(
    stubPath,
    ["#!/bin/sh", `echo "$@" >> "${dockerLogPath}"`, "exit 0", ""].join("\n")
  );
  await chmod(stubPath, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

  return { worktreeRoot, dockerLogPath };
}

test("hack run in a linked worktree targets the branch compose project by default", async () => {
  const fixture = await createWorktreeFixture();

  const result = await runCliWithCapturedOutput([
    "run",
    "--path",
    fixture.worktreeRoot,
    "api",
    "echo",
    "hi",
  ]);

  expect(result.exitCode).toBe(0);
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("-p runbranch--feature-run-default");
  expect(result.stderr).toContain('branch instance "feature-run-default"');
});

test("hack run honors an explicit --branch over the worktree default", async () => {
  const fixture = await createWorktreeFixture();

  const result = await runCliWithCapturedOutput([
    "run",
    "--path",
    fixture.worktreeRoot,
    "--branch",
    "custom",
    "api",
    "echo",
    "hi",
  ]);

  expect(result.exitCode).toBe(0);
  const log = await readFile(fixture.dockerLogPath, "utf8");
  expect(log).toContain("-p runbranch--custom");
  expect(log).not.toContain("feature-run-default");
});

test("hack exec in a linked worktree targets the branch compose project by default", async () => {
  const fixture = await createWorktreeFixture();

  const result = await runCliWithCapturedOutput([
    "exec",
    "--path",
    fixture.worktreeRoot,
    "api",
    "echo",
    "hi",
  ]);

  // The stub docker reports no running containers, so exec fails its
  // readiness check — the worktree branch resolution (and its stderr notice)
  // is what matters here.
  const log = await readFile(fixture.dockerLogPath, "utf8").catch(() => "");
  const combined = `${log}\n${result.stdout}\n${result.stderr}`;
  expect(combined).toContain('branch instance "feature-run-default"');
});

test("hack run in a detached linked worktree refuses to target the base compose project", async () => {
  const fixture = await createWorktreeFixture();
  runGit({ cwd: fixture.worktreeRoot, args: ["checkout", "--detach"] });

  const result = await runCliWithCapturedOutput([
    "run",
    "--path",
    fixture.worktreeRoot,
    "api",
    "echo",
    "hi",
  ]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Detached linked worktree");
  expect(result.stderr).toContain("--branch <name>");
  expect(await Bun.file(fixture.dockerLogPath).exists()).toBe(false);
});

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
