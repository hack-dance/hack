import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { YAML } from "bun";
import type {
  RuntimeRunOptions,
  RuntimeUpOptions,
} from "../src/backends/runtime-backend.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { evaluateComposeServiceEnvFreshness } from "../src/lib/compose-env-fingerprint.ts";
import { dockerEngineSelectionFingerprint } from "../src/lib/docker-helper-environment.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  readProjectRuntimeState,
  readProjectRuntimeStateEntry,
  stageProjectRuntimeLaunch,
  upsertProjectRuntimeStateEntry,
} from "../src/lib/project-runtime-state.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

let composeUpReturned = false;
const lifecycleStops: {
  afterUp: boolean;
  hadRuntimeState: boolean;
  composeProject: string;
}[] = [];
const psRows: string[] = [];
const psSnapshots: string[][] = [];
const errorMessages: string[] = [];
const warnMessages: string[] = [];
const upComposeContents: string[] = [];
/**
 * The global env Compose receives. The per-service `HACK_ENV_*` values that the
 * value-free env override references (HACK-1273) are covered by
 * tests/compose-env-at-rest-cli.test.ts.
 */
function withoutComposeEnvReferences(
  env: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  return env
    ? Object.fromEntries(
        Object.entries(env).filter(([key]) => !key.startsWith("HACK_ENV_"))
      )
    : env;
}

const upEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
const psEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
const upDetachSelections: Array<boolean | undefined> = [];
const upStartupTimeouts: Array<number | undefined> = [];
let upExitCode = 0;
let cancelRestartBeforeDispatch = false;
let stagedRestartOverlay: string | null | undefined;
let replaceLaunchBeforeStaging = false;
let activeFixtureDaemon: string | undefined;
let switchDaemonAfterStaging = false;
let psExitCode = 0;
let upDurationMs = 0;
let psDurationMs = 0;
/** Detached phases the mocked backend reports before returning upExitCode. */
let upReportedPhases: readonly ("images" | "start")[] = [];
const upImageTimeouts: Array<number | undefined> = [];
let downCalls = 0;
const upServiceSelections: Array<readonly string[] | undefined> = [];
const tempDirs = new Set<string>();
const runtimeCalls: Array<
  | { kind: "run"; opts: RuntimeRunOptions }
  | { kind: "up"; opts: RuntimeUpOptions }
> = [];
let runExitCode = 0;
const originalHackHome = process.env.HACK_HOME;
const originalComposeProfiles = process.env.COMPOSE_PROFILES;
const originalStartupTimeout = process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS;
let autoBranch: string | null = null;
let runtimeProjects: readonly Record<string, unknown>[] = [];

const branchesMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/branches.ts",
  overrides: {
    resolveEffectiveBranch: async () =>
      autoBranch
        ? { branch: autoBranch, source: "worktree", gitBranch: autoBranch }
        : { branch: null, source: "none", gitBranch: null },
  },
});

const runtimeProjectsMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/runtime-projects.ts",
  overrides: {
    readRuntimeProjects: async () => ({
      ok: true,
      runtime: runtimeProjects,
      error: null,
      checkedAtMs: Date.now(),
    }),
  },
});

const runtimeBackendMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/runtime-backend.ts",
  overrides: {
    composeRuntimeBackend: {
      name: "compose",
      up: async (opts: RuntimeUpOptions) => {
        if (opts.detach) {
          if (replaceLaunchBeforeStaging && opts.cwd && opts.composeProject) {
            const key = {
              projectDir: opts.cwd,
              composeProject: opts.composeProject,
            };
            const original = await readProjectRuntimeStateEntry(key);
            if (original) {
              const launchId = "newer-fixture-launch";
              await upsertProjectRuntimeStateEntry({
                projectDir: opts.cwd,
                entry: {
                  ...original,
                  launchId,
                  envName: "newer",
                  dockerEngineSelection: await dockerEngineSelectionFingerprint(
                    { cwd: opts.cwd, env: opts.env ?? {}, launchId }
                  ),
                },
              });
            }
          }
          await opts.beforeCreate?.();
          if (
            cancelRestartBeforeDispatch &&
            opts.onCreateDispatched &&
            opts.cwd &&
            opts.composeProject
          ) {
            stagedRestartOverlay = (
              await readProjectRuntimeStateEntry({
                projectDir: opts.cwd,
                composeProject: opts.composeProject,
              })
            )?.envName;
            throw new DOMException(
              "Cancelled before Compose dispatch",
              "AbortError"
            );
          }
          opts.onCreateDispatched?.();
        }
        await opts.beforeStart?.();
        if (!opts.detach) {
          opts.onCreateDispatched?.();
        }
        runtimeCalls.push({ kind: "up", opts });
        upComposeContents.push(
          (
            await Promise.all(
              opts.composeFiles.map((path) => readFile(path, "utf8"))
            )
          ).join("\n")
        );
        upEnvs.push(withoutComposeEnvReferences(opts.env));
        upServiceSelections.push(opts.services);
        upStartupTimeouts.push(opts.startupTimeoutMs);
        upImageTimeouts.push(opts.imageTimeoutMs);
        upDetachSelections.push(opts.detach);
        for (const phase of upReportedPhases) {
          opts.onStartupPhase?.(phase);
        }
        if (upDurationMs) {
          await Bun.sleep(upDurationMs);
        }
        composeUpReturned = true;
        return upExitCode;
      },
      down: async () => {
        downCalls += 1;
        return 0;
      },
      psJson: async (opts: {
        readonly env?: Readonly<Record<string, string>>;
        readonly cwd?: string;
        readonly noTrunc?: boolean;
      }) => {
        if (!opts.noTrunc) {
          psEnvs.push(withoutComposeEnvReferences(opts.env));
        }
        if (psDurationMs) {
          await Bun.sleep(psDurationMs);
        }
        const exitCode = opts.noTrunc && !composeUpReturned ? 0 : psExitCode;
        return {
          exitCode,
          stdout: (opts.noTrunc ? psRows : (psSnapshots.shift() ?? psRows))
            .map((row) => {
              const entry = JSON.parse(row);
              return JSON.stringify({
                ID: `container-${entry.Service}`,
                Labels: `com.docker.compose.project.working_dir=${opts.cwd}`,
                ...entry,
              });
            })
            .join("\n"),
          stderr: exitCode ? "Cannot connect to the Docker daemon" : "",
        };
      },
      ps: async () => 0,
      run: async (opts: RuntimeRunOptions) => {
        runtimeCalls.push({ kind: "run", opts });
        return runExitCode;
      },
      exec: async () => 0,
    },
  },
});

const lifecycleControllerMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/project-lifecycle-controller.ts",
  overrides: {
    stopLifecycleProcessController: async (opts: {
      readonly project: { readonly projectDir: string };
      readonly composeProject: string;
    }) => {
      const entry = await readProjectRuntimeStateEntry({
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      });
      lifecycleStops.push({
        afterUp: composeUpReturned,
        hadRuntimeState: entry !== null,
        composeProject: opts.composeProject,
      });
    },
  },
});

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    findExecutableInPath: (executableName: string) =>
      executableName === "docker" ? "/usr/bin/docker" : null,
  },
});

// These tests drive Compose through the mocked runtime backend; the engine
// preflight would otherwise run the host's real `docker` (absent on some CI
// runners). Its own behavior is covered in compose-engine-preflight.test.ts.
const enginePreflightMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/compose-engine-preflight.ts",
  overrides: {
    preflightComposeEngine: () => Promise.resolve(null),
    preflightSharedNetworks: () => Promise.resolve(null),
  },
});

const engineIdentityMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/docker-helper-environment.ts",
  overrides: {
    readDockerDaemonIdentity: () =>
      Promise.resolve(
        activeFixtureDaemon
          ? { kind: "verified", id: activeFixtureDaemon }
          : { kind: "unsupported" }
      ),
  },
});

const realStageProjectRuntimeLaunch = stageProjectRuntimeLaunch;
const runtimeStateMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/project-runtime-state.ts",
  overrides: {
    stageProjectRuntimeLaunch: async (
      opts: Parameters<typeof stageProjectRuntimeLaunch>[0]
    ) => {
      const displaced = await realStageProjectRuntimeLaunch(opts);
      if (switchDaemonAfterStaging) {
        activeFixtureDaemon = "fixture-two";
      }
      return displaced;
    },
  },
});

const loggerMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/ui/logger.ts",
  overrides: {
    logger: {
      debug: () => {},
      info: () => {},
      warn: (input: { readonly message: string }) => {
        warnMessages.push(input.message);
      },
      error: (input: { readonly message: string }) => {
        errorMessages.push(input.message);
      },
      success: () => {},
      step: () => {},
    },
  },
});

const { restartCommand, upCommand, runCommand } = await import(
  "../src/commands/project.ts"
);

beforeAll(() => {
  lifecycleControllerMock.activate();
  branchesMock.activate();
  runtimeBackendMock.activate();
  runtimeProjectsMock.activate();
  shellMock.activate();
  enginePreflightMock.activate();
  engineIdentityMock.activate();
  runtimeStateMock.activate();
  loggerMock.activate();
});

const originalImageTimeout = process.env.HACK_COMPOSE_IMAGE_TIMEOUT_MS;

beforeEach(() => {
  Reflect.deleteProperty(process.env, "HACK_COMPOSE_STARTUP_TIMEOUT_MS");
  Reflect.deleteProperty(process.env, "HACK_COMPOSE_IMAGE_TIMEOUT_MS");
});

afterEach(async () => {
  composeUpReturned = false;
  lifecycleStops.length = 0;
  psRows.length = 0;
  psSnapshots.length = 0;
  errorMessages.length = 0;
  warnMessages.length = 0;
  upEnvs.length = 0;
  upComposeContents.length = 0;
  psEnvs.length = 0;
  upServiceSelections.length = 0;
  upStartupTimeouts.length = 0;
  upDetachSelections.length = 0;
  upExitCode = 0;
  cancelRestartBeforeDispatch = false;
  stagedRestartOverlay = undefined;
  replaceLaunchBeforeStaging = false;
  activeFixtureDaemon = undefined;
  switchDaemonAfterStaging = false;
  psExitCode = 0;
  upDurationMs = 0;
  psDurationMs = 0;
  upReportedPhases = [];
  upImageTimeouts.length = 0;
  restoreEnv("HACK_COMPOSE_IMAGE_TIMEOUT_MS", originalImageTimeout);
  downCalls = 0;
  if (originalStartupTimeout === undefined) {
    Reflect.deleteProperty(process.env, "HACK_COMPOSE_STARTUP_TIMEOUT_MS");
  } else {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = originalStartupTimeout;
  }
  runtimeCalls.length = 0;
  runExitCode = 0;
  autoBranch = null;
  runtimeProjects = [];
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  restoreEnv("HACK_HOME", originalHackHome);
  if (originalComposeProfiles === undefined) {
    Reflect.deleteProperty(process.env, "COMPOSE_PROFILES");
  } else {
    process.env.COMPOSE_PROFILES = originalComposeProfiles;
  }
});

afterAll(() => {
  lifecycleControllerMock.deactivate();
  branchesMock.deactivate();
  runtimeBackendMock.deactivate();
  runtimeProjectsMock.deactivate();
  shellMock.deactivate();
  enginePreflightMock.deactivate();
  engineIdentityMock.deactivate();
  runtimeStateMock.deactivate();
  loggerMock.deactivate();
});

test("up returns failure when compose reports a created service after exit zero", async () => {
  const projectRoot = await createProject();
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "1000";
  psRows.push(
    JSON.stringify({ Service: "api", State: "created", ExitCode: 0 })
  );

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: api did not reach running or successful completion"
  );
});

test("up returns failure when compose reports no services after exit zero", async () => {
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "1000";
  const projectRoot = await createProject();

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: Compose reported no services after startup"
  );
});

for (const sequence of [
  ["created", "running", "exited"],
  ["created", "exited", "exited"],
  ["exited", "exited"],
  ["old-exited", "created", "exited", "exited"],
  ["old-exited", "created", "failed", "failed"],
]) {
  test(`up settles Docker one-shot observations: ${sequence.join(" -> ")}`, async () => {
    const projectRoot = await createProject();
    const composeFile = resolve(projectRoot, ".hack", PROJECT_COMPOSE_FILENAME);
    const document = YAML.parse(await readFile(composeFile, "utf8"));
    if (
      !(
        isRecord(document) &&
        isRecord(document.services) &&
        isRecord(document.services.api)
      )
    ) {
      throw new Error("Missing fixture API service");
    }
    document.services.api.restart = "no";
    await writeFile(composeFile, YAML.stringify(document));
    for (const state of sequence) {
      psSnapshots.push([
        JSON.stringify({
          ID:
            state === "old-exited"
              ? "previous-container"
              : "replacement-container",
          Service: "api",
          State:
            state === "old-exited" || state === "failed" ? "exited" : state,
          ExitCode: state === "failed" ? 17 : 0,
        }),
      ]);
    }
    const final = sequence.at(-1);
    psRows.push(
      JSON.stringify({
        ID: "replacement-container",
        Service: "api",
        State: "exited",
        ExitCode: final === "failed" ? 17 : 0,
      })
    );
    const exitCode = await runDetachedUp({ projectRoot });
    expect(exitCode).toBe(final === "failed" ? 1 : 0);
    expect(psEnvs.length).toBeGreaterThanOrEqual(2);
  });
}

test("up accepts running services and successful Compose completion gates", async () => {
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
  expect(upServiceSelections).toEqual([undefined]);
});

test("up rejects an exited service referenced only by an inactive profile", async () => {
  const projectRoot = await createProject();
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: api did not reach running or successful completion"
  );
});

test("up accepts completion gates from wildcard-enabled profiles", async () => {
  const projectRoot = await createProject();
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({ projectRoot, profiles: ["*"] });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
});

test("up accepts profiles delivered through COMPOSE_PROFILES", async () => {
  process.env.COMPOSE_PROFILES = "other";
  const projectRoot = await createProject({
    composeProfiles: "benchmark,diagnostics",
  });
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
  expect(upEnvs).toEqual([
    { COMPOSE_PROFILES: "benchmark,diagnostics", SHARED_MODE: "compose" },
  ]);
  expect(psEnvs).toEqual([...upEnvs, ...upEnvs]);
});

test("up accepts wildcard COMPOSE_PROFILES", async () => {
  const projectRoot = await createProject({ composeProfiles: "*" });
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
});

test("up gives CLI profiles precedence over COMPOSE_PROFILES", async () => {
  const projectRoot = await createProject({ composeProfiles: "benchmark" });
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({
    projectRoot,
    profiles: ["diagnostics"],
  });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: api did not reach running or successful completion"
  );
});

test("up combines multiple CLI profiles", async () => {
  const projectRoot = await createProject({ composeProfiles: "diagnostics" });
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runDetachedUp({
    projectRoot,
    profiles: ["diagnostics", "benchmark"],
  });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
});

