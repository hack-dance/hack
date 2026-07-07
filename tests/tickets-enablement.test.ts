import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveTicketsIntegrationEnablement } from "../src/control-plane/extensions/tickets/enablement.ts";

let tempDir: string | null = null;
let originalGlobalConfigPath: string | undefined;
let originalHackHome: string | undefined;

beforeEach(async () => {
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  originalHackHome = process.env.HACK_HOME;
  tempDir = await mkdtemp(join(tmpdir(), "hack-tickets-enablement-"));
  process.env.HACK_HOME = join(tempDir, "hack-home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(
    tempDir,
    "global",
    "hack.config.json"
  );
});

afterEach(async () => {
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalGlobalConfigPath);
  restoreEnv("HACK_HOME", originalHackHome);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGlobalConfig(opts: {
  readonly ticketsEnabled: boolean;
}): Promise<void> {
  const path = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!path) {
    throw new Error("HACK_GLOBAL_CONFIG_PATH not set");
  }
  await writeJson(path, {
    controlPlane: {
      extensions: {
        "dance.hack.tickets": { enabled: opts.ticketsEnabled },
      },
    },
  });
}

async function createProjectRoot(opts: {
  readonly ticketsEnabled?: boolean;
}): Promise<string> {
  if (!tempDir) {
    throw new Error("tempDir not set");
  }
  const projectRoot = join(tempDir, "repo");
  const configPath = join(projectRoot, ".hack", "hack.config.json");
  if (opts.ticketsEnabled === undefined) {
    await mkdir(join(projectRoot, ".hack"), { recursive: true });
    return projectRoot;
  }
  await writeJson(configPath, {
    name: "demo",
    controlPlane: {
      extensions: {
        "dance.hack.tickets": { enabled: opts.ticketsEnabled },
      },
    },
  });
  return projectRoot;
}

test("tickets integration is disabled by default", async () => {
  const projectRoot = await createProjectRoot({});
  const enablement = await resolveTicketsIntegrationEnablement({
    projectRoot,
  });

  expect(enablement.project).toBe(false);
  expect(enablement.global).toBe(false);
});

test("global enablement applies to both scopes when project has no override", async () => {
  await writeGlobalConfig({ ticketsEnabled: true });
  const projectRoot = await createProjectRoot({});

  const enablement = await resolveTicketsIntegrationEnablement({
    projectRoot,
  });

  expect(enablement.project).toBe(true);
  expect(enablement.global).toBe(true);
});

test("project enablement does not enable the global scope", async () => {
  const projectRoot = await createProjectRoot({ ticketsEnabled: true });

  const enablement = await resolveTicketsIntegrationEnablement({
    projectRoot,
  });

  expect(enablement.project).toBe(true);
  expect(enablement.global).toBe(false);
});

test("project override can disable tickets while global stays enabled", async () => {
  await writeGlobalConfig({ ticketsEnabled: true });
  const projectRoot = await createProjectRoot({ ticketsEnabled: false });

  const enablement = await resolveTicketsIntegrationEnablement({
    projectRoot,
  });

  expect(enablement.project).toBe(false);
  expect(enablement.global).toBe(true);
});

test("omitted project root falls back to the global answer", async () => {
  await writeGlobalConfig({ ticketsEnabled: true });

  const enablement = await resolveTicketsIntegrationEnablement({});

  expect(enablement.project).toBe(true);
  expect(enablement.global).toBe(true);
});
