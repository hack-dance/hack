import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalLogger: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalLogger = process.env.HACK_LOGGER;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-config-command-"));
  process.env.HOME = tempDir;
  process.env.HACK_LOGGER = "console";
  process.env.HACK_GLOBAL_CONFIG_PATH = join(tempDir, "hack.config.json");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  process.env.HACK_LOGGER = originalLogger;
  process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
});

test("config set --global updates extension enabled using bracket path", async () => {
  const configPath = await writeBaseGlobalConfig();
  const { runCli } = await import("../src/cli/run.ts");
  const exitCode = await runCli([
    "config",
    "set",
    "--global",
    'controlPlane.extensions["dance.hack.cloudflare"].enabled',
    "false",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  expect(parsed.controlPlane.extensions["dance.hack.cloudflare"].enabled).toBe(
    false
  );
  expect(parsed.controlPlane["dance.hack.cloudflare"]).toBeUndefined();
});

test("config set --global updates extension config hostname using bracket path", async () => {
  const configPath = await writeBaseGlobalConfig();
  const { runCli } = await import("../src/cli/run.ts");
  const exitCode = await runCli([
    "config",
    "set",
    "--global",
    'controlPlane.extensions["dance.hack.cloudflare"].config.hostname',
    "gateway.example.com",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  expect(
    parsed.controlPlane.extensions["dance.hack.cloudflare"].config.hostname
  ).toBe("gateway.example.com");
  expect(parsed.controlPlane["dance.hack.cloudflare"]).toBeUndefined();
});

test("config set --global migrates legacy controlPlane extension path to extensions map", async () => {
  const configPath = await writeLegacyGlobalConfig();
  const { runCli } = await import("../src/cli/run.ts");
  const exitCode = await runCli([
    "config",
    "set",
    "--global",
    'controlPlane["dance.hack.cloudflare"].enabled',
    "false",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  expect(parsed.controlPlane.extensions["dance.hack.cloudflare"].enabled).toBe(
    false
  );
  expect(parsed.controlPlane["dance.hack.cloudflare"]).toBeUndefined();
});

test("config set --global cleans stale legacy cloudflare mirror on canonical updates", async () => {
  const configPath = await writeLegacyGlobalConfig();
  const { runCli } = await import("../src/cli/run.ts");
  const exitCode = await runCli([
    "config",
    "set",
    "--global",
    'controlPlane.extensions["dance.hack.cloudflare"].config.hostname',
    "gateway.cleaned.test",
  ]);
  expect(exitCode).toBe(0);

  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  expect(
    parsed.controlPlane.extensions["dance.hack.cloudflare"].config.hostname
  ).toBe("gateway.cleaned.test");
  expect(parsed.controlPlane["dance.hack.cloudflare"]).toBeUndefined();
});

async function writeBaseGlobalConfig(): Promise<string> {
  const configPath = globalConfigPathForTest();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        controlPlane: {
          extensions: {
            "dance.hack.cloudflare": {
              enabled: true,
              config: {
                hostname: "gateway.initial.test",
                sshHostname: "ssh.initial.test",
              },
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
  return configPath;
}

async function writeLegacyGlobalConfig(): Promise<string> {
  const configPath = globalConfigPathForTest();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        controlPlane: {
          extensions: {
            "dance.hack.cloudflare": {
              enabled: true,
              config: {
                hostname: "gateway.initial.test",
                sshHostname: "ssh.initial.test",
              },
            },
          },
          "dance.hack.cloudflare": {
            enabled: true,
            config: {
              hostname: "gateway.legacy.test",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
  return configPath;
}

function globalConfigPathForTest(): string {
  const configured = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configured.length === 0) {
    throw new Error(
      "HACK_GLOBAL_CONFIG_PATH must be set for config command tests"
    );
  }
  return configured;
}