test("up accepts a directly targeted completion dependency", async () => {
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );

  const exitCode = await runDetachedUp({
    projectRoot,
    services: ["migrate"],
  });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
  expect(upServiceSelections).toEqual([["migrate"]]);
});

test("registry credentials must exist in the bootstrap service scope", async () => {
  const projectRoot = await createProject({ registryTokenScope: "api" });

  await expect(runDetachedUp({ projectRoot })).rejects.toThrow(
    "Missing package-registry credential for service deps: GITHUB_TOKEN"
  );
  expect(upEnvs).toEqual([]);
});

test("restart returns failure when compose reports a created service after exit zero", async () => {
  const projectRoot = await createProject();
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "1000";
  psRows.push(
    JSON.stringify({ Service: "api", State: "created", ExitCode: 0 })
  );

  const exitCode = await runRestart({ projectRoot });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: api did not reach running or successful completion"
  );
});

test("restart accepts completion gates from inherited COMPOSE_PROFILES", async () => {
  process.env.COMPOSE_PROFILES = "benchmark";
  const projectRoot = await createProject();
  psRows.push(JSON.stringify({ Service: "api", State: "exited", ExitCode: 0 }));

  const exitCode = await runRestart({ projectRoot });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
});

test("targeted restart preserves delivered Compose environment", async () => {
  const projectRoot = await createProject({ composeProfiles: "benchmark" });
  psRows.push(
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );

  const exitCode = await runRestart({
    projectRoot,
    services: ["migrate"],
  });

  expect(exitCode).toBe(0);
  expect(errorMessages).toEqual([]);
  expect(upServiceSelections).toEqual([["migrate"]]);
  // Three reads, all with the delivered environment: the one-shot
  // interruption guard's (HACK-2310) before the recreate, then the two
  // readiness reads after it.
  expect(psEnvs).toEqual([
    { COMPOSE_PROFILES: "benchmark", SHARED_MODE: "compose" },
    { COMPOSE_PROFILES: "benchmark", SHARED_MODE: "compose" },
    { COMPOSE_PROFILES: "benchmark", SHARED_MODE: "compose" },
  ]);
});

async function captureStdout(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
}> {
  let stdout = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), stdout };
  } finally {
    process.stdout.write = write;
  }
}

test("a one-shot gated by a delivered profile is seen by the restart guard", async () => {
  // With `benchmark` delivered, profiled-worker waits for api to complete,
  // so a running api is a one-shot that a targeted restart interrupts.
  const projectRoot = await createProject({ composeProfiles: "benchmark" });
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  const { code, stdout } = await captureStdout(() =>
    runRestart({ projectRoot, services: ["api"], json: true })
  );
  const envelope = JSON.parse(stdout) as {
    data?: { interrupted?: string[]; warnings?: string[] };
    error?: unknown;
  };
  expect(envelope.data?.interrupted).toEqual(["api"]);
  expect(envelope.data?.warnings?.[0]).toContain(
    "interrupted the one-shot service api"
  );
  // The guard's read carries the delivered environment, profiles included.
  expect(psEnvs[0]).toEqual({
    COMPOSE_PROFILES: "benchmark",
    SHARED_MODE: "compose",
  });
  expect({ code, error: envelope.error }).toEqual({
    code: 0,
    error: undefined,
  });
});

test("without the profile, a running api is not a one-shot and nothing is interrupted", async () => {
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  const { stdout } = await captureStdout(() =>
    runRestart({ projectRoot, services: ["api"], json: true })
  );
  const envelope = JSON.parse(stdout) as {
    data?: { interrupted?: string[] };
  };
  expect(envelope.data?.interrupted).toBeUndefined();
});

test("up records value-free env digests and a targeted restart refreshes only its service", async () => {
  const projectRoot = await createProject();
  const projectDir = resolve(projectRoot, ".hack");
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );
  const readEntry = () =>
    readProjectRuntimeStateEntry({
      projectDir,
      composeProject: "startup-state-test",
    });

  expect(await runDetachedUp({ projectRoot })).toBe(0);
  const atUp = (await readEntry())?.envFingerprint;
  expect(Object.keys(atUp?.services ?? {})).toEqual([
    "api",
    "migrate",
    "profiled-worker",
  ]);
  const freshness = (
    record: typeof atUp,
    service: string,
    mode: string
  ): string =>
    evaluateComposeServiceEnvFreshness({
      record,
      service,
      currentEnv: { SHARED_MODE: mode },
    });
  expect(freshness(atUp, "api", "compose")).toBe("unchanged");
  expect(freshness(atUp, "api", "rotated")).toBe("changed");

  const envPath = resolve(projectDir, "hack.env.default.yaml");
  await writeFile(
    envPath,
    (await readFile(envPath, "utf8")).replace(
      '    SHARED_MODE: "compose"',
      '    SHARED_MODE: "rotated"'
    )
  );
  expect(await runRestart({ projectRoot, services: ["api"] })).toBe(0);
  const afterRestart = (await readEntry())?.envFingerprint;
  expect(afterRestart?.salt).toBe(atUp?.salt);
  expect(freshness(afterRestart, "api", "rotated")).toBe("unchanged");
  expect(freshness(afterRestart, "migrate", "rotated")).toBe("changed");
  expect(afterRestart?.services.migrate).toBe(atUp?.services.migrate);
  const stored = await readFile(
    resolve(projectDir, ".internal/runtime-state.json"),
    "utf8"
  );
  for (const text of ["SHARED_MODE", "rotated", '"compose"']) {
    expect(stored).not.toContain(text);
  }
});

/**
 * Service name to the env key names its entry in the generated override
 * declares, and every `${NAME}` reference the file uses. Names only.
 */
async function readOverrideShape(projectRoot: string): Promise<{
  readonly keysByService: Record<string, readonly string[]>;
  readonly references: readonly string[];
}> {
  const text = await readFile(
    resolve(projectRoot, ".hack/.internal/compose.env.override.yml"),
    "utf8"
  );
  const parsed = YAML.parse(text) as {
    readonly services?: Record<
      string,
      { readonly environment?: Record<string, string> }
    >;
  };
  const keysByService: Record<string, readonly string[]> = {};
  const references = new Set<string>();
  for (const [service, entry] of Object.entries(parsed.services ?? {})) {
    const environment = entry.environment ?? {};
    keysByService[service] = Object.keys(environment).sort();
    for (const reference of Object.values(environment)) {
      references.add(reference.slice(2, -1));
    }
  }
  return { keysByService, references: [...references].sort() };
}

for (const targeted of ["restart", "up"] as const) {
  test(`a targeted ${targeted} keeps every service's entry in the env override (HACK-2325)`, async () => {
    const projectRoot = await createProject();
    const envPath = resolve(projectRoot, ".hack/hack.env.default.yaml");
    await writeFile(
      envPath,
      `${(await readFile(envPath, "utf8")).trimEnd()}\n  migrate:\n    MIGRATE_ONLY: "1"\n`
    );
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
      JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
    );

    expect(await runDetachedUp({ projectRoot })).toBe(0);
    const afterUp = await readOverrideShape(projectRoot);
    expect(Object.keys(afterUp.keysByService).sort()).toEqual([
      "api",
      "migrate",
      "profiled-worker",
    ]);
    expect(afterUp.keysByService.migrate).toContain("MIGRATE_ONLY");

    runtimeCalls.length = 0;
    const code =
      targeted === "restart"
        ? await runRestart({ projectRoot, services: ["api"] })
        : await runDetachedUp({ projectRoot, services: ["api"] });
    expect(code).toBe(0);

    // The other services keep the same entries, so a later Compose command
    // that recreates them from this file declares the same env names.
    const afterTargeted = await readOverrideShape(projectRoot);
    expect(afterTargeted).toEqual(afterUp);
    // The targeted Compose spawn carries a value for every reference the
    // file uses, so a dependency Compose recreates is not left blank.
    const upCall = runtimeCalls.find((call) => call.kind === "up");
    const spawnNames = Object.keys(upCall?.opts.env ?? {});
    for (const reference of afterTargeted.references) {
      expect(spawnNames).toContain(reference);
    }
  });
}

