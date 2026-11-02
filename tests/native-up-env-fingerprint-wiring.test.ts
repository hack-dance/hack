import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import type { ComposeEnvFingerprintRecord } from "../src/lib/compose-env-fingerprint.ts";
import {
  createNativeEnvFingerprintEntry,
  loadNativeEnvFingerprint,
  type NativeEnvFingerprintEntry,
  type NativeEnvFingerprintScope,
  saveNativeEnvFingerprint,
} from "../src/lib/native-env-fingerprint-state.ts";
import { restoreEnv } from "./helpers/env.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

// HACK-1140 command wiring: `hack up` / `hack restart` on the native image
// backend record the env-selection fingerprint the run reports, bound to the
// image owner and the effective branch; release it when the foreground ends;
// and a restart drops the previous run's record once that run is stopping.
// The runtime boundaries (start, restart orchestration, down) are mocked; the
// fingerprint store under test is the real one on a temporary project.

const RUN_OLD = "0".repeat(32);
const RUN_NEW = "1".repeat(32);
const BRANCH = "feature-a";

type StartOptions = {
  readonly onEnvironmentReady?: (selection: {
    readonly run: string;
    readonly fingerprint: ComposeEnvFingerprintRecord;
  }) => Promise<void>;
};
type RestartOptions = {
  readonly down: () => Promise<unknown>;
  readonly start: (options: {
    run: unknown;
    onReady: () => Promise<void>;
  }) => Promise<number>;
};

let startBehavior: (opts: StartOptions) => Promise<number> = async () => 0;
let restartBehavior: (opts: RestartOptions) => Promise<number> = async () => 0;
let downBehavior: () => Promise<{ status: string }> = async () => ({
  status: "stopped",
});
const calls: string[] = [];

const startMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/native-project-start.ts",
  overrides: {
    startNativeProject: async (opts: StartOptions) => {
      calls.push("start");
      return await startBehavior(opts);
    },
  },
});
const restartMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/native-project-restart.ts",
  overrides: {
    restartNativeProject: async (opts: RestartOptions) => {
      calls.push("restart");
      return await restartBehavior(opts);
    },
  },
});
const downMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/native-project-down.ts",
  overrides: {
    nativeProjectDown: async () => {
      calls.push("down");
      return await downBehavior();
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
const { restartCommand, upCommand } = await import(
  "../src/commands/project.ts"
);

const ENV_KEYS = [
  "HACK_HOME",
  "HACK_RUNTIME_BACKEND",
  "HACK_NATIVE_BINARY",
  "HACK_NATIVE_HOME",
  "HACK_NATIVE_HTTPS_PORT",
  "HACK_NATIVE_CADDY_BINARY",
  "HACK_NATIVE_CADDY_SHA256",
  "HACK_NATIVE_SHARED_SOURCE",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const mocks = [startMock, restartMock, downMock, authoredMock, branchesMock];

beforeAll(() => {
  for (const mocked of mocks) {
    mocked.activate();
  }
});
afterEach(async () => {
  startBehavior = async () => 0;
  restartBehavior = async () => 0;
  downBehavior = async () => ({ status: "stopped" });
  calls.length = 0;
  for (const key of ENV_KEYS) {
    restoreEnv(key, savedEnv.get(key));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
afterAll(() => {
  for (const mocked of mocks) {
    mocked.deactivate();
  }
});

function fingerprint(seed: string): ComposeEnvFingerprintRecord {
  return {
    version: 1,
    salt: seed.repeat(32),
    services: { web: seed.repeat(64) },
  };
}

async function nativeProject(): Promise<{
  readonly root: string;
  readonly scope: NativeEnvFingerprintScope;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-up-env-fingerprint-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack", PROJECT_COMPOSE_FILENAME),
    "name: fingerprint-compose\nservices:\n  web:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(root, ".hack", PROJECT_CONFIG_FILENAME),
    JSON.stringify({ dev_host: "fingerprint.hack" })
  );
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
  process.env.HACK_HOME = join(root, ".global-hack");
  process.env.HACK_RUNTIME_BACKEND = "native";
  process.env.HACK_NATIVE_BINARY = join(root, "hack-local");
  process.env.HACK_NATIVE_HOME = join(root, "native-home");
  process.env.HACK_NATIVE_SHARED_SOURCE = "1";
  return {
    root,
    scope: { projectDir: join(root, ".hack"), owner: "image", branch: BRANCH },
  };
}

async function up(root: string): Promise<number> {
  const input = {
    ctx: { cwd: root, cli: CLI_SPEC },
    args: {
      options: {
        path: root,
        project: undefined,
        env: undefined,
        branch: BRANCH,
        detach: false,
        profile: undefined,
        target: undefined,
        json: false,
      },
      positionals: { services: [] },
      raw: { argv: ["--path", root, "--branch", BRANCH], positionals: [] },
    },
  } as unknown as Parameters<typeof upCommand.handler>[0];
  return await upCommand.handler(input);
}

async function restart(root: string): Promise<number> {
  const input = {
    ctx: { cwd: root, cli: CLI_SPEC },
    args: {
      options: {
        path: root,
        project: undefined,
        env: undefined,
        branch: BRANCH,
        profile: undefined,
        target: undefined,
        json: false,
        recoverFrontend: false,
        expectFinalizationAttempt: undefined,
        expectFrontendPid: undefined,
      },
      positionals: { services: [] },
      raw: { argv: ["--path", root, "--branch", BRANCH], positionals: [] },
    },
  } as unknown as Parameters<typeof restartCommand.handler>[0];
  return await restartCommand.handler(input);
}

/** Start behavior that reports `run`'s env and snapshots the record while running. */
function reportingStart(
  scope: NativeEnvFingerprintScope,
  run: string,
  seen: { entry?: NativeEnvFingerprintEntry | null },
  outcome: () => Promise<number> = async () => 0
) {
  return async (opts: StartOptions) => {
    await opts.onEnvironmentReady?.({ run, fingerprint: fingerprint("e") });
    seen.entry = await loadNativeEnvFingerprint(scope);
    return await outcome();
  };
}

async function seedPreviousRun(scope: NativeEnvFingerprintScope) {
  await saveNativeEnvFingerprint(
    scope,
    createNativeEnvFingerprintEntry({
      owner: "image",
      run: RUN_OLD,
      fingerprint: fingerprint("d"),
    })
  );
}

const restartedRun = {
  run: RUN_NEW,
  effectiveEnvName: null,
  profiles: [],
  aws: null,
};

test("native up records the reported env under the image owner and branch, then releases it", async () => {
  const { root, scope } = await nativeProject();
  const seen: { entry?: NativeEnvFingerprintEntry | null } = {};
  startBehavior = reportingStart(scope, RUN_NEW, seen);
  expect(await up(root)).toBe(0);
  expect(seen.entry).toEqual(
    createNativeEnvFingerprintEntry({
      owner: "image",
      run: RUN_NEW,
      fingerprint: fingerprint("e"),
    })
  );
  // Released when the foreground ended; nothing else is left behind.
  expect(await loadNativeEnvFingerprint(scope)).toBeNull();
  expect(
    await readdir(
      join(scope.projectDir, ".internal", "native-env-fingerprints")
    )
  ).toEqual([]);
});

test("native up releases its record when startup fails after reporting", async () => {
  const { root, scope } = await nativeProject();
  const seen: { entry?: NativeEnvFingerprintEntry | null } = {};
  startBehavior = reportingStart(scope, RUN_NEW, seen, () =>
    Promise.reject(new Error("synthetic startup failure"))
  );
  await expect(up(root)).rejects.toThrow("synthetic startup failure");
  expect(seen.entry?.run).toBe(RUN_NEW);
  expect(await loadNativeEnvFingerprint(scope)).toBeNull();
});

test("native up release keeps a record another owner wrote meanwhile", async () => {
  const { root, scope } = await nativeProject();
  startBehavior = async (opts) => {
    await opts.onEnvironmentReady?.({
      run: RUN_NEW,
      fingerprint: fingerprint("e"),
    });
    // A newer foreground replaced the record before this one ended.
    await seedPreviousRun(scope);
    return 0;
  };
  expect(await up(root)).toBe(0);
  expect((await loadNativeEnvFingerprint(scope))?.run).toBe(RUN_OLD);
});

test("native restart drops the previous run's record at down, records the new run, then releases", async () => {
  const { root, scope } = await nativeProject();
  await seedPreviousRun(scope);
  const seen: { entry?: NativeEnvFingerprintEntry | null } = {};
  const beforeDown: { entry?: NativeEnvFingerprintEntry | null } = {};
  startBehavior = reportingStart(scope, RUN_NEW, seen);
  restartBehavior = async (opts) => {
    beforeDown.entry = await loadNativeEnvFingerprint(scope);
    await opts.down();
    return await opts.start({ run: restartedRun, onReady: async () => {} });
  };
  expect(await restart(root)).toBe(0);
  expect(calls).toEqual(["restart", "down", "start"]);
  expect(beforeDown.entry?.run).toBe(RUN_OLD);
  expect(seen.entry?.run).toBe(RUN_NEW);
  expect(seen.entry?.fingerprint).toEqual(fingerprint("e"));
  expect(await loadNativeEnvFingerprint(scope)).toBeNull();
});

test("a native restart that fails after down leaves no record", async () => {
  const { root, scope } = await nativeProject();
  await seedPreviousRun(scope);
  restartBehavior = async (opts) => {
    await opts.down();
    throw new Error("synthetic restart start failure");
  };
  await expect(restart(root)).rejects.toThrow(
    "synthetic restart start failure"
  );
  expect(calls).toEqual(["restart", "down"]);
  expect(await loadNativeEnvFingerprint(scope)).toBeNull();
});

test("a native restart whose down fails still drops the previous run's record", async () => {
  const { root, scope } = await nativeProject();
  await seedPreviousRun(scope);
  downBehavior = () => Promise.reject(new Error("synthetic down failure"));
  restartBehavior = async (opts) => {
    await opts.down();
    return 0;
  };
  await expect(restart(root)).rejects.toThrow("synthetic down failure");
  expect(await loadNativeEnvFingerprint(scope)).toBeNull();
});

test("negative control: a native restart refused before down keeps the running record", async () => {
  const { root, scope } = await nativeProject();
  await seedPreviousRun(scope);
  restartBehavior = () =>
    Promise.reject(new Error("synthetic preflight refusal"));
  await expect(restart(root)).rejects.toThrow("synthetic preflight refusal");
  expect(calls).toEqual(["restart"]);
  expect((await loadNativeEnvFingerprint(scope))?.run).toBe(RUN_OLD);
});
