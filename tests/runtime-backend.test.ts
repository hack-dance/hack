import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runCalls: string[][] = [];
const runOpts: {
  stdout?: string;
  timeoutMs?: number;
  forwardSignals?: boolean;
}[] = [];
const execCalls: string[][] = [];

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    execOrThrow: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    run: async (
      cmd: readonly string[],
      opts: {
        readonly stdout?: string;
        readonly timeoutMs?: number;
        readonly forwardSignals?: boolean;
      } = {}
    ) => {
      runCalls.push([...cmd]);
      runOpts.push({
        stdout: opts.stdout,
        timeoutMs: opts.timeoutMs,
        forwardSignals: opts.forwardSignals,
      });
      return 0;
    },
    findExecutableInPath: () => "/usr/bin/docker",
    CommandError: class CommandError extends Error {},
  },
});

async function loadComposeRuntimeBackend() {
  return (
    await import(
      `../src/backends/runtime-backend.ts?test=${Date.now()}-${Math.random()}`
    )
  ).composeRuntimeBackend;
}

/**
 * Restores a stubbed isTTY property. When the stream had no own isTTY
 * descriptor before the stub, the stubbed own property must be deleted
 * (skipping the restore would leak the stubbed value into other test files).
 */
function restoreIsTty(opts: {
  readonly stream: NodeJS.ReadStream | NodeJS.WriteStream;
  readonly descriptor: PropertyDescriptor | undefined;
}): void {
  if (opts.descriptor) {
    Object.defineProperty(opts.stream, "isTTY", opts.descriptor);
    return;
  }
  Reflect.deleteProperty(opts.stream, "isTTY");
}

beforeAll(() => {
  shellMock.activate();
});

beforeEach(() => {
  runCalls.length = 0;
  runOpts.length = 0;
  execCalls.length = 0;
});

afterAll(() => {
  shellMock.deactivate();
});

test("composeRuntimeBackend.up builds compose args with profiles and detach", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.up({
    composeFiles: ["a.yml", "b.yml"],
    composeProject: "myproj",
    profiles: ["ops"],
    detach: true,
    cwd: "/tmp",
  });

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "myproj",
    "-f",
    "a.yml",
    "-f",
    "b.yml",
    "--profile",
    "ops",
    "up",
    "-d",
  ]);
});

test("composeRuntimeBackend.up targets services without dependencies", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.up({
    composeFiles: ["docker-compose.yml"],
    composeProject: "myproj",
    profiles: [],
    detach: true,
    noDeps: true,
    forceRecreate: true,
    services: ["chat-q", "sim-runner"],
    cwd: "/tmp",
  });

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "myproj",
    "-f",
    "docker-compose.yml",
    "up",
    "-d",
    "--no-deps",
    "--force-recreate",
    "chat-q",
    "sim-runner",
  ]);
});

test("composeRuntimeBackend.down builds compose args", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.down({
    composeFiles: ["docker-compose.yml"],
    composeProject: null,
    profiles: [],
    cwd: "/tmp",
  });

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-f",
    "docker-compose.yml",
    "down",
  ]);
});

test("composeRuntimeBackend.psJson uses exec with json format", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.psJson({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: ["ops"],
    cwd: "/tmp",
  });

  expect(execCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "--profile",
    "ops",
    "ps",
    "--format",
    "json",
  ]);
});

test("composeRuntimeBackend.psJson can include non-running containers", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.psJson({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: [],
    cwd: "/tmp",
    all: true,
  });

  expect(execCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "ps",
    "--all",
    "--format",
    "json",
  ]);
});

test("composeRuntimeBackend.run supports workdir and args", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.run({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: [],
    service: "api",
    workdir: "/app",
    cmdArgs: ["bun", "dev"],
    cwd: "/tmp",
  });

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "run",
    "--rm",
    "-w",
    "/app",
    "api",
    "bun",
    "dev",
  ]);
});

test("composeRuntimeBackend.run can skip dependency startup", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.run({
    composeFiles: ["docker-compose.yml"],
    composeProject: "proj",
    profiles: [],
    service: "api",
    noDeps: true,
    cmdArgs: ["bun", "--version"],
    cwd: "/tmp",
  });

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "run",
    "--rm",
    "--no-deps",
    "api",
    "bun",
    "--version",
  ]);
});