test("a targeted restart drops the entry of a service removed from the graph (HACK-2325)", async () => {
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  expect(
    Object.keys((await readOverrideShape(projectRoot)).keysByService)
  ).toContain("profiled-worker");

  const composePath = resolve(projectRoot, ".hack", PROJECT_COMPOSE_FILENAME);
  const compose = await readFile(composePath, "utf8");
  const start = compose.indexOf("  profiled-worker:");
  await writeFile(composePath, compose.slice(0, start));

  expect(await runRestart({ projectRoot, services: ["api"] })).toBe(0);
  expect(
    Object.keys((await readOverrideShape(projectRoot)).keysByService).sort()
  ).toEqual(["api", "migrate"]);
});

test("a render with no managed env empties a stale value-free override (HACK-2325)", async () => {
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  expect(
    Object.keys((await readOverrideShape(projectRoot)).keysByService)
  ).toContain("api");

  // No service has managed env any more; only the host scope remains.
  await writeFile(
    resolve(projectRoot, ".hack/hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  host:",
      '    HOST_ONLY: "host-only"',
      "",
    ].join("\n")
  );
  expect(await runRestart({ projectRoot, services: ["api"] })).toBe(0);

  // Kept (container labels name its path) but declares no service.
  expect((await readOverrideShape(projectRoot)).keysByService).toEqual({});
});

test("targeted restart without --env keeps the recorded running overlay (HACK-2280)", async () => {
  const projectRoot = await createProject();
  const projectDir = resolve(projectRoot, ".hack");
  await writeFile(
    resolve(projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  api:",
      '    QA_ONLY: "qa"',
      "",
    ].join("\n")
  );
  await upsertProjectRuntimeStateEntry({
    projectDir,
    entry: {
      composeProject: "startup-state-test",
      envName: "qa",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  });
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );

  expect(await runRestart({ projectRoot, services: ["api"], env: null })).toBe(
    0
  );

  const upCall = runtimeCalls.find((call) => call.kind === "up");
  // Names only: the qa overlay's api-scoped key reaches the recreated api.
  expect(
    Object.keys(upCall?.opts.env ?? {}).some((key) =>
      /^HACK_ENV_[0-9A-F]{12}_QA_ONLY$/.test(key)
    )
  ).toBe(true);
  const entry = await readProjectRuntimeStateEntry({
    projectDir,
    composeProject: "startup-state-test",
  });
  expect(entry?.envName).toBe("qa");
});

test("failed targeted restart does not record its service's env as applied", async () => {
  const projectRoot = await createProject();
  const projectDir = resolve(projectRoot, ".hack");
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
  );
  const readEntry = () =>
    readProjectRuntimeStateEntry({
      projectDir,
      composeProject: "startup-state-test",
    });
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  const atUp = (await readEntry())?.envFingerprint;
  expect(atUp?.services.api).toBeDefined();

  const envPath = resolve(projectDir, "hack.env.default.yaml");
  await writeFile(
    envPath,
    (await readFile(envPath, "utf8")).replace(
      '    SHARED_MODE: "compose"',
      '    SHARED_MODE: "rotated"'
    )
  );
  upExitCode = 1;
  expect(await runRestart({ projectRoot, services: ["api"] })).not.toBe(0);

  const afterFailure = (await readEntry())?.envFingerprint;
  // The delivered env is unknown, so api's digest is dropped rather than
  // refreshed to the rotated env; exec then reports nothing for api.
  expect(
    evaluateComposeServiceEnvFreshness({
      record: afterFailure,
      service: "api",
      currentEnv: { SHARED_MODE: "rotated" },
    })
  ).toBe("unknown");
  expect(afterFailure?.salt).toBe(atUp?.salt);
  expect(afterFailure?.services.migrate).toBe(atUp?.services.migrate);
});

test("up --json emits E_STARTUP_INCOMPLETE for a created service", async () => {
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "1000";
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "created", ExitCode: 0 })
  );

  const result = await runJsonUp({ projectRoot });

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_STARTUP_INCOMPLETE",
      detail: { running: [], completed: [], failed: ["api"] },
    },
  });
});

test("up lifecycle hooks receive host overrides while compose keeps global values", async () => {
  const markerFile = resolve(tmpdir(), `hack-lifecycle-env-${Date.now()}.txt`);
  tempDirs.add(markerFile);
  const projectRoot = await createProject({ lifecycleMarkerFile: markerFile });
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(0);
  expect(await readFile(markerFile, "utf8")).toBe("host|host-only");
  expect(upEnvs).toEqual([{ SHARED_MODE: "compose" }]);
});

test("up warns before an auto-derived branch retargets the same worktree", async () => {
  const projectRoot = await createProject();
  autoBranch = "new-branch";
  runtimeProjects = [
    {
      project: "startup-state-test--old-branch",
      workingDir: resolve(projectRoot, ".hack"),
      isGlobal: false,
      services: new Map([
        [
          "api",
          {
            service: "api",
            containers: [{ state: "running" }],
          },
        ],
      ]),
    },
  ];
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(0);
  expect(warnMessages).toContain(
    'This worktree already owns "startup-state-test--old-branch" (running); auto-targeting new instance "startup-state-test--new-branch". Pass --branch <name> to target an existing instance explicitly.'
  );
});

for (const action of ["up", "restart"] as const) {
  test(`${action} uses extra hosts created and replaced by the same before hook`, async () => {
    const projectRoot = await createProject({
      lifecycleCommand:
        "mkdir -p .hack/.internal && cp hook-hosts.json .hack/.internal/extra-hosts.json",
    });
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
    );
    const run = action === "up" ? runDetachedUp : runRestart;
    for (const address of ["192.0.2.10", "192.0.2.11"]) {
      await writeFile(
        resolve(projectRoot, "hook-hosts.json"),
        JSON.stringify({ "search.example.test": address })
      );
      expect(await run({ projectRoot })).toBe(0);
      expect(upComposeContents.at(-1)).toContain(
        `search.example.test: ${address}`
      );
    }
    expect(upComposeContents.at(-1)).not.toContain("192.0.2.10");
    await writeFile(resolve(projectRoot, "hook-hosts.json"), "{}");
    expect(await run({ projectRoot })).toBe(0);
    expect(upComposeContents.at(-1)).not.toContain("search.example.test");
  });

  test(`${action} clears runtime intent when post-hook override rendering fails`, async () => {
    const projectRoot = await createProject({
      lifecycleCommand:
        "mkdir -p .hack/.internal/compose.override.yml && cp hook-hosts.json .hack/.internal/extra-hosts.json",
    });
    await writeFile(
      resolve(projectRoot, "hook-hosts.json"),
      JSON.stringify({ "search.example.test": "192.0.2.10" })
    );
    const run = action === "up" ? runDetachedUp : runRestart;
    await expect(run({ projectRoot })).rejects.toThrow();
    expect(upComposeContents).toEqual([]);
    expect(
      await readProjectRuntimeState({
        projectDir: resolve(projectRoot, ".hack"),
      })
    ).toEqual([]);
  });

  test(`${action} does not start Compose after a failing before hook`, async () => {
    const projectRoot = await createProject({ lifecycleCommand: "exit 23" });
    const run = action === "up" ? runDetachedUp : runRestart;
    expect(await run({ projectRoot })).toBe(23);
    expect(upComposeContents).toEqual([]);
  });
}

