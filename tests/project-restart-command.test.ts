import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runtimeUpCalls: Record<string, unknown>[] = [];
const runtimeDownCalls: Record<string, unknown>[] = [];

mock.module("../src/backends/runtime-backend.ts", () => ({
  composeRuntimeBackend: {
    name: "compose",
    up: async (opts: Record<string, unknown>) => {
      runtimeUpCalls.push(opts);
      return 0;
    },
    down: async (opts: Record<string, unknown>) => {
      runtimeDownCalls.push(opts);
      return 0;
    },
    psJson: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ps: async () => 0,
    run: async () => 0,
  },
}));

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalSetupSyncMode: string | undefined;
let originalLogger: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-restart-env-"));
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  originalLogger = process.env.HACK_LOGGER;
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";
  runtimeUpCalls.length = 0;
  runtimeDownCalls.length = 0;
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
});

afterAll(() => {
  mock.restore();
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

    await mkdir(internalDir, { recursive: true });
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

    const result = await runCliWithCapturedOutput([
      "restart",
      "--path",
      projectRoot,
    ]);

    expect(result.exitCode).toBe(0);
    expect(runtimeDownCalls).toHaveLength(1);
    expect(runtimeUpCalls).toHaveLength(1);

    const upEnv = runtimeUpCalls[0].env as Record<string, string>;

    expect(upEnv.DATABASE_URL).toBe(
      "mysql://docker@host.docker.internal:3306/docker"
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
