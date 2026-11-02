import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { restoreEnv } from "./helpers/env.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

// `hack up` on the native backend must hand startNativeProject the public runtime
// metadata selection; without it native containers silently lose HACK_DEV_URL etc.
const startups: Record<string, unknown>[] = [];
const startMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/native-project-start.ts",
  overrides: {
    startNativeProject: async (opts: Record<string, unknown>) => {
      startups.push(opts);
      return 0;
    },
  },
});
// Keep this a legacy Compose project test: no authored or adopted dispatch.
const authoredMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/native-compose-command.ts",
  overrides: { tryNativeComposeCommand: async () => null },
});
const branchesMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/branches.ts",
  overrides: {
    resolveEffectiveBranch: async () => ({
      branch: null,
      source: "none",
      gitBranch: null,
    }),
  },
});
const { upCommand } = await import("../src/commands/project.ts");

const ENV_KEYS = [
  "HACK_HOME",
  "HACK_RUNTIME_BACKEND",
  "HACK_NATIVE_BINARY",
  "HACK_NATIVE_HOME",
  "HACK_NATIVE_HTTPS_PORT",
  "HACK_NATIVE_CADDY_BINARY",
  "HACK_NATIVE_CADDY_SHA256",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

beforeAll(() => {
  startMock.activate();
  authoredMock.activate();
  branchesMock.activate();
});
afterEach(async () => {
  startups.length = 0;
  for (const key of ENV_KEYS) {
    restoreEnv(key, savedEnv.get(key));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
afterAll(() => {
  startMock.deactivate();
  authoredMock.deactivate();
  branchesMock.deactivate();
});

async function nativeProject(config: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "native-up-metadata-"));
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack", PROJECT_COMPOSE_FILENAME),
    "name: metadata-compose\nservices:\n  web:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(root, ".hack", PROJECT_CONFIG_FILENAME),
    JSON.stringify(config)
  );
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HACK_HOME = join(root, ".global-hack");
  process.env.HACK_RUNTIME_BACKEND = "native";
  process.env.HACK_NATIVE_BINARY = join(root, "hack-local");
  process.env.HACK_NATIVE_HOME = join(root, "native-home");
  return root;
}

async function up(root: string, branch?: string): Promise<number> {
  const argv = ["--path", root, ...(branch ? ["--branch", branch] : [])];
  const input = {
    ctx: { cwd: root, cli: CLI_SPEC },
    args: {
      options: {
        path: root,
        project: undefined,
        env: undefined,
        branch,
        detach: false,
        profile: undefined,
        target: undefined,
        json: false,
      },
      positionals: { services: [] },
      raw: { argv, positionals: [] },
    },
  } as unknown as Parameters<typeof upCommand.handler>[0];
  return await upCommand.handler(input);
}

test("native up passes the base dev host, OAuth alias and Compose project name", async () => {
  const root = await nativeProject({
    name: "metadata-config",
    dev_host: "meta.hack",
    oauth: { enabled: true, tld: "gy" },
  });
  expect(await up(root, "feature-a")).toBe(0);
  expect(startups).toHaveLength(1);
  const startup = startups[0];
  expect(startup?.scope).toMatchObject({ branch: "feature-a" });
  expect(startup?.runtimeMetadata).toEqual({
    devHost: "meta.hack",
    aliasHost: "meta.hack.gy",
    projectName: "metadata-compose",
  });
});

test("native up without an OAuth alias passes a null alias host", async () => {
  const root = await nativeProject({ dev_host: "plain.hack" });
  expect(await up(root)).toBe(0);
  expect(startups[0]?.scope).toMatchObject({ branch: null });
  expect(startups[0]?.runtimeMetadata).toEqual({
    devHost: "plain.hack",
    aliasHost: null,
    projectName: "metadata-compose",
  });
});
