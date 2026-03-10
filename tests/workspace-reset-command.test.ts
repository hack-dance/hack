import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type CliRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalLogger = process.env.HACK_LOGGER;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;

const { runCli } = await import("../src/cli/run.ts");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-workspace-reset-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = resolve(tempDir, "hack.config.json");
  process.env.HACK_LOGGER = "console";
  process.env.HACK_SETUP_SYNC_MODE = "off";
  await writeFile(process.env.HACK_GLOBAL_CONFIG_PATH, "{}\n");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }
});

test("workspace reset restores tracked files, removes untracked files, preserves excludes, and recovers index.lock", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  const repoRoot = resolve(tempDir, "repo");
  await createMinimalHackRepo({ repoRoot });

  await writeFile(resolve(repoRoot, "tracked.txt"), "dirty change\n");
  await writeFile(resolve(repoRoot, "scratch.txt"), "delete me\n");
  await writeFile(resolve(repoRoot, ".env"), "KEEP_ME=yes\n");
  await writeFile(resolve(repoRoot, ".git", "index.lock"), "stale lock\n");

  const result = await runCliWithCapturedIo({
    argv: [
      "workspace",
      "reset",
      "--path",
      repoRoot,
      "--base",
      "HEAD",
      "--exclude",
      ".env",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly removedGitIndexLock: boolean;
    readonly cleanedPaths: readonly string[];
    readonly preservedExcludes: readonly string[];
  };
  expect(payload.ok).toBe(true);
  expect(payload.removedGitIndexLock).toBe(true);
  expect(payload.cleanedPaths).toContain("scratch.txt");
  expect(payload.preservedExcludes).toEqual([".env"]);

  expect(await readFile(resolve(repoRoot, "tracked.txt"), "utf8")).toBe(
    "clean\n"
  );
  expect(await Bun.file(resolve(repoRoot, "scratch.txt")).exists()).toBe(false);
  expect(await readFile(resolve(repoRoot, ".env"), "utf8")).toBe(
    "KEEP_ME=yes\n"
  );
  expect(await Bun.file(resolve(repoRoot, ".git", "index.lock")).exists()).toBe(
    false
  );

  const status = await runGit({
    repoRoot,
    args: ["status", "--porcelain", "--untracked-files=all"],
  });
  expect(status.exitCode).toBe(0);
  expect(status.stdout.trim()).toBe("?? .env");
});

async function createMinimalHackRepo(input: {
  readonly repoRoot: string;
}): Promise<void> {
  await mkdir(resolve(input.repoRoot, ".hack"), { recursive: true });
  await writeFile(
    resolve(input.repoRoot, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    resolve(input.repoRoot, ".hack", "hack.config.json"),
    `${JSON.stringify({ name: "workspace-reset-test" }, null, 2)}\n`
  );
  await writeFile(resolve(input.repoRoot, "tracked.txt"), "clean\n");

  await expectGitSuccess({
    repoRoot: input.repoRoot,
    args: ["init", "-b", "main"],
  });
  await expectGitSuccess({
    repoRoot: input.repoRoot,
    args: ["config", "user.email", "test@example.com"],
  });
  await expectGitSuccess({
    repoRoot: input.repoRoot,
    args: ["config", "user.name", "Test User"],
  });
  await expectGitSuccess({
    repoRoot: input.repoRoot,
    args: ["add", "."],
  });
  await expectGitSuccess({
    repoRoot: input.repoRoot,
    args: ["commit", "-m", "initial"],
  });
}

async function expectGitSuccess(input: {
  readonly repoRoot: string;
  readonly args: readonly string[];
}): Promise<void> {
  const result = await runGit(input);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${input.args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

async function runGit(input: {
  readonly repoRoot: string;
  readonly args: readonly string[];
}): Promise<CliRunResult> {
  const proc = Bun.spawn(["git", "-C", input.repoRoot, ...input.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runCliWithCapturedIo(input: {
  readonly argv: readonly string[];
}): Promise<CliRunResult> {
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
    const exitCode = await runCli(input.argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
