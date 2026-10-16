import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalLogger: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-up-missing-project-"));
  originalLogger = process.env.HACK_LOGGER;
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalLogger !== undefined) {
    process.env.HACK_LOGGER = originalLogger;
  } else {
    process.env.HACK_LOGGER = undefined;
  }
});

test("up without .hack prints a user message without stack trace", async () => {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }

  const result = await runCliWithCapturedOutput(["up", "--path", tempDir]);

  expect(result.exitCode).toBe(1);

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  expect(combinedOutput).toContain(
    "No .hack/ (or legacy .dev/) found. Run: hack init"
  );
  expect(combinedOutput).not.toContain("at requireProjectContext");
  expect(combinedOutput).not.toContain("at async handleUp");
  expect(combinedOutput).not.toContain("ERROR Error:");
});

test("up still reports unrelated usage errors", async () => {
  const result = await runCliWithCapturedOutput([
    "up",
    "--definitely-not-a-real-flag",
  ]);

  expect(result.exitCode).toBe(1);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  expect(combinedOutput).toContain("Unknown option");
  expect(combinedOutput).toContain("--definitely-not-a-real-flag");
  expect(combinedOutput).toContain("Usage:");
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
