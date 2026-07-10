import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const psRows: string[] = [];
const errorMessages: string[] = [];
const warnMessages: string[] = [];
const upEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
const upServiceSelections: Array<readonly string[] | undefined> = [];
const tempDirs = new Set<string>();
const originalHackHome = process.env.HACK_HOME;
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
      up: async (opts: {
        readonly env?: Readonly<Record<string, string>>;
        readonly services?: readonly string[];
      }) => {
        upEnvs.push(opts.env);
        upServiceSelections.push(opts.services);
        return 0;
      },
      down: async () => 0,
      psJson: async () => ({
        exitCode: 0,
        stdout: psRows.join("\n"),
        stderr: "",
      }),
      ps: async () => 0,
      run: async () => 0,
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

const { restartCommand, upCommand } = await import(
  "../src/commands/project.ts"
);

beforeAll(() => {
  branchesMock.activate();
  runtimeBackendMock.activate();
  runtimeProjectsMock.activate();
  shellMock.activate();
  loggerMock.activate();
});

afterEach(async () => {
  psRows.length = 0;
  errorMessages.length = 0;
  warnMessages.length = 0;
  upEnvs.length = 0;
  upServiceSelections.length = 0;
  autoBranch = null;
  runtimeProjects = [];
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  process.env.HACK_HOME = originalHackHome;
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

async function runDetachedUp(opts: {
  readonly projectRoot: string;
  readonly profiles?: readonly string[];
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
        detach: true,
        profile,
        target: undefined,
        json: false,
      },
      positionals: {},
      raw: {
        argv: [
          "--path",
          opts.projectRoot,
          "--env",
          "base",
          "--detach",
          ...(profile ? ["--profile", profile] : []),
        ],
        positionals: [],
      },
    },
  } as unknown as Parameters<typeof upCommand.handler>[0];

  return await upCommand.handler(input);
}

async function runRestart(opts: {
  readonly projectRoot: string;
}): Promise<number> {
  const input = {
    ctx: { cwd: opts.projectRoot, cli: CLI_SPEC },
    args: {
      options: {
        path: opts.projectRoot,
        project: undefined,
        env: "base",
        branch: undefined,
        profile: undefined,
        target: undefined,
        json: false,
      },
      positionals: {},
      raw: {
        argv: ["--path", opts.projectRoot, "--env", "base"],
        positionals: [],
      },
    },
  } as unknown as Parameters<typeof restartCommand.handler>[0];

  return await restartCommand.handler(input);
}

async function runJsonUp(opts: {
  readonly projectRoot: string;
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
        positionals: {},
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
  readonly lifecycleMarkerFile?: string;
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
        ...(opts?.lifecycleMarkerFile
          ? {
              lifecycle: {
                up: {
                  before: [
                    {
                      name: "capture-env",
                      command: `printf "%s|%s" "$SHARED_MODE" "$HOST_ONLY" > "${opts.lifecycleMarkerFile}"`,
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