for (const action of ["up", "restart", "scoped restart"] as const) {
  const run = (projectRoot: string) =>
    action === "up"
      ? runDetachedUp({ projectRoot })
      : runRestart({
          projectRoot,
          ...(action === "scoped restart" ? { services: ["api"] } : {}),
        });

  for (const configured of [undefined, "120000"] as const) {
    test(`${action} forwards ${configured ?? "default"} startup budget to Compose`, async () => {
      if (configured !== undefined) {
        process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = configured;
      }
      const projectRoot = await createProject();
      psRows.push(
        JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
      );

      expect(await run(projectRoot)).toBe(0);
      expect(upStartupTimeouts).toEqual([
        configured === undefined ? 90_000 : 120_000,
      ]);
    });
  }

  test(`${action} rejects an invalid startup budget before hooks or backend effects`, async () => {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "0";
    const projectRoot = await createProject({
      lifecycleCommand: "touch startup-budget-hook-ran",
    });
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
    );

    await expect(run(projectRoot)).rejects.toThrow(
      "HACK_COMPOSE_STARTUP_TIMEOUT_MS"
    );
    expect(
      await Bun.file(resolve(projectRoot, "startup-budget-hook-ran")).exists()
    ).toBe(false);
    expect(upStartupTimeouts).toEqual([]);
    expect(upComposeContents).toEqual([]);
    expect(downCalls).toBe(0);
    expect(psEnvs).toEqual([]);
  });

  test(`${action} reports the effective startup budget on timeout`, async () => {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "120000";
    upExitCode = 124;
    const projectRoot = await createProject();

    expect(await run(projectRoot)).toBe(124);
    // Full restart attempts its existing repair path with a fresh equal budget.
    expect(upStartupTimeouts).toEqual(
      action === "restart" ? [120_000, 120_000] : [120_000]
    );
    expect(errorMessages.join("\n")).toContain("120000 ms");
    expect(errorMessages.join("\n")).toContain("startup budget");
  });
}

for (const action of ["up", "restart", "scoped restart"] as const) {
  const run = (projectRoot: string) =>
    action === "up"
      ? runDetachedUp({ projectRoot })
      : runRestart({
          projectRoot,
          ...(action === "scoped restart" ? { services: ["api"] } : {}),
        });

  test(`${action} forwards a separate image build/pull budget to Compose`, async () => {
    process.env.HACK_COMPOSE_IMAGE_TIMEOUT_MS = "2400000";
    const projectRoot = await createProject();
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
    );

    expect(await run(projectRoot)).toBe(0);
    expect(upImageTimeouts).toEqual([2_400_000]);
    expect(upStartupTimeouts).toEqual([90_000]);
  });

  test(`${action} names the image phase and its variable when image build/pull times out`, async () => {
    process.env.HACK_COMPOSE_IMAGE_TIMEOUT_MS = "2400000";
    upReportedPhases = ["images"];
    upExitCode = 124;
    const projectRoot = await createProject();

    expect(await run(projectRoot)).toBe(124);
    const errors = errorMessages.join("\n");
    expect(errors).toContain(
      "image build/pull budget of 2400000 ms (phase: image build/pull and container creation)"
    );
    expect(errors).toContain("HACK_COMPOSE_IMAGE_TIMEOUT_MS=<ms>");
  });

  test(`${action} names the start phase when dependency wait times out after a build`, async () => {
    upReportedPhases = ["images", "start"];
    upExitCode = 124;
    const projectRoot = await createProject();

    expect(await run(projectRoot)).toBe(124);
    const errors = errorMessages.join("\n");
    expect(errors).toContain(
      "startup budget of 90000 ms (phase: start and dependency wait)"
    );
    expect(errors).toContain("HACK_COMPOSE_STARTUP_TIMEOUT_MS=<ms>");
    expect(errors).not.toContain("HACK_COMPOSE_IMAGE_TIMEOUT_MS=<ms>");
  });

  test(`${action} rejects an invalid image budget before hooks or backend effects`, async () => {
    process.env.HACK_COMPOSE_IMAGE_TIMEOUT_MS = "soon";
    const projectRoot = await createProject({
      lifecycleCommand: "touch image-budget-hook-ran",
    });

    await expect(run(projectRoot)).rejects.toThrow(
      "HACK_COMPOSE_IMAGE_TIMEOUT_MS"
    );
    expect(
      await Bun.file(resolve(projectRoot, "image-budget-hook-ran")).exists()
    ).toBe(false);
    expect(upComposeContents).toEqual([]);
    expect(downCalls).toBe(0);
  });
}

test("up JSON reports the timed-out Compose phase and its budget", async () => {
  upReportedPhases = ["images"];
  upExitCode = 124;
  const projectRoot = await createProject();
  const result = await runJsonUp({ projectRoot });
  expect(result.exitCode).toBe(124);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_STARTUP_TIMEOUT",
      detail: {
        exitCode: 124,
        composePhase: "images",
        budgetMs: 1_800_000,
        budgetEnv: "HACK_COMPOSE_IMAGE_TIMEOUT_MS",
      },
    },
  });
});

test("foreground up ignores an invalid detached startup budget", async () => {
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "invalid";
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );

  expect(await runDetachedUp({ projectRoot, detach: false })).toBe(0);
  expect(upComposeContents).toHaveLength(1);
  expect(upDetachSelections).toEqual([false]);
  expect(errorMessages).toEqual([]);
});

test("restart preserves lifecycle failure when a before hook exits 124", async () => {
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "120000";
  const projectRoot = await createProject({ lifecycleCommand: "exit 124" });

  expect(await runRestart({ projectRoot })).toBe(124);
  expect(upComposeContents).toEqual([]);
  expect(upStartupTimeouts).toEqual([]);
  expect(errorMessages.join("\n")).toContain("lifecycle hook failed");
  expect(errorMessages.join("\n")).not.toContain("startup budget");
  expect(errorMessages.join("\n")).not.toContain(
    "process group was terminated"
  );
});

test("restart JSON classifies hook exit 124 as E_LIFECYCLE_FAILED", async () => {
  const projectRoot = await createProject({ lifecycleCommand: "exit 124" });
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  let exitCode: number;
  try {
    exitCode = await runRestart({ projectRoot, json: true });
  } finally {
    process.stdout.write = originalWrite;
  }
  expect(exitCode).toBe(124);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    error: {
      code: "E_LIFECYCLE_FAILED",
      detail: { exitCode: 124, phase: "up" },
    },
  });
  expect(upComposeContents).toEqual([]);
  expect(stdout).not.toContain("process group was terminated");
});

