import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

const runCalls: string[][] = [];
const runResults: number[] = [];
const runOpts: {
  stdout?: string;
  timeoutMs?: number;
  forwardSignals?: boolean;
  settleProcessGroupOnCancel?: boolean;
}[] = [];
const execCalls: string[][] = [];
const execResults: { exitCode: number; stdout: string; stderr: string }[] = [];

const shellMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/lib/shell.ts",
  overrides: {
    exec: async (cmd: readonly string[]) => {
      execCalls.push([...cmd]);
      return (
        execResults.shift() ?? {
          exitCode: 0,
          stdout: cmd.includes("config")
            ? JSON.stringify({ name: "fixture", services: {} })
            : "",
          stderr: "",
        }
      );
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
        readonly settleProcessGroupOnCancel?: boolean;
      } = {}
    ) => {
      runCalls.push([...cmd]);
      runOpts.push({
        stdout: opts.stdout,
        timeoutMs: opts.timeoutMs,
        forwardSignals: opts.forwardSignals,
        settleProcessGroupOnCancel: opts.settleProcessGroupOnCancel,
      });
      return runResults.shift() ?? 0;
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
  runResults.length = 0;
  runOpts.length = 0;
  execCalls.length = 0;
  execResults.length = 0;
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

  const base = [
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
  ];
  expect(runOpts.map((options) => options.forwardSignals)).toEqual([
    true,
    true,
  ]);
  expect(runOpts.map((options) => options.settleProcessGroupOnCancel)).toEqual([
    true,
    true,
  ]);
  // Image build/pull and container creation, then start and dependency wait.
  expect(runCalls).toEqual([
    [...base, "up", "--no-start"],
    [...base, "up", "-d", "--no-build"],
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

  const base = [
    "docker",
    "compose",
    "-p",
    "myproj",
    "-f",
    "docker-compose.yml",
  ];
  // Recreation happens once, in the image phase; the start phase only starts.
  expect(runCalls).toEqual([
    [
      ...base,
      "up",
      "--no-start",
      "--force-recreate",
      "--no-deps",
      "chat-q",
      "sim-runner",
    ],
    [...base, "up", "-d", "--no-build", "--no-deps", "chat-q", "sim-runner"],
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
  // The image phase keeps its own default; only the start phase uses this.
  expect(runOpts.map((opts) => opts.timeoutMs)).toEqual([1_800_000, 600_000]);
  await backend.up({
    ...base,
    detach: true,
    startupTimeoutMs: 120_000,
    imageTimeoutMs: 2_400_000,
  });
  expect(runOpts.slice(2).map((opts) => opts.timeoutMs)).toEqual([
    2_400_000, 120_000,
  ]);
  await backend.down(base);
  expect(runOpts[4]?.timeoutMs).toBe(90_000);
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
    settleProcessGroupOnCancel: undefined,
  });
});

test("unattended detached startup rechecks intent before preparation and disables builds, pulls and implicit dotenv", async () => {
  const backend = await loadComposeRuntimeBackend();
  const observations: number[] = [];
  const code = await backend.up({
    composeFiles: ["compose.yml"],
    cwd: "/fixture",
    detach: true,
    unattended: true,
    beforeStart: async () => {
      observations.push(runCalls.length);
    },
  });
  expect(code).toBe(0);
  expect(observations).toEqual([0, 0, 1]);
  expect(runCalls).toEqual([
    [
      "docker",
      "compose",
      "-f",
      "compose.yml",
      "--env-file",
      "/dev/null",
      "up",
      "--no-start",
      "--no-build",
      "--pull",
      "never",
    ],
    [
      "docker",
      "compose",
      "-f",
      "compose.yml",
      "--env-file",
      "/dev/null",
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
    ],
  ]);
});

test("withdrawn unattended intent refuses before create, pull or build phases", async () => {
  const backend = await loadComposeRuntimeBackend();
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
      beforeStart: async () => {
        throw new Error("paused before preparation");
      },
    })
  ).rejects.toThrow("paused before preparation");
  expect(runCalls).toEqual([]);
});

test("only an exact missing image diagnostic authorizes an unattended manual-start refusal", async () => {
  const backend = await loadComposeRuntimeBackend();
  execResults.push(
    {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "fixture",
        services: { app: { image: "example.invalid/app" } },
      }),
      stderr: "",
    },
    {
      exitCode: 1,
      stdout: "",
      stderr:
        "Error response from daemon: No such image: example.invalid/app:latest\n",
    }
  );
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "image_requires_manual_start" },
  });
  expect(runCalls).toEqual([]);
  expect(execCalls[1]).toEqual([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    "example.invalid/app:latest",
  ]);
});

