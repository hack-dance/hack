import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLifecycleJsonData } from "../src/commands/project.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalSyncMode: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-lifecycle-json-"));
  originalHome = process.env.HOME;
  originalSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  process.env.HOME = tempDir;
  process.env.HACK_SETUP_SYNC_MODE = "off";
});

afterEach(async () => {
  setLoggerBackendOverride({ backend: null });
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  if (originalSyncMode === undefined) {
    Reflect.deleteProperty(process.env, "HACK_SETUP_SYNC_MODE");
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSyncMode;
  }
});

test("buildLifecycleJsonData shapes the envelope payload with sorted services", () => {
  const data = buildLifecycleJsonData({
    action: "up",
    project: "demo",
    branch: "feat-x",
    composeProject: "demo--feat-x",
    started: ["web", "api"],
    failed: ["worker"],
    durationMs: 1234,
  });

  expect(data).toEqual({
    action: "up",
    project: "demo",
    branch: "feat-x",
    composeProject: "demo--feat-x",
    services: {
      started: ["api", "web"],
      stopped: [],
      failed: ["worker"],
    },
    durationMs: 1234,
  });
});

test("buildLifecycleJsonData defaults omitted service lists to empty", () => {
  const data = buildLifecycleJsonData({
    action: "down",
    project: "demo",
    branch: null,
    composeProject: "demo",
    stopped: ["api"],
    durationMs: 10,
  });
  expect(data.services).toEqual({ started: [], stopped: ["api"], failed: [] });
});

for (const action of ["up", "down", "restart"] as const) {
  test(`${action} --json outside a project emits an E_PROJECT_NOT_FOUND envelope on pure-JSON stdout`, async () => {
    if (!tempDir) {
      throw new Error("Missing temp directory");
    }

    const result = await runCliWithCapturedOutput([
      action,
      "--json",
      "--path",
      tempDir,
    ]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("E_PROJECT_NOT_FOUND");
    expect(parsed.error?.message).toContain("hack init");
  });
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