async function runDetachedUp(opts: {
  readonly projectRoot: string;
  readonly detach?: boolean;
  readonly profiles?: readonly string[];
  readonly services?: readonly string[];
}): Promise<number> {
  const profile = opts.profiles?.join(",");
  const input = {
    ctx: { cwd: opts.projectRoot, cli: CLI_SPEC },
    args: {
      options: {
        path: opts.projectRoot,
        project: undefined,
        env: "base",
        branch: undefined,
        detach: opts.detach ?? true,
        profile,
        target: undefined,
        json: false,
      },
      positionals: { services: opts.services ?? [] },
      raw: {
        argv: [
          "--path",
          opts.projectRoot,
          "--env",
          "base",
          ...(opts.detach === false ? [] : ["--detach"]),
          ...(profile ? ["--profile", profile] : []),
          ...(opts.services ?? []),
        ],
        positionals: opts.services ?? [],
      },
    },
  } as unknown as Parameters<typeof upCommand.handler>[0];

  return await upCommand.handler(input);
}

async function runRestart(opts: {
  readonly projectRoot: string;
  readonly json?: boolean;
  readonly profiles?: readonly string[];
  readonly services?: readonly string[];
  /** Defaults to an explicit `base`; `null` omits `--env`. */
  readonly env?: string | null;
}): Promise<number> {
  const profile = opts.profiles?.join(",");
  const env = opts.env === undefined ? "base" : (opts.env ?? undefined);
  const input = {
    ctx: { cwd: opts.projectRoot, cli: CLI_SPEC },
    args: {
      options: {
        path: opts.projectRoot,
        project: undefined,
        env,
        branch: undefined,
        profile,
        target: undefined,
        json: opts.json ?? false,
      },
      positionals: { services: opts.services ?? [] },
      raw: {
        argv: [
          "--path",
          opts.projectRoot,
          ...(env === undefined ? [] : ["--env", env]),
          ...(opts.json ? ["--json"] : []),
          ...(profile ? ["--profile", profile] : []),
          ...(opts.services ?? []),
        ],
        positionals: opts.services ?? [],
      },
    },
  } as unknown as Parameters<typeof restartCommand.handler>[0];

  return await restartCommand.handler(input);
}

async function runJsonUp(opts: {
  readonly projectRoot: string;
  readonly services?: readonly string[];
}): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    const input = {
      ctx: { cwd: opts.projectRoot, cli: CLI_SPEC },
      args: {
        options: {
          path: opts.projectRoot,
          project: undefined,
          env: "base",
          branch: undefined,
          detach: false,
          profile: undefined,
          target: undefined,
          json: true,
        },
        positionals: { services: opts.services ?? [] },
        raw: {
          argv: ["--path", opts.projectRoot, "--env", "base", "--json"],
          positionals: [],
        },
      },
    } as unknown as Parameters<typeof upCommand.handler>[0];

    return { exitCode: await upCommand.handler(input), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function createProject(opts?: {
  readonly composeProfiles?: string;
  readonly lifecycleMarkerFile?: string;
  readonly lifecycleCommand?: string;
  readonly registryTokenScope?: "api" | "deps";
}): Promise<string> {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "hack-up-startup-state-")
  );
  tempDirs.add(projectRoot);
  process.env.HACK_HOME = resolve(projectRoot, ".global-hack");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    [
      "name: startup-state-test",
      "services:",
      "  api:",
      "    image: alpine:3.20",
      "    depends_on:",
      "      migrate:",
      "        condition: service_completed_successfully",
      "  migrate:",
      "    image: alpine:3.20",
      "  profiled-worker:",
      "    image: alpine:3.20",
      "    profiles: [benchmark]",
      "    depends_on:",
      "      api:",
      "        condition: service_completed_successfully",
      ...(opts?.registryTokenScope
        ? [
            "  deps:",
            "    image: oven/bun",
            "    command: bun install --frozen-lockfile",
          ]
        : []),
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "startup-state-test",
        dev_host: "startup-state-test.hack",
        internal: { dns: false, tls: false },
        ...(opts?.lifecycleMarkerFile || opts?.lifecycleCommand
          ? {
              lifecycle: {
                up: {
                  before: [
                    {
                      name: "capture-env",
                      command:
                        opts.lifecycleCommand ??
                        `printf "%s|%s" "$SHARED_MODE" "$HOST_ONLY" > "${opts.lifecycleMarkerFile}"`,
                    },
                  ],
                  after: [],
                },
                down: { before: [], after: [] },
              },
            }
          : {}),
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    resolve(projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    SHARED_MODE: "compose"',
      ...(opts?.composeProfiles !== undefined
        ? [`    COMPOSE_PROFILES: ${JSON.stringify(opts.composeProfiles)}`]
        : []),
      "  host:",
      '    SHARED_MODE: "host"',
      '    HOST_ONLY: "host-only"',
      ...(opts?.registryTokenScope
        ? [`  ${opts.registryTokenScope}:`, '    GITHUB_TOKEN: "scoped-token"']
        : []),
      "",
    ].join("\n")
  );
  if (opts?.registryTokenScope) {
    await writeFile(
      resolve(projectRoot, ".npmrc"),
      "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n"
    );
  }
  return projectRoot;
}

test("linked startup combines inherited aliases, local static precedence and same-start hook output", async () => {
  const savedCi = process.env.CI;
  const savedMode = process.env.HACK_EXECUTION_MODE;
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  try {
    const primary = await createProject({
      lifecycleCommand:
        "mkdir -p .hack/.internal && printf '%s' '{\"hook.test\":\"192.0.2.30\"}' > .hack/.internal/extra-hosts.json",
    });
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-C", primary, ...args], {
        env: fixtureGitEnv(),
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, error] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(error);
      }
    };
    await git("init", "--quiet");
    await git("add", ".hack");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture"
    );
    const linked = resolve(primary, "linked");
    await git("worktree", "add", "--quiet", "-b", "linked", linked);
    await mkdir(resolve(primary, ".hack/.internal"), { recursive: true });
    await writeFile(
      resolve(primary, ".hack/.internal/extra-hosts.json"),
      JSON.stringify({
        "search.test": "192.0.2.10",
        "primary.test": "192.0.2.11",
      })
    );
    const configPath = resolve(linked, ".hack", PROJECT_CONFIG_FILENAME);
    const config = await Bun.file(configPath).json();
    config.internal.extra_hosts = { "search.test": "192.0.2.20" };
    await writeFile(configPath, JSON.stringify(config));
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
    );
    expect(await runDetachedUp({ projectRoot: linked })).toBe(0);
    expect(upComposeContents.at(-1)).toContain("search.test: 192.0.2.20");
    expect(upComposeContents.at(-1)).toContain("primary.test: 192.0.2.11");
    expect(upComposeContents.at(-1)).toContain("hook.test: 192.0.2.30");
    expect(upComposeContents.at(-1)).not.toContain("192.0.2.10");
  } finally {
    restoreEnv("CI", savedCi);
    restoreEnv("HACK_EXECUTION_MODE", savedMode);
  }
});

async function createCachedProject(): Promise<string> {
  const projectRoot = await createProject({ registryTokenScope: "deps" });
  const composeFile = resolve(projectRoot, ".hack", PROJECT_COMPOSE_FILENAME);
  const compose = YAML.parse(await readFile(composeFile, "utf8")) as {
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
  };
  compose.services.api!.volumes = ["dependencies:/app/node_modules"];
  compose.services.deps!.platform = "linux/arm64";
  compose.services.deps!.volumes = ["dependencies:/app/node_modules"];
  compose.services.deps!.labels = {
    "hack.dependencies.cache-volume": "dependencies",
    "hack.dependencies.bootstrap": "true",
    "hack.dependencies.lockfiles": "bun.lock",
  };
  compose.volumes = { dependencies: {} };
  await writeFile(composeFile, YAML.stringify(compose));
  await writeFile(resolve(projectRoot, "bun.lock"), "first-lock");
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  return projectRoot;
}

