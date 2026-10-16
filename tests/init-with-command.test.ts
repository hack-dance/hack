import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * CLI-level coverage for `hack init --with <agent>`.
 *
 * These tests run with a stubbed PATH (no agent binaries) and
 * HACK_NO_INTERACTIVE=1, so the handoff always takes the printed-prompt
 * fallback and never spawns an interactive session. HACK_HOME points at a
 * temp dir so the projects registry is isolated from the real ~/.hack.
 */

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type SavedEnv = Record<string, string | undefined>;

const ENV_KEYS = ["PATH", "HACK_HOME", "HACK_NO_INTERACTIVE"] as const;

let tempDir: string | null = null;
let savedEnv: SavedEnv = {};

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  // realpath avoids /var vs /private/var symlink mismatches in the
  // projects-registry path equality checks on macOS.
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "hack-init-with-")));
  process.env.PATH = join(tempDir, "empty-path");
  process.env.HACK_HOME = join(tempDir, "hack-home");
  process.env.HACK_NO_INTERACTIVE = "1";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupTempRepo(): Promise<string> {
  const repoRoot = join(tempDir ?? "", "repo");
  await Bun.write(
    join(repoRoot, "package.json"),
    JSON.stringify({ name: "demo", scripts: { dev: "bun run dev.ts" } })
  );
  return repoRoot;
}

test("hack init --auto --with claude initializes and prints the prompt when no binary exists", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "claude",
    "--path",
    repoRoot,
  ]);

  expect(result.exitCode).toBe(0);
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(true);
  // Non-interactive: never spawn, always print the onboarding prompt.
  expect(result.stdout).toContain("hack onboarding");
  expect(result.stdout).toContain("## Phase 1 — Inventory the repo");
  expect(result.stdout).toContain("node_modules:/app/node_modules");
  expect(result.stdout).toContain("stand up hack in this repo");
});

test("hack init --auto --with proceeds to handoff when .hack already exists", async () => {
  const repoRoot = await setupTempRepo();

  const first = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--path",
    repoRoot,
  ]);
  expect(first.exitCode).toBe(0);

  const second = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "codex",
    "--path",
    repoRoot,
  ]);

  expect(second.exitCode).toBe(0);
  expect(`${second.stdout}${second.stderr}`).toContain("already exists");
  expect(second.stdout).toContain("adopt the existing hack setup in this repo");
});

test("hack init --with rejects unknown agents with a usage error", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "cursor",
    "--path",
    repoRoot,
  ]);

  // The usage error message is emitted via the logger (bypasses the stubbed
  // streams), so assert on behavior: failed exit and no scaffold written.
  expect(result.exitCode).not.toBe(0);
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(false);
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
