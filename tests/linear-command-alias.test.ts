import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;
let previousGlobalConfigPath: string | undefined;
let previousHome: string | undefined;
let previousLogger: string | undefined;
let previousSetupSyncMode: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(resolve(tmpdir(), "hack-linear-alias-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  previousHome = process.env.HOME;
  previousLogger = process.env.HACK_LOGGER;
  previousSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
  process.env.HACK_SETUP_SYNC_MODE = "off";
  await writeFile(tempGlobalConfigPath, "{}\n");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  tempGlobalConfigPath = null;
  if (previousGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = previousGlobalConfigPath;
  }
  if (previousHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = previousLogger;
  }
  if (previousSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = previousSetupSyncMode;
  }
});

test("hack linear alias forwards extension options like --json", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      resolve(import.meta.dir, "../index.ts"),
      "linear",
      "status",
      "--json",
    ],
    {
      cwd: tempDir ?? resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_LOGGER: "console",
        HACK_SETUP_SYNC_MODE: "off",
        HOME: tempDir ?? process.env.HOME ?? "",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const payload = JSON.parse(stdout) as {
    readonly extensionId?: string;
    readonly ok?: boolean;
  };
  expect(exitCode).toBe(payload.ok ? 0 : 1);
  expect(stderr).not.toContain('Option(s) not valid for "linear": --json');
  expect(payload.extensionId).toBe("dance.hack.linear");
});