test("images present plus a failed prepare phase remains an ordinary claimed failure", async () => {
  const backend = await loadComposeRuntimeBackend();
  execResults.push(
    {
      exitCode: 0,
      stdout: JSON.stringify({
        name: "fixture",
        services: { app: { image: "example.invalid/app" } },
      }),
      stderr: "",
    },
    { exitCode: 0, stdout: `sha256:${"a".repeat(64)}\n`, stderr: "" }
  );
  runResults.push(17);
  expect(
    await backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
    })
  ).toBe(17);
  expect(runCalls).toHaveLength(1);
});

for (const diagnostic of [
  "Cannot connect to the Docker daemon",
  "Error response from daemon: unauthorized",
  "Error response from daemon: No such image: another.invalid/image:latest",
  "Error response from daemon: No such image: example.invalid/app:latest\nextra diagnostic",
]) {
  test(`image inspection refuses unknown errors without a neutral missing-image result: ${diagnostic.split("\n")[0]}`, async () => {
    const backend = await loadComposeRuntimeBackend();
    execResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          name: "fixture",
          services: { app: { image: "example.invalid/app" } },
        }),
        stderr: "",
      },
      { exitCode: 1, stdout: "", stderr: diagnostic }
    );
    expect(
      await backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
      })
    ).toBe(1);
    expect(runCalls).toEqual([]);
  });
}

for (const cancellation of [124, 130, 143]) {
  test(`unattended preparation preserves cancellation exit ${cancellation} without a start phase`, async () => {
    const backend = await loadComposeRuntimeBackend();
    runResults.push(cancellation);
    expect(
      await backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
      })
    ).toBe(cancellation);
    expect(runCalls).toHaveLength(1);
    expect(runOpts[0]?.settleProcessGroupOnCancel).toBe(true);
  });
}

test("attached unattended startup refuses before invoking Compose", async () => {
  const backend = await loadComposeRuntimeBackend();
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: false,
      unattended: true,
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "unattended_requires_detached" },
  });
  expect(runCalls).toEqual([]);
});

function ordinaryVolumeModel(
  mount: unknown = { type: "volume", source: "data", target: "/data" }
) {
  return {
    name: "fixture",
    services: { app: { image: "example.invalid/app", volumes: [mount] } },
    volumes: { data: { name: "fixture_data" } },
  };
}
function existingVolume(
  options: unknown = null,
  labels: unknown = {
    "com.docker.compose.project": "fixture",
    "com.docker.compose.volume": "data",
  }
) {
  return {
    Name: "fixture_data",
    Driver: "local",
    Options: options,
    Labels: labels,
  };
}
function queueModelAndImage(model: unknown) {
  execResults.push(
    { exitCode: 0, stdout: JSON.stringify(model), stderr: "" },
    { exitCode: 0, stdout: `sha256:${"a".repeat(64)}\n`, stderr: "" }
  );
}
function queueVolume(value: unknown) {
  execResults.push({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
}

for (const badVolume of [
  existingVolume({ device: "/host/private", o: "bind", type: "none" }),
  existingVolume(null, null),
  existingVolume(null, {
    "com.docker.compose.project": "other",
    "com.docker.compose.volume": "data",
  }),
  { ...existingVolume(), Driver: "custom" },
]) {
  test("unattended runtime refuses unsafe existing named-volume options or ownership labels before up", async () => {
    const backend = await loadComposeRuntimeBackend();
    queueModelAndImage(ordinaryVolumeModel());
    queueVolume(badVolume);
    await expect(
      backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
      })
    ).rejects.toMatchObject({
      code: "E_PERMISSION",
      detail: { reason: "compose_inputs_require_manual_start" },
    });
    expect(runCalls).toEqual([]);
  });
}
for (const options of [null, {}]) {
  test("an ordinary Compose-owned local named volume is checked before create and start", async () => {
    const backend = await loadComposeRuntimeBackend();
    queueModelAndImage(ordinaryVolumeModel());
    queueVolume(existingVolume(options));
    queueVolume(existingVolume(options));
    expect(
      await backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
      })
    ).toBe(0);
    expect(execCalls.filter((args) => args[1] === "volume")).toHaveLength(2);
    expect(runCalls).toHaveLength(2);
  });
}

