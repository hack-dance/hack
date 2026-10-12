import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { withComposeServiceEnvFingerprints } from "../src/lib/compose-env-fingerprint.ts";
import { findProjectContextAtRoot } from "../src/lib/project.ts";
import { upsertProjectRuntimeStateEntry } from "../src/lib/project-runtime-state.ts";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const execCalls: Array<{
  readonly composeFiles: readonly string[];
  readonly env: Record<string, string> | undefined;
  readonly workdir: string | undefined;
  readonly cmdArgs: readonly string[];
}> = [];
const psJsonByComposeProject = new Map<string, string>();
const tempDirs = new Set<string>();
const originalHackHome = process.env.HACK_HOME;

const runtimeBackendMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/backends/runtime-backend.ts",
  overrides: {
    composeRuntimeBackend: {
      name: "compose",
      up: async () => 0,
      down: async () => 0,
      psJson: async (opts: { readonly composeFiles: readonly string[] }) => ({
        exitCode: 0,
        stdout: psJsonByComposeProject.get(opts.composeFiles[0] ?? "") ?? "",
        stderr: "",
      }),
      ps: async () => 0,
      run: async () => 0,
      exec: async (opts: {
        readonly composeFiles: readonly string[];
        readonly env?: Record<string, string>;
        readonly workdir?: string;
        readonly cmdArgs: readonly string[];
      }) => {
        execCalls.push({
          composeFiles: [...opts.composeFiles],
          env: opts.env ? { ...opts.env } : undefined,
          workdir: opts.workdir,
          cmdArgs: [...opts.cmdArgs],
        });
        return 0;
      },
    },
  },
});

const { execCommand, resolveModernComposeEnvOverrides } = await import(
  "../src/commands/project.ts"
);

beforeAll(() => {
  runtimeBackendMock.activate();
});

afterEach(async () => {
  execCalls.length = 0;
  psJsonByComposeProject.clear();
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  if (originalHackHome === undefined) {
    Reflect.deleteProperty(process.env, "HACK_HOME");
  } else {
    process.env.HACK_HOME = originalHackHome;
  }
});

afterAll(() => {
  runtimeBackendMock.deactivate();
});

