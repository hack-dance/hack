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
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const psRows: string[] = [];
const errorMessages: string[] = [];
const warnMessages: string[] = [];
const upComposeContents: string[] = [];
const upEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
const psEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
const upDetachSelections: Array<boolean | undefined> = [];
const upStartupTimeouts: Array<number | undefined> = [];
let upExitCode = 0;
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
        runtimeCalls.push({ kind: "up", opts });
        upComposeContents.push(
          (
            await Promise.all(
              opts.composeFiles.map((path) => readFile(path, "utf8"))
            )
          ).join("\n")
        );
        upEnvs.push(opts.env);
        upServiceSelections.push(opts.services);
        upStartupTimeouts.push(opts.startupTimeoutMs);
        upDetachSelections.push(opts.detach);
        return upExitCode;
      },
      down: async () => {
        downCalls += 1;
        return 0;
      },
      psJson: async (opts: {
        readonly env?: Readonly<Record<string, string>>;
      }) => {
        psEnvs.push(opts.env);
        return {
          exitCode: 0,
          stdout: psRows.join("\n"),
          stderr: "",
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

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    findExecutableInPath: (executableName: string) =>
      executableName === "docker" ? "/usr/bin/docker" : null,
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
  branchesMock.activate();
  runtimeBackendMock.activate();
  runtimeProjectsMock.activate();
  shellMock.activate();
  loggerMock.activate();
});

beforeEach(() => {
  Reflect.deleteProperty(process.env, "HACK_COMPOSE_STARTUP_TIMEOUT_MS");
});

afterEach(async () => {
  psRows.length = 0;
  errorMessages.length = 0;
  warnMessages.length = 0;
  upEnvs.length = 0;
  upComposeContents.length = 0;
  psEnvs.length = 0;
  upServiceSelections.length = 0;
  upStartupTimeouts.length = 0;
  upDetachSelections.length = 0;
  upExitCode = 0;
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
  process.env.HACK_HOME = originalHackHome;
  if (originalComposeProfiles === undefined) {
    Reflect.deleteProperty(process.env, "COMPOSE_PROFILES");
  } else {
    process.env.COMPOSE_PROFILES = originalComposeProfiles;
  }
});

afterAll(() => {
  branchesMock.deactivate();
  runtimeBackendMock.deactivate();
  runtimeProjectsMock.deactivate();
  shellMock.deactivate();
  loggerMock.deactivate();
});

test("up returns failure when compose reports a created service after exit zero", async () => {
  const projectRoot = await createProject();
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
  const projectRoot = await createProject();

  const exitCode = await runDetachedUp({ projectRoot });

  expect(exitCode).toBe(1);
  expect(errorMessages).toContain(
    "Startup incomplete for startup-state-test: Compose reported no services after startup"
  );
});

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
  expect(psEnvs).toEqual(upEnvs);
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
  expect(psEnvs).toEqual([
    { COMPOSE_PROFILES: "benchmark", SHARED_MODE: "compose" },
  ]);
});

test("up --json emits E_STARTUP_INCOMPLETE for a created service", async () => {
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
    const state = JSON.parse(
      await readFile(
        resolve(projectRoot, ".hack/.internal/runtime-state.json"),
        "utf8"
      )
    );
    expect(state.entries).toEqual([]);
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
        profile,
        target: undefined,
        json: opts.json ?? false,
      },
      positionals: { services: opts.services ?? [] },
      raw: {
        argv: [
          "--path",
          opts.projectRoot,
          "--env",
          "base",
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
  process.env.CI = undefined;
  process.env.HACK_EXECUTION_MODE = undefined;
  try {
    const primary = await createProject({
      lifecycleCommand:
        "mkdir -p .hack/.internal && printf '%s' '{\"hook.test\":\"192.0.2.30\"}' > .hack/.internal/extra-hosts.json",
    });
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-C", primary, ...args], {
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
    process.env.CI = savedCi;
    process.env.HACK_EXECUTION_MODE = savedMode;
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