test("a missing default local named volume is eligible to create only on an exact expected-name diagnostic", async () => {
  const backend = await loadComposeRuntimeBackend();
  queueModelAndImage(ordinaryVolumeModel());
  execResults.push({
    exitCode: 1,
    stdout: "",
    stderr: "Error response from daemon: get fixture_data: no such volume\n",
  });
  queueVolume(existingVolume());
  expect(
    await backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
    })
  ).toBe(0);
  expect(runCalls).toHaveLength(2);
});
for (const message of [
  "Cannot connect to the Docker daemon",
  "Error response from daemon: unauthorized",
  "Error response from daemon: get other: no such volume",
]) {
  test("unknown volume probe errors remain claimed failures without preparation", async () => {
    const backend = await loadComposeRuntimeBackend();
    queueModelAndImage(ordinaryVolumeModel());
    execResults.push({ exitCode: 1, stdout: "", stderr: message });
    expect(
      await backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
      })
    ).toBe(1);
    expect(runCalls).toEqual([]);
  });
}

test("a generated resolved bind is refused even when the primary authored model had only an ordinary volume", async () => {
  const backend = await loadComposeRuntimeBackend();
  execResults.push({
    exitCode: 0,
    stdout: JSON.stringify(
      ordinaryVolumeModel({
        type: "bind",
        source: "/host/private",
        target: "/data",
        read_only: true,
      })
    ),
    stderr: "",
  });
  await expect(
    backend.up({
      composeFiles: ["compose.yml", "generated.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "compose_inputs_require_manual_start" },
  });
  expect(runCalls).toEqual([]);
  expect(execCalls).toHaveLength(1);
});

test("anonymous volumes and tmpfs do not require a named-volume inspection", async () => {
  const backend = await loadComposeRuntimeBackend();
  queueModelAndImage({
    name: "fixture",
    services: {
      app: {
        image: "example.invalid/app",
        volumes: [
          { type: "volume", target: "/data" },
          { type: "tmpfs", target: "/tmp" },
        ],
      },
    },
  });
  expect(
    await backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
    })
  ).toBe(0);
  expect(execCalls).toHaveLength(2);
});

const trustedTls = {
  source: "/trusted/caddy/root.crt",
  target: "/etc/hack/ca/caddy-local-authority.crt",
  readOnly: true,
} as const;
function tlsModel(readOnly = true) {
  return {
    name: "fixture",
    services: {
      app: {
        image: "example.invalid/app",
        volumes: [
          {
            type: "bind",
            source: trustedTls.source,
            target: trustedTls.target,
            read_only: readOnly,
            bind: { create_host_path: true },
          },
        ],
      },
    },
  };
}
test("only exact read-only authenticated machine TLS binds survive resolved-model checks", async () => {
  const backend = await loadComposeRuntimeBackend();
  queueModelAndImage(tlsModel());
  let authenticated = 0;
  expect(
    await backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
      unattendedTrustedBinds: async () => {
        authenticated += 1;
        return [trustedTls];
      },
    })
  ).toBe(0);
  expect(authenticated).toBe(3);
  expect(runCalls).toHaveLength(2);
});
test("an approved TLS source must still authenticate at the create boundary", async () => {
  const backend = await loadComposeRuntimeBackend();
  queueModelAndImage(tlsModel());
  let authenticated = 0;
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
      unattendedTrustedBinds: async () =>
        ++authenticated === 1 ? [trustedTls] : [],
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "compose_inputs_require_manual_start" },
  });
  expect(runCalls).toEqual([]);
});
test("a writable bind cannot borrow the authenticated TLS allowlist", async () => {
  const backend = await loadComposeRuntimeBackend();
  execResults.push({
    exitCode: 0,
    stdout: JSON.stringify(tlsModel(false)),
    stderr: "",
  });
  await expect(
    backend.up({
      composeFiles: ["compose.yml"],
      cwd: "/fixture",
      detach: true,
      unattended: true,
      unattendedTrustedBinds: async () => [trustedTls],
    })
  ).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "compose_inputs_require_manual_start" },
  });
  expect(runCalls).toEqual([]);
});

for (const withVolume of [false, true]) {
  test("unused installed TLS state cannot reject an unattended model without binds", async () => {
    const backend = await loadComposeRuntimeBackend();
    queueModelAndImage(
      withVolume
        ? ordinaryVolumeModel()
        : {
            name: "fixture",
            services: { app: { image: "example.invalid/app" } },
          }
    );
    if (withVolume) {
      queueVolume(existingVolume());
      queueVolume(existingVolume());
    }
    let authCalls = 0;
    expect(
      await backend.up({
        composeFiles: ["compose.yml"],
        cwd: "/fixture",
        detach: true,
        unattended: true,
        unattendedTrustedBinds: async () => {
          authCalls += 1;
          throw new Error("unused TLS installation is unsafe");
        },
      })
    ).toBe(0);
    expect(authCalls).toBe(0);
  });
}