test("exec reaches the running service while registry registration is locked", async () => {
  const projectRoot = await createProject({
    runningServices: ["api"],
    runtimeEnvName: "qa",
  });

  const registryRoot = process.env.HACK_HOME;
  if (!registryRoot) {
    throw new Error("Missing fixture HACK_HOME");
  }
  await mkdir(registryRoot, { recursive: true });
  const lockPath = resolve(registryRoot, "projects.json.lock");
  await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: "qa",
        branch: undefined,
        workdir: "/app",
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["bun", "test"],
      },
      raw: {
        argv: [
          "--path",
          projectRoot,
          "--env",
          "qa",
          "--workdir",
          "/app",
          "api",
          "bun",
          "test",
        ],
        positionals: ["api", "bun", "test"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  const exitCode = await execCommand.handler(input);

  expect(exitCode).toBe(0);
  expect(execCalls).toHaveLength(1);
  expect(await readFile(lockPath, "utf8")).toBe(`${process.pid}\n`);
  expect(await Bun.file(resolve(registryRoot, "projects.json")).exists()).toBe(
    false
  );
  expect(execCalls[0]?.env).toEqual({
    GLOBAL_FLAG: "qa",
    SHARED_KEY: "base",
  });
  expect(execCalls[0]?.workdir).toBe("/app");
  expect(execCalls[0]?.cmdArgs).toEqual(["bun", "test"]);
  expect(execCalls[0]?.composeFiles.length).toBeGreaterThanOrEqual(2);
});

test("exec rejects env mismatch against the running stack", async () => {
  const projectRoot = await createProject({
    runningServices: ["api"],
    runtimeEnvName: null,
  });

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: "qa",
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["bun", "test"],
      },
      raw: {
        argv: ["--path", projectRoot, "--env", "qa", "api", "bun", "test"],
        positionals: ["api", "bun", "test"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  await expect(execCommand.handler(input)).rejects.toThrow(
    "The running stack uses env base, but this exec request resolves to qa."
  );
  expect(execCalls).toHaveLength(0);
});

test("exec validates env mismatch against the lifecycle compose key", async () => {
  const projectRoot = await createProject({
    composeName: "Project_Exec_Test",
    runningServices: ["api"],
    runtimeComposeProject: "project-exec-test",
    runtimeEnvName: null,
  });

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: "qa",
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["bun", "test"],
      },
      raw: {
        argv: ["--path", projectRoot, "--env", "qa", "api", "bun", "test"],
        positionals: ["api", "bun", "test"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  await expect(execCommand.handler(input)).rejects.toThrow(
    "The running stack uses env base, but this exec request resolves to qa."
  );
  expect(execCalls).toHaveLength(0);
});

test("exec rejects services that are not running", async () => {
  const projectRoot = await createProject({
    runningServices: ["worker"],
    runtimeEnvName: null,
  });

  const input = {
    ctx: {
      cwd: projectRoot,
      cli: CLI_SPEC,
    },
    args: {
      options: {
        path: projectRoot,
        project: undefined,
        env: undefined,
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: {
        service: "api",
        cmd: ["bun", "test"],
      },
      raw: {
        argv: ["--path", projectRoot, "api", "bun", "test"],
        positionals: ["api", "bun", "test"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];

  await expect(execCommand.handler(input)).rejects.toThrow(
    'Service "api" is not running.'
  );
  expect(execCalls).toHaveLength(0);
});

test("exec warns value-free on stderr only after the service env changed since start", async () => {
  const projectRoot = await createProject({
    runningServices: ["api"],
    runtimeEnvName: "qa",
  });
  const project = await findProjectContextAtRoot({
    projectRoot,
    projectDirName: ".hack",
  });
  if (!project) {
    throw new Error("Expected exec fixture project context");
  }
  const atUp = await resolveModernComposeEnvOverrides({
    project,
    targetServices: ["api"],
    allServiceNames: ["api", "worker"],
    envName: "qa",
  });
  if (!atUp) {
    throw new Error("Expected modern env config");
  }
  await upsertProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    entry: {
      composeProject: "project-exec-test",
      envName: "qa",
      updatedAt: "2026-04-01T00:00:00.000Z",
      envFingerprint: withComposeServiceEnvFingerprints({
        existing: undefined,
        services: ["api"],
        envByService: atUp.preflightEnvByService,
      }),
    },
  });

  const unchanged = await captureOutput(() =>
    execCommand.handler(execInput({ projectRoot, env: "qa" }))
  );
  expect(unchanged.result).toBe(0);
  expect(unchanged.stderr).not.toContain("changed since it started");
  expect(unchanged.stdout).toBe("");

  const qaPath = resolve(project.projectDir, "hack.env.qa.yaml");
  const qaText = await readFile(qaPath, "utf8");
  await writeFile(
    qaPath,
    qaText.replace("overlay-secret", "rotated-overlay-secret")
  );
  const stale = await captureOutput(() =>
    execCommand.handler(execInput({ projectRoot, env: "qa" }))
  );
  expect(stale.result).toBe(0);
  expect(stale.stdout).toBe("");
  // Other stderr diagnostics (logger backend dependent) may precede it.
  expect(
    stale.stderr.split("\n").filter((line) => line.startsWith("WARNING: "))
  ).toEqual([
    'WARNING: Env for service "api" changed since it started; this exec uses the env it started with. Run `hack restart api` to apply the current env.',
  ]);
  for (const text of ["SERVICE_TOKEN", "overlay-secret", "rotated"]) {
    expect(stale.stderr).not.toContain(text);
  }
  expect(execCalls).toHaveLength(2);
});

function execInput(opts: {
  readonly projectRoot: string;
  readonly env: string | undefined;
}): Parameters<typeof execCommand.handler>[0] {
  const envArgs = opts.env ? ["--env", opts.env] : [];
  return {
    ctx: { cwd: opts.projectRoot, cli: CLI_SPEC },
    args: {
      options: {
        path: opts.projectRoot,
        project: undefined,
        env: opts.env,
        branch: undefined,
        workdir: undefined,
        profile: undefined,
      },
      positionals: { service: "api", cmd: ["true"] },
      raw: {
        argv: ["--path", opts.projectRoot, ...envArgs, "api", "true"],
        positionals: ["api", "true"],
      },
    },
  } as unknown as Parameters<typeof execCommand.handler>[0];
}

async function captureOutput<T>(run: () => Promise<T>): Promise<{
  readonly result: T;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await run();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

async function createProject(input?: {
  readonly composeName?: string;
  readonly runningServices?: readonly string[];
  readonly runtimeComposeProject?: string;
  readonly runtimeEnvName?: string | null;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-project-exec-"));
  tempDirs.add(root);
  process.env.HACK_HOME = resolve(root, "global-hack");

  const projectRoot = resolve(root, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  const internalDir = resolve(projectDir, ".internal");
  await mkdir(internalDir, { recursive: true });

  await writeFile(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    [
      ...(input?.composeName ? [`name: ${input.composeName}`] : []),
      "services:",
      "  api:",
      "    image: alpine:3.20",
      "  worker:",
      "    image: alpine:3.20",
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(projectDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    GLOBAL_FLAG: "base"',
      '    SHARED_KEY: "base"',
      "  api:",
      '    PORT: "3000"',
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(projectDir, "hack.env.qa.yaml"),
    [
      "version: 1",
      "environment: qa",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    GLOBAL_FLAG: "qa"',
      "  api:",
      '    SERVICE_TOKEN: "overlay-secret"',
      "",
    ].join("\n")
  );
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "project-exec-test",
        dev_host: "project-exec.hack",
      },
      null,
      2
    )}\n`
  );

  await writeFile(
    resolve(internalDir, "runtime-state.json"),
    `${JSON.stringify(
      {
        entries: [
          {
            composeProject: input?.runtimeComposeProject ?? "project-exec-test",
            envName:
              input?.runtimeEnvName === undefined ? "qa" : input.runtimeEnvName,
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      },
      null,
      2
    )}\n`
  );

  const runningServices = input?.runningServices ?? ["api"];
  psJsonByComposeProject.set(
    resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    runningServices
      .map((service) =>
        JSON.stringify({
          Service: service,
          State: "running",
          Status: "Up",
        })
      )
      .join("\n")
  );

  return projectRoot;
}