test("composeRuntimeBackend.exec supports workdir and args", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY"
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY"
  );

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });

  try {
    const composeRuntimeBackend = await loadComposeRuntimeBackend();
    await composeRuntimeBackend.exec({
      composeFiles: ["docker-compose.yml"],
      composeProject: "proj",
      profiles: [],
      service: "api",
      workdir: "/app",
      cmdArgs: ["bun", "dev"],
      cwd: "/tmp",
    });
  } finally {
    restoreIsTty({ stream: process.stdin, descriptor: stdinDescriptor });
    restoreIsTty({ stream: process.stdout, descriptor: stdoutDescriptor });
  }

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "exec",
    "-w",
    "/app",
    "api",
    "bun",
    "dev",
  ]);
});

test("composeRuntimeBackend.exec disables TTY for non-interactive sessions", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY"
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY"
  );

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
  });

  try {
    const composeRuntimeBackend = await loadComposeRuntimeBackend();
    await composeRuntimeBackend.exec({
      composeFiles: ["docker-compose.yml"],
      composeProject: "proj",
      profiles: [],
      service: "api",
      cmdArgs: ["bun", "dev"],
      cwd: "/tmp",
    });
  } finally {
    restoreIsTty({ stream: process.stdin, descriptor: stdinDescriptor });
    restoreIsTty({ stream: process.stdout, descriptor: stdoutDescriptor });
  }

  expect(runCalls[0]).toEqual([
    "docker",
    "compose",
    "-p",
    "proj",
    "-f",
    "docker-compose.yml",
    "exec",
    "-T",
    "api",
    "bun",
    "dev",
  ]);
});

test("detached up routes stdout to stderr when requested (--json purity)", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.up({
    composeFiles: ["/tmp/compose.yml"],
    composeProject: "demo",
    detach: true,
    cwd: "/tmp",
    routeStdoutToStderr: true,
  });
  expect(runOpts[0]?.stdout).toBe("stderr");
});

test("detached up inherits stdout by default", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.up({
    composeFiles: ["/tmp/compose.yml"],
    composeProject: "demo",
    detach: true,
    cwd: "/tmp",
  });
  expect(runOpts[0]?.stdout).toBe("inherit");
});

test("down routes stdout to stderr when requested (--json purity)", async () => {
  const composeRuntimeBackend = await loadComposeRuntimeBackend();
  await composeRuntimeBackend.down({
    composeFiles: ["/tmp/compose.yml"],
    composeProject: "demo",
    cwd: "/tmp",
    routeStdoutToStderr: true,
  });
  expect(runOpts[0]?.stdout).toBe("stderr");
});

test("detached startup uses selected budget and down keeps its fixed budget", async () => {
  const backend = await loadComposeRuntimeBackend();
  const base = {
    composeFiles: ["compose.yml"],
    cwd: "/tmp",
    env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "600000" },
  };
  await backend.up({ ...base, detach: true });
  expect(runOpts[0]?.timeoutMs).toBe(600_000);
  await backend.up({ ...base, detach: true, startupTimeoutMs: 120_000 });
  expect(runOpts[1]?.timeoutMs).toBe(120_000);
  await backend.down(base);
  expect(runOpts[2]?.timeoutMs).toBe(90_000);
});

test("invalid startup budget refuses before invoking Compose", async () => {
  const backend = await loadComposeRuntimeBackend();
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/tmp",
      detach: true,
      startupTimeoutMs: 999,
    })
  ).rejects.toThrow("Compose startup timeout");
  expect(runCalls).toEqual([]);
  expect(execCalls).toEqual([]);
});

test("foreground ignores detached timeout settings and preserves child exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-foreground-budget-"));
  try {
    const docker = join(dir, "docker");
    await writeFile(docker, "#!/bin/sh\nexit 7\n");
    await chmod(docker, 0o700);
    const backend = await loadComposeRuntimeBackend();
    const code = await backend.up({
      composeFiles: ["compose.yml"],
      cwd: dir,
      detach: false,
      startupTimeoutMs: 0,
      env: { PATH: dir, HACK_COMPOSE_STARTUP_TIMEOUT_MS: "invalid" },
    });
    expect(code).toBe(7);
    expect(runCalls).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);
test("automatic bootstrap preserves output and forwards cancellation to its bounded child", async () => {
  const backend = await loadComposeRuntimeBackend();
  await backend.run({
    composeFiles: ["compose.yml"],
    cwd: "/tmp",
    service: "deps",
    cmdArgs: [],
    noDeps: true,
    timeoutMs: 600_000,
    forwardSignals: true,
    routeStdoutToStderr: true,
  });
  expect(runOpts[0]).toEqual({
    stdout: "stderr",
    timeoutMs: 600_000,
    forwardSignals: true,
  });
});
