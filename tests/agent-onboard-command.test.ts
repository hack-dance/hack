import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalSyncMode: string | undefined;

beforeEach(() => {
  originalSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  process.env.HACK_SETUP_SYNC_MODE = "off";
});

afterEach(async () => {
  if (originalSyncMode === undefined) {
    Reflect.deleteProperty(process.env, "HACK_SETUP_SYNC_MODE");
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSyncMode;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupTempRepo(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-onboard-cmd-"));
  return tempDir;
}

async function writeHackProject(opts: {
  readonly repoRoot: string;
  readonly name: string;
  readonly devHost: string;
}): Promise<void> {
  const hackDir = join(opts.repoRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await Bun.write(
    join(hackDir, "docker-compose.yml"),
    ["services:", "  api:", "    image: node:22"].join("\n")
  );
  await Bun.write(
    join(hackDir, "hack.config.json"),
    JSON.stringify({ name: opts.name, dev_host: opts.devHost }, null, 2)
  );
}

test("hack agent onboard prints the new-project prompt outside a hack project", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "agent",
    "onboard",
    "--path",
    repoRoot,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("stand up hack in this repo");
  expect(result.stdout).toContain("hack init --auto");
  expect(result.stdout).toContain("## Phase 5 — Verify (loop until clean)");
});

test("hack agent onboard uses existing-project mode with config name and dev_host", async () => {
  const repoRoot = await setupTempRepo();
  await writeHackProject({
    repoRoot,
    name: "demoapp",
    devHost: "demoapp.hack",
  });

  const result = await runCliWithCapturedOutput([
    "agent",
    "onboard",
    "--path",
    repoRoot,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("adopt the existing hack setup in this repo");
  expect(result.stdout).toContain("(project: demoapp)");
  expect(result.stdout).toContain("api.demoapp.hack");
  expect(result.stdout).toContain("node_modules:/app/node_modules");
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
