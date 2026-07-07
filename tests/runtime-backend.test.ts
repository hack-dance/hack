import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runCalls: string[][] = [];
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
    run: async (cmd: readonly string[]) => {
      runCalls.push([...cmd]);
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
