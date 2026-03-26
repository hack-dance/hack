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
import { join, resolve } from "node:path";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalSetupSyncMode: string | undefined;
let originalLogger: string | undefined;
let originalPath: string | undefined;
let originalDockerLogPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-restart-env-"));
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  originalPath = process.env.PATH;
  originalDockerLogPath = process.env.HACK_TEST_DOCKER_LOG;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalSetupSyncMode !== undefined) {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  }
  if (originalLogger !== undefined) {
    process.env.HACK_LOGGER = originalLogger;
  } else {
    process.env.HACK_LOGGER = undefined;
  }
  if (originalPath !== undefined) {
    process.env.PATH = originalPath;
  } else {
    process.env.PATH = undefined;
  }
  if (originalDockerLogPath !== undefined) {
    process.env.HACK_TEST_DOCKER_LOG = originalDockerLogPath;
  } else {
    process.env.HACK_TEST_DOCKER_LOG = undefined;
  }
});

test(
  "restart reuses the persisted runtime env selection when --env is omitted",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp directory");
    }

    const projectRoot = resolve(tempDir, "repo");
    const projectDir = resolve(projectRoot, ".hack");
    const internalDir = resolve(projectDir, ".internal");
    const fakeBinDir = resolve(tempDir, "fake-bin");
    const dockerLogPath = resolve(tempDir, "docker.log");

    await mkdir(internalDir, { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      `${[
        'name: "restart-env"',
        "services:",
        "  app:",
        '    image: "busybox"',
      ].join("\n")}\n`
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify({ name: "restart-env" }, null, 2)}\n`
    );
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [
            {
              key: "DATABASE_URL",
              required: false,
              source: "plain_env",
            },
          ],
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      resolve(projectDir, ".env"),
      "DATABASE_URL=mysql://base@127.0.0.1:3306/base\n"
    );
    await writeFile(
      resolve(projectDir, ".env.docker"),
      "DATABASE_URL=mysql://docker@host.docker.internal:3306/docker\n"
    );
    await writeFile(
      resolve(internalDir, "runtime-state.json"),
      `${JSON.stringify(
        {
          entries: [
            {
              composeProject: "restart-env",
              envName: "docker",
              updatedAt: "2026-03-26T00:00:00.000Z",
            },
          ],
        },
        null,
        2
      )}\n`
    );
    const fakeDockerPath = resolve(fakeBinDir, "docker");
    await writeFile(
      fakeDockerPath,
      `${[
        "#!/bin/sh",
        'printf \'args:%s\\nDATABASE_URL:%s\\n---\\n\' "$*" "$DATABASE_URL" >> "$HACK_TEST_DOCKER_LOG"',
        "exit 0",
      ].join("\n")}\n`
    );
    await chmod(fakeDockerPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
    process.env.HACK_TEST_DOCKER_LOG = dockerLogPath;

    const result = await runCliWithCapturedOutput([
      "restart",
      "--path",
      projectRoot,
    ]);

    expect(result.exitCode).toBe(0);
    const dockerLog = await readFile(dockerLogPath, "utf8");
    const invocations = dockerLog
      .split("---\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);

    expect(invocations.length).toBeGreaterThan(0);
    const upInvocation = invocations.find((chunk) => chunk.includes(" up"));
    expect(upInvocation).toBeDefined();
    expect(upInvocation).toContain("args:compose -f");
    expect(upInvocation).toContain(
      "DATABASE_URL:mysql://docker@host.docker.internal:3306/docker"
    );
    expect(dockerLog).not.toContain(
      "DATABASE_URL:mysql://base@127.0.0.1:3306/base"
    );
  },
  { timeout: 20_000 }
);

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
