import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { restoreEnv } from "./helpers/env.ts";

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
  restoreEnv("HOME", originalHome);
  restoreEnv("HACK_LOGGER", originalLogger);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalGlobalConfigPath);
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

test("global default_domain is validated before writing", async () => {
  const { runCli } = await import("../src/cli/run.ts");
  const path = process.env.HACK_GLOBAL_CONFIG_PATH ?? "";
  expect(
    await runCli(["config", "set", "--global", "default_domain", "hack.gy"])
  ).toBe(0);
  expect(JSON.parse(await readFile(path, "utf8")).default_domain).toBe(
    "hack.gy"
  );
  expect(
    await runCli([
      "config",
      "set",
      "--global",
      "default_domain",
      "https://bad.example/",
    ])
  ).not.toBe(0);
  expect(JSON.parse(await readFile(path, "utf8")).default_domain).toBe(
    "hack.gy"
  );
});

test("project config rejects the global-only default_domain key", async () => {
  const repoRoot = join(tempDir ?? "", "repo");
  const projectDir = join(repoRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli([
      "config",
      "set",
      "--path",
      repoRoot,
      "default_domain",
      "hack.gy",
    ])
  ).not.toBe(0);
  expect(await Bun.file(join(projectDir, "hack.config.json")).exists()).toBe(
    false
  );
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

test("config get does not create or lock the global project registry", async () => {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }
  const projectRoot = join(tempDir, "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "hack.config.json"),
    '{"name":"read-only-project","dev_host":"read-only.hack"}\n'
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine\n"
  );

  const { runCli } = await import("../src/cli/run.ts");
  expect(await runCli(["config", "get", "--path", projectRoot, "name"])).toBe(
    0
  );
  const lockPath = join(tempDir, ".hack", "projects.json.lock");
  const registryPath = join(tempDir, ".hack", "projects.json");
  expect(await exists(lockPath)).toBe(false);
  expect(await exists(registryPath)).toBe(false);
});

for (const mixed of [false, true]) {
  test(`config get/set refuses native project paths without creating legacy files or registration (mixed=${mixed})`, async () => {
    const projectRoot = join(tempDir!, "native");
    const projectDir = join(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    const marker = join(projectDir, "hack.project.json");
    await writeFile(marker, "{invalid-native");
    const legacy = join(projectDir, "hack.config.json");
    if (mixed) {
      await writeFile(legacy, '{"name":"original"}\n');
      await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
    }
    const before = await readdir(projectDir);
    const { runCli } = await import("../src/cli/run.ts");
    for (const args of [
      ["config", "get", "--path", projectRoot, "name"],
      ["config", "set", "--path", projectRoot, "name", "changed"],
    ]) {
      expect(await runCli(args)).not.toBe(0);
    }
    expect(await readdir(projectDir)).toEqual(before);
    expect(await readFile(marker, "utf8")).toBe("{invalid-native");
    if (mixed) {
      expect(await readFile(legacy, "utf8")).toBe('{"name":"original"}\n');
    }
    expect(await exists(join(tempDir!, ".hack"))).toBe(false);
  });
}

test("config registered selection refuses a native marker and preserves registry bytes", async () => {
  const projectRoot = join(tempDir!, "native");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "hack.project.json"), "{}");
  const registry = join(tempDir!, ".hack", "projects.json");
  await mkdir(dirname(registry), { recursive: true });
  const before = JSON.stringify({
    version: 1,
    projects: [
      {
        id: "native-id",
        name: "native",
        repoRoot: projectRoot,
        projectDir,
        projectDirName: ".hack",
        createdAt: "2026-10-06T00:00:00Z",
      },
    ],
  });
  await writeFile(registry, before);
  const { runCli } = await import("../src/cli/run.ts");
  expect(
    await runCli(["config", "get", "--project", "native", "name"])
  ).not.toBe(0);
  expect(
    await runCli(["config", "set", "--project", "native", "name", "changed"])
  ).not.toBe(0);
  expect(await readFile(registry, "utf8")).toBe(before);
  expect(await readdir(dirname(registry))).toEqual(["projects.json"]);
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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