for (const operation of [runDetachedUp, runRestart]) {
  test(`${operation.name} initializes the selected cache before recreating a consumer`, async () => {
    const projectRoot = await createCachedProject();
    expect(await operation({ projectRoot, services: ["api"] })).toBe(0);
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["run", "up"]);
    const installer = runtimeCalls[0];
    const consumer = runtimeCalls[1];
    expect(installer?.kind).toBe("run");
    if (installer?.kind !== "run" || consumer?.kind !== "up") {
      throw new Error("Missing initialization");
    }
    expect(installer.opts.service).toBe("deps");
    expect(installer.opts.noDeps).toBe(true);
    expect(installer.opts.forwardSignals).toBe(true);
    expect(installer.opts.composeFiles).toEqual(consumer.opts.composeFiles);
    expect(installer.opts.env).toEqual(consumer.opts.env);
    expect(consumer.opts.services).toEqual(["api"]);
    const override = installer.opts.composeFiles.find((file) =>
      file.endsWith("compose.dependencies.override.yml")
    );
    expect(override).toBeDefined();
    const firstCache = await readFile(override!, "utf8");
    runtimeCalls.length = 0;
    await writeFile(resolve(projectRoot, "bun.lock"), "second-lock");
    expect(await operation({ projectRoot, services: ["api"] })).toBe(0);
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["run", "up"]);
    expect(await readFile(override!, "utf8")).not.toBe(firstCache);
  });

  test(`${operation.name} leaves consumers untouched when cache initialization fails`, async () => {
    const projectRoot = await createCachedProject();
    runExitCode = 42;
    expect(await operation({ projectRoot, services: ["api"] })).toBe(42);
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["run"]);
  });

  test(`${operation.name} does not bootstrap caches for unrelated services`, async () => {
    const projectRoot = await createCachedProject();
    psRows.length = 0;
    psRows.push(
      JSON.stringify({ Service: "migrate", State: "exited", ExitCode: 0 })
    );
    expect(await operation({ projectRoot, services: ["migrate"] })).toBe(0);
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["up"]);
  });
}

test("run deps resolves the same shared cache as up", async () => {
  const projectRoot = await createCachedProject();
  await runDetachedUp({ projectRoot, services: ["api"] });
  const up = runtimeCalls.find((call) => call.kind === "up")!;
  runtimeCalls.length = 0;
  const result = await runCommand.handler({
    ctx: { cwd: projectRoot, cli: CLI_SPEC },
    args: {
      options: { path: projectRoot, env: "base" },
      positionals: { service: "deps", cmd: [] },
      raw: { argv: [], positionals: [] },
    },
  } as unknown as Parameters<typeof runCommand.handler>[0]);
  expect(result).toBe(0);
  expect(runtimeCalls).toHaveLength(1);
  const installer = runtimeCalls[0]!;
  expect(installer.kind).toBe("run");
  const dependencyOverrides = (files: readonly string[]) =>
    files.filter((file) => file.endsWith("compose.dependencies.override.yml"));
  expect(dependencyOverrides(installer.opts.composeFiles)).toEqual(
    dependencyOverrides(up.opts.composeFiles)
  );
  expect(dependencyOverrides(installer.opts.composeFiles)).toHaveLength(1);
});

for (const operation of [runDetachedUp, runRestart]) {
  test(`${operation.name} applies configured budget to cache bootstrap before consumer launch`, async () => {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "120000";
    const projectRoot = await createCachedProject();
    expect(await operation({ projectRoot, services: ["api"] })).toBe(0);
    const bootstrap = runtimeCalls[0];
    expect(bootstrap?.kind).toBe("run");
    if (bootstrap?.kind !== "run") {
      throw new Error("Missing bootstrap");
    }
    expect(bootstrap.opts.timeoutMs).toBe(120_000);
    expect(upStartupTimeouts).toEqual([120_000]);
  });
  test(`${operation.name} reports bootstrap timeout without replacing consumers`, async () => {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "120000";
    runExitCode = 124;
    const projectRoot = await createCachedProject();
    expect(await operation({ projectRoot, services: ["api"] })).toBe(124);
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["run"]);
    expect(errorMessages.join("\n")).toContain(
      "Dependency cache initialization exceeded its startup budget of 120000 ms"
    );
  });
}

for (const action of ["up", "restart"] as const) {
  test(`${action} JSON classifies cache initializer deadline as startup timeout`, async () => {
    process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "120000";
    runExitCode = 124;
    const projectRoot = await createCachedProject();
    let output = "";
    let code: number;
    if (action === "up") {
      const result = await runJsonUp({ projectRoot, services: ["api"] });
      output = result.stdout;
      code = result.exitCode;
    } else {
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        output +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      try {
        code = await runRestart({ projectRoot, services: ["api"], json: true });
      } finally {
        process.stdout.write = write;
      }
    }
    expect(code).toBe(124);
    expect(JSON.parse(output).error.code).toBe("E_STARTUP_TIMEOUT");
    expect(JSON.parse(output).error.message).toContain("120000 ms");
    expect(runtimeCalls.map((call) => call.kind)).toEqual(["run"]);
  });
}

test("up confirms healthy Docker states after Compose consumes most of the start budget", async () => {
  const projectRoot = await createProject();
  process.env.HACK_COMPOSE_STARTUP_TIMEOUT_MS = "1000";
  upReportedPhases = ["images", "start"];
  upDurationMs = 900;
  psDurationMs = 150;
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  expect(psEnvs).toHaveLength(2);
});
test("up reports a Docker inspection error without waiting out the start budget", async () => {
  const projectRoot = await createProject();
  psExitCode = 1;
  await expect(runDetachedUp({ projectRoot })).rejects.toMatchObject({
    code: "E_DOCKER_UNAVAILABLE",
  });
  expect(psEnvs).toHaveLength(1);
});

