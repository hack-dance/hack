import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { setProjectEnvValue } from "../src/lib/project-env-config.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalSetupSyncMode: string | undefined;
let originalLogger: string | undefined;
let originalProjectEnvKey: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-env-modern-"));
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  originalProjectEnvKey = process.env.HACK_ENV_SECRET_KEY;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
  process.env.HACK_ENV_SECRET_KEY = undefined;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }
  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalProjectEnvKey === undefined) {
    process.env.HACK_ENV_SECRET_KEY = undefined;
  } else {
    process.env.HACK_ENV_SECRET_KEY = originalProjectEnvKey;
  }
});

test("modern env list masks secret values by default", async () => {
  const projectRoot = await createProject();

  const textResult = await runCliWithCapturedOutput([
    "env",
    "list",
    "--path",
    projectRoot,
    "--service",
    "api",
  ]);
  expect(textResult.exitCode).toBe(0);
  expect(textResult.stdout).toContain("SERVICE_TOKEN\tapi\t***");
  expect(textResult.stdout).not.toContain("super-secret-token");

  const jsonResult = await runCliWithCapturedOutput([
    "env",
    "list",
    "--path",
    projectRoot,
    "--service",
    "api",
    "--json",
  ]);
  expect(jsonResult.exitCode).toBe(0);
  expect(jsonResult.stdout).toContain('"status": {');
  expect(jsonResult.stdout).toContain('"storage": {');
  expect(jsonResult.stdout).toContain('"backend": "project_key"');
  expect(jsonResult.stdout).toContain('"key": "SERVICE_TOKEN"');
  expect(jsonResult.stdout).toContain('"value": "***"');
  expect(jsonResult.stdout).not.toContain("super-secret-token");
  expect(jsonResult.stdout).not.toContain('"materialized"');
  expect(jsonResult.stdout).toContain('"materialized_keys": []');
});

async function createProject(): Promise<string> {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }

  const projectRoot = resolve(tempDir, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  await writeFile(
    resolve(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    resolve(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: "modern-env-list-test",
        dev_host: "modern-env-list.hack",
      },
      null,
      2
    )}\n`
  );

  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "super-secret-token",
    secret: true,
  });

  return projectRoot;
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