test("a pre-create cancellation restores the previous Restart overlay before dispatch", async () => {
  const projectRoot = await createProject();
  const projectDir = resolve(projectRoot, ".hack");
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  await writeFile(
    resolve(projectDir, "hack.env.qa.yaml"),
    "version: 1\nenvironment: qa\nsecretsprovider: project_key\nvalues:\n  global:\n    SHARED_MODE: qa\n"
  );
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  const launch = { projectDir, composeProject: "startup-state-test" };
  const original = await readProjectRuntimeStateEntry(launch);
  expect(original?.envName).toBeNull();
  cancelRestartBeforeDispatch = true;
  replaceLaunchBeforeStaging = true;
  await expect(runRestart({ projectRoot, env: "qa" })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(stagedRestartOverlay).toBe("qa");
  expect(await readProjectRuntimeStateEntry(launch)).toMatchObject({
    envName: "newer",
    launchId: "newer-fixture-launch",
  });
  expect(runtimeCalls.filter((call) => call.kind === "up")).toHaveLength(1);
});

for (const action of ["up", "restart"] as const) {
  test(`${action} restores the displaced record if the daemon changes while staging`, async () => {
    const projectRoot = await createProject();
    const projectDir = resolve(projectRoot, ".hack");
    psRows.push(
      JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
    );
    activeFixtureDaemon = "fixture-one";
    expect(await runDetachedUp({ projectRoot })).toBe(0);
    const launch = { projectDir, composeProject: "startup-state-test" };
    const original = await readProjectRuntimeStateEntry(launch);
    switchDaemonAfterStaging = true;
    const attempt =
      action === "up"
        ? runDetachedUp({ projectRoot })
        : runRestart({ projectRoot });
    await expect(attempt).rejects.toMatchObject({
      code: "E_DOCKER_UNAVAILABLE",
      message: expect.stringContaining("different Docker daemon"),
    });
    expect(await readProjectRuntimeStateEntry(launch)).toEqual(original);
    expect(runtimeCalls.filter((call) => call.kind === "up")).toHaveLength(1);
  });
}

test("full restart cleans the lifecycle owner and retains the launch after a Docker inspection failure", async () => {
  const projectRoot = await createProject();
  const projectDir = resolve(projectRoot, ".hack");
  psExitCode = 1;
  await expect(runRestart({ projectRoot })).rejects.toMatchObject({
    code: "E_DOCKER_UNAVAILABLE",
  });
  // The one-shot interruption guard's read finds nothing to interrupt.
  // After dispatch, Docker inspection stays unavailable through readiness
  // and the ownership probe that would otherwise let cleanup discard the launch.
  expect(psEnvs).toHaveLength(2);
  expect(lifecycleStops.filter((entry) => entry.afterUp)).toEqual([
    {
      afterUp: true,
      hadRuntimeState: true,
      composeProject: "startup-state-test",
    },
  ]);
  expect(
    await readProjectRuntimeStateEntry({
      projectDir,
      composeProject: "startup-state-test",
    })
  ).toMatchObject({
    launchComposeBase: "startup-state-test",
    launchId: expect.any(String),
  });
});

test("a restart repair keeps the project's start ceiling", async () => {
  upExitCode = 124;
  const projectRoot = await createProject();
  const configPath = resolve(projectRoot, ".hack", PROJECT_CONFIG_FILENAME);
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, compose: { startupCeilingMs: 600_000 } })}\n`
  );

  expect(await runRestart({ projectRoot })).toBe(124);
  // The first attempt and its repair both carry the resolved ceiling.
  const ceilings = runtimeCalls.flatMap((call) =>
    call.kind === "up" ? [call.opts.startupCeilingMs] : []
  );
  expect(ceilings).toEqual([600_000, 600_000]);
});

test("a one-shot started under another profile is still seen by the restart guard", async () => {
  // A benchmark run created profiled-worker, which waits for api to complete.
  // This restart runs without the profile, but the instance still has it.
  const projectRoot = await createProject();
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 }),
    JSON.stringify({
      Service: "profiled-worker",
      State: "created",
      ExitCode: 0,
    })
  );
  const { stdout } = await captureStdout(() =>
    runRestart({ projectRoot, services: ["api"], json: true })
  );
  const envelope = JSON.parse(stdout) as {
    data?: { interrupted?: string[] };
  };
  expect(envelope.data?.interrupted).toEqual(["api"]);
});

/** HACK-2358: api binds the checkout at /app and keeps node_modules local. */
async function createLocalDirectoriesProject(
  localDirectories: unknown
): Promise<string> {
  const projectRoot = await createProject();
  const composeFile = resolve(projectRoot, ".hack", PROJECT_COMPOSE_FILENAME);
  const compose = YAML.parse(await readFile(composeFile, "utf8")) as {
    services: Record<string, Record<string, unknown>>;
  };
  compose.services.api!.volumes = ["..:/app"];
  await writeFile(composeFile, YAML.stringify(compose));
  const configPath = resolve(projectRoot, ".hack", PROJECT_CONFIG_FILENAME);
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, localDirectories })}\n`
  );
  psRows.push(
    JSON.stringify({ Service: "api", State: "running", ExitCode: 0 })
  );
  return projectRoot;
}

function localDirectoriesOverrides(files: readonly string[]): string[] {
  return files.filter((file) =>
    file.endsWith("compose.local-directories.override.yml")
  );
}

for (const operation of [runDetachedUp, runRestart]) {
  test(`${operation.name} keeps a declared local directory on a volume`, async () => {
    const projectRoot = await createLocalDirectoriesProject(["node_modules"]);
    expect(await operation({ projectRoot })).toBe(0);
    const up = runtimeCalls.find((call) => call.kind === "up");
    if (up?.kind !== "up") {
      throw new Error("Missing up");
    }
    const [override] = localDirectoriesOverrides(up.opts.composeFiles);
    expect(override).toBeDefined();
    const parsed = YAML.parse(await readFile(override!, "utf8")) as {
      services: Record<string, { volumes: Record<string, unknown>[] }>;
      volumes: Record<string, { labels: Record<string, string> }>;
    };
    const mount = parsed.services.api?.volumes[0];
    expect(mount).toMatchObject({
      type: "volume",
      target: "/app/node_modules",
    });
    expect(parsed.volumes[String(mount?.source)]?.labels).toEqual({
      "hack.local-directory": "node_modules",
      "hack.cache.disposable": "true",
    });
    // Services without a source bind are not touched.
    expect(Object.keys(parsed.services)).toEqual(["api"]);
  });
}

test("run uses the same local-directory override as up", async () => {
  const projectRoot = await createLocalDirectoriesProject(["node_modules"]);
  await runDetachedUp({ projectRoot });
  const up = runtimeCalls.find((call) => call.kind === "up")!;
  runtimeCalls.length = 0;
  const result = await runCommand.handler({
    ctx: { cwd: projectRoot, cli: CLI_SPEC },
    args: {
      options: { path: projectRoot, env: "base" },
      positionals: { service: "api", cmd: [] },
      raw: { argv: [], positionals: [] },
    },
  } as unknown as Parameters<typeof runCommand.handler>[0]);
  expect(result).toBe(0);
  const run = runtimeCalls[0]!;
  expect(localDirectoriesOverrides(run.opts.composeFiles)).toEqual(
    localDirectoriesOverrides(up.opts.composeFiles)
  );
  expect(localDirectoriesOverrides(run.opts.composeFiles)).toHaveLength(1);
});

for (const operation of [runDetachedUp, runRestart]) {
  test(`${operation.name} refuses an invalid localDirectories before anything starts or stops`, async () => {
    const projectRoot = await createLocalDirectoriesProject(["../outside"]);
    expect(await operation({ projectRoot })).toBe(1);
    // No up, and for restart no down of the running project either.
    expect(runtimeCalls).toHaveLength(0);
    expect(downCalls).toBe(0);
    // Reported once, as the refusal, not also as a parse warning.
    expect(warnMessages.some((line) => line.includes("localDirectories"))).toBe(
      false
    );
  });
}

test("a targeted restart recreates the service with the local-directory override", async () => {
  const projectRoot = await createLocalDirectoriesProject(["node_modules"]);
  expect(await runRestart({ projectRoot, services: ["api"] })).toBe(0);
  const up = runtimeCalls.find((call) => call.kind === "up");
  if (up?.kind !== "up") {
    throw new Error("Missing up");
  }
  expect(localDirectoriesOverrides(up.opts.composeFiles)).toHaveLength(1);
});

test("up says which entries it cannot keep local", async () => {
  const projectRoot = await createLocalDirectoriesProject(["node_modules"]);
  const composeFile = resolve(projectRoot, ".hack", PROJECT_COMPOSE_FILENAME);
  const compose = YAML.parse(await readFile(composeFile, "utf8")) as {
    services: Record<string, Record<string, unknown>>;
    volumes?: Record<string, unknown>;
  };
  compose.services.api!.volumes = ["..:/app", "deps:/app/node_modules"];
  compose.volumes = { deps: {} };
  await writeFile(composeFile, YAML.stringify(compose));
  expect(await runDetachedUp({ projectRoot })).toBe(0);
  expect(warnMessages).toContain(
    "localDirectories: service api already mounts /app/node_modules; that mount is kept for node_modules."
  );
});
