import { afterEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeNativeFailureAfterStarted,
  type NativeLogLine,
  type NativeProjectPsResult,
  nativeProjectAllLogs,
  nativeProjectLogServices,
  nativeProjectLogs,
  nativeProjectPs,
} from "../src/backends/native-project-observe.ts";
import {
  beginNativeProjectStartupObservation,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { displayNativePs } from "../src/commands/native-ps-display.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { scopedHackCommand } from "../src/lib/printed-shell-command.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};
const id = "e".repeat(64);
function snapshot(foreground = false) {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      ...(foreground ? { relay_startup: {} } : {}),
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id,
          phase: "started",
        },
      },
    },
    journal_incomplete: false,
    observations: { "container:web": { state: "running", health: "healthy" } },
  };
}
async function fixture(saved = true) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-observe-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome);
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  if (saved) {
    await saveNativeProjectRun({ ...scope, run });
  }
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}
test("missing mapping gives native not-started without any runtime call", async () => {
  const opts = await fixture(false);
  const invoke = async () => {
    throw new Error("unexpected invoke");
  };
  expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
    backend: "native",
    status: "not_started",
    items: [],
  });
  await expect(
    nativeProjectLogs({
      ...opts,
      invoke,
      service: "web",
      follow: false,
      tail: 20,
    })
  ).rejects.toThrow("not been started");
});

test.each([
  "preparing",
  "started-observed",
])("startup ps displays only verified ports for the selected live run in %s", async (phase) => {
  const opts = await fixture(false);
  const finish = await beginNativeProjectStartupObservation(opts.scope);
  try {
    await finish.select(run);
    const observed = snapshot(true);
    observed.receipt.phase = phase;
    const invoke = async () => ({
      ...observed,
      receipt: {
        ...observed.receipt,
        resources: {
          "container:web": {
            ...observed.receipt.resources["container:web"],
            loopback_ports: [
              { host_port: 8080, target: 80 },
              { host_port: 8081, target: 81 },
            ],
          },
        },
      },
      startup_observed_ports: [8080],
    });
    expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
      run: run.run,
      phase,
      items: [{ service: "web", state: "running" }],
      ports: [{ service: "web", port: 8080, state: "observed" }],
    });
    await finish.select({ ...run, planId: "f".repeat(64) });
    expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
      status: "pending",
      items: [],
    });
  } finally {
    await finish();
  }
});
test("ps reports provider pin mismatch as its own closed status without service claims", async () => {
  const opts = await fixture();
  const result = await nativeProjectPs({
    ...opts,
    invoke: async () => {
      throw new NativeRuntimeRequestError({
        nativeCode: "provider_pin_changed",
        message: "untrusted text",
      });
    },
  });
  expect(result).toEqual({
    backend: "native",
    status: "provider_pin_changed",
    run: run.run,
    phase: null,
    items: [],
  });
});

test("a lease-busy ps still reports an authenticated pending publisher exit without guest claims", async () => {
  const opts = await fixture();
  const owner = {
    ok: true,
    run: run.run,
    plan: run.planId,
    phase: "ready-observed",
    foreground_alive: true,
    runtime_verified: false,
    runtime_error: "publisher_exit_pending",
    publisher_ports: [
      { service: "web", port: 18_080, target: 8080, state: "down" },
      { service: "healthy", port: 18_081, target: 8081, state: "observed" },
    ],
  };
  let response: unknown = owner;
  const invoke: typeof import("../src/backends/native-runtime-client.ts").invokeNativeRuntime =
    async (request) => {
      if (request.args[1] === "status") {
        throw new NativeRuntimeRequestError({
          nativeCode: "provider_busy",
          message: "busy",
        });
      }
      expect(request.args[1]).toBe("owner-status");
      return response;
    };
  expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
    status: "runtime_degraded",
    items: [],
    ports: [
      { service: "web", port: 18_080, state: "down" },
      { service: "healthy", port: 18_081, state: "unconfirmed" },
    ],
  });
  for (const changed of [
    { run: "f".repeat(32) },
    { plan: "f".repeat(64) },
    { foreground_alive: false },
    { runtime_verified: true },
    { runtime_error: "unrelated" },
    { publisher_ports: [{ ...owner.publisher_ports[0], target: -1 }] },
  ]) {
    response = { ...owner, ...changed };
    expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
      status: "runtime_busy",
      items: [],
    });
  }
}, 20_000);
test("ps returns current native observations and refuses each ownership mismatch", async () => {
  const opts = await fixture();
  expect(
    await nativeProjectPs({ ...opts, invoke: async () => snapshot() })
  ).toMatchObject({
    backend: "native",
    items: [{ service: "web", state: "running", health: "healthy" }],
  });
  for (const key of ["run", "owner", "namespace", "plan_id"]) {
    const value = snapshot();
    Object.assign(value.receipt, { [key]: "foreign" });
    await expect(
      nativeProjectPs({ ...opts, invoke: async () => value })
    ).rejects.toThrow("refused");
  }
  const value = snapshot();
  value.journal_incomplete = true;
  await expect(
    nativeProjectPs({ ...opts, invoke: async () => value })
  ).rejects.toThrow();
});
test("an owner journal transition returns busy without stale service rows", async () => {
  const opts = await fixture();
  const result = await nativeProjectPs({
    ...opts,
    invoke: async ({ args }) =>
      args[1] === "status"
        ? snapshot(true)
        : {
            ok: false,
            code: "graph_status_changed",
          },
  });
  expect(result).toEqual({
    backend: "native",
    status: "runtime_busy",
    run: run.run,
    phase: null,
    items: [],
  });
});

test("ps reports a failure after started from the receipt, value-free, and drops a malformed one", async () => {
  const opts = await fixture();
  for (const [record, want] of [
    [
      { code: "graph_timeout", service: "web", at: 1_795_000_000 },
      { code: "graph_timeout", service: "web", at: 1_795_000_000 },
    ],
    [
      { code: "graph_timeout", at: 1_795_000_000 },
      { code: "graph_timeout", at: 1_795_000_000 },
    ],
    [{ code: "Not a code", service: "web", at: 1 }, undefined],
    [{ code: "graph_timeout", service: "web/../x", at: 1 }, undefined],
    // The closed reason, with an exit code only for `exited`.
    [
      {
        code: "graph_service_failed",
        service: "web",
        at: 1,
        reason: "exited",
        exit_code: 3,
      },
      {
        code: "graph_service_failed",
        service: "web",
        at: 1,
        reason: "exited",
        exitCode: 3,
      },
    ],
    [
      { code: "graph_timeout", service: "web", at: 1, reason: "not_ready" },
      { code: "graph_timeout", service: "web", at: 1, reason: "not_ready" },
    ],
    // Every service below its goal at the deadline, in order.
    [
      {
        code: "graph_timeout",
        service: "api",
        services: ["api", "worker"],
        at: 1,
        reason: "not_ready",
      },
      {
        code: "graph_timeout",
        service: "api",
        services: ["api", "worker"],
        at: 1,
        reason: "not_ready",
      },
    ],
    // A list with an invalid name is dropped whole.
    [
      {
        code: "graph_timeout",
        service: "api",
        services: ["api", "a/b"],
        at: 1,
      },
      { code: "graph_timeout", service: "api", at: 1 },
    ],
    // An unknown reason, or an exit code without `exited`, is dropped.
    [
      { code: "graph_timeout", at: 1, reason: "crashed" },
      { code: "graph_timeout", at: 1 },
    ],
    [
      { code: "graph_timeout", at: 1, reason: "unhealthy", exit_code: 1 },
      { code: "graph_timeout", at: 1 },
    ],
  ] as const) {
    const stopped = snapshot(false);
    stopped.receipt.phase = "stopped-data-retained";
    Object.assign(stopped, { failed_after_started: record });
    const result = await nativeProjectPs({
      ...opts,
      invoke: async () => stopped,
    });
    expect(result.failure).toEqual(want);
    // One field for scripts: the failed services.
    let failed: readonly string[] | undefined;
    if (want !== undefined) {
      if ("services" in want) {
        failed = want.services;
      } else if ("service" in want) {
        failed = [want.service];
      } else {
        failed = [];
      }
    }
    expect(result.failed).toEqual(failed);
  }
  expect(
    [
      { code: "graph_service_failed", at: 1, reason: "exited", exitCode: 1 },
      { code: "graph_timeout", at: 1, reason: "not_ready" },
      { code: "graph_service_failed", at: 1, reason: "unhealthy" },
      { code: "graph_service_failed", at: 1, reason: "dead" },
      { code: "graph_route_publisher", at: 1 },
    ].map((failure) =>
      describeNativeFailureAfterStarted(
        failure as Parameters<typeof describeNativeFailureAfterStarted>[0]
      )
    )
  ).toEqual([
    "exited (1)",
    "not ready",
    "unhealthy",
    "dead",
    "graph_route_publisher",
  ]);
});

test("ps never asks the owner of a warming run, and reports it as warming", async () => {
  // The owner of a run that returned at started is still in its start loop:
  // an owner-status request here would never be answered, so this test would hang.
  const opts = await fixture();
  const calls: string[] = [];
  const warming = snapshot(true);
  warming.receipt.phase = "started-observed";
  Object.assign(warming.receipt, {
    started_from: "preparing",
    readiness: { web: "healthy" },
  });
  warming.observations["container:web"] = {
    state: "running",
    health: "starting",
  };
  const invoke = (request: { args: readonly string[] }) => {
    calls.push(request.args[1]!);
    return request.args[1] === "status"
      ? Promise.resolve(warming)
      : new Promise<never>(() => undefined);
  };
  const result = await nativeProjectPs({
    ...opts,
    invoke,
    includeReadiness: true,
  });
  expect(result).toMatchObject({
    status: "observed",
    phase: "started-observed",
    readiness: "warming",
  });
  expect(result.items[0]).toMatchObject({
    service: "web",
    state: "running",
    health: "starting",
    readiness: "healthy",
  });
  expect(calls).toEqual(["status"]);
}, 10_000);

test("ps distinguishes a live foreground owner from historical ready containers", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const owner = {
    ok: true,
    run: run.run,
    plan: run.planId,
    phase: "ready-observed",
    foreground_alive: true,
    runtime_verified: true,
  };
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push(request.args[1]!);
    return request.args[1] === "status" ? snapshot(true) : owner;
  };
  expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
    status: "observed",
    phase: "ready-observed",
  });
  expect(calls).toEqual(["status", "owner-status"]);
  const failed = await nativeProjectPs({
    ...opts,
    invoke: async (request) => {
      if (request.args[1] === "status") {
        return snapshot(true);
      }
      throw new Error("graph_owner_recovery");
    },
  });
  expect(failed).toMatchObject({
    status: "owner_unconfirmed",
    phase: "ready-observed",
    items: [{ service: "web", state: "running" }],
  });
  expect(
    await nativeProjectPs({
      ...opts,
      invoke: async (request) =>
        request.args[1] === "status"
          ? snapshot(true)
          : { ...owner, runtime_verified: false },
    })
  ).toMatchObject({ status: "runtime_degraded" });
  expect(
    await nativeProjectPs({
      ...opts,
      invoke: async (request) =>
        request.args[1] === "status"
          ? snapshot(true)
          : { ...owner, run: "foreign" },
    })
  ).toMatchObject({ status: "owner_unconfirmed" });
});

test("ps keeps current service rows and marks the reaped publisher's port down", async () => {
  const opts = await fixture();
  const current = snapshot(true);
  const value = {
    ...current,
    receipt: {
      ...current.receipt,
      readiness: { web: "started" },
      resources: {
        "container:web": {
          ...current.receipt.resources["container:web"],
          loopback_ports: [{ host_port: 18_080, target: 8080 }],
        },
      },
    },
  };
  const result = await nativeProjectPs({
    ...opts,
    includeReadiness: true,
    invoke: async (request) =>
      request.args[1] === "status"
        ? value
        : {
            ok: true,
            run: run.run,
            plan: run.planId,
            phase: "ready-observed",
            foreground_alive: true,
            runtime_verified: false,
            runtime_error: "publisher_exited",
            publisher_ports: [{ port: 18_080, state: "down" }],
          },
  });
  expect(result).toMatchObject({
    status: "runtime_degraded",
    items: [{ service: "web", state: "running", readiness: "started" }],
    ports: [{ service: "web", port: 18_080, target: 8080, state: "down" }],
  });
});

test.each([
  { command: "ps", wide: false, showsPort: false },
  { command: "ps", wide: true, showsPort: true },
  { command: "status", wide: false, showsPort: true },
])("native $command (wide=$wide) reports degraded status and a recovery command", async ({
  command,
  wide,
  showsPort,
}) => {
  const opts = await fixture();
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    '{"name":"native-observe"}'
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: example:public\n"
  );
  const current = snapshot(true);
  const inspected = {
    ...current,
    receipt: {
      ...current.receipt,
      resources: {
        "container:web": {
          ...current.receipt.resources["container:web"],
          loopback_ports: [{ host_port: 18_080, target: 8080 }],
        },
      },
    },
  };
  const owner = {
    ok: true,
    run: run.run,
    plan: run.planId,
    phase: "ready-observed",
    foreground_alive: true,
    runtime_verified: false,
    publisher_ports: [{ port: 18_080, state: "down" }],
  };
  const binary = join(opts.scope.projectRoot, "runtime");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst value = process.argv.includes("owner-status") ? ${JSON.stringify(owner)} : ${JSON.stringify(inspected)}; console.log(JSON.stringify(value));`,
    { mode: 0o700 }
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../index.ts", import.meta.url).pathname,
      command,
      ...(wide ? ["--wide"] : []),
      ...(command === "ps" ? ["--path", opts.scope.projectRoot] : []),
    ],
    {
      cwd: opts.scope.projectRoot,
      env: privateCliEnv({
        root: opts.scope.projectRoot,
        env: {
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_HOME: opts.scope.nativeHome,
          HACK_NATIVE_BINARY: binary,
          HACK_LOGGER: "console",
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout + stderr).toContain("web");
  if (showsPort) {
    expect(stdout).toMatch(/127\.0\.0\.1:18080[ (]+down/);
  } else {
    expect(stdout).not.toContain("127.0.0.1:18080");
  }
  if (command === "ps") {
    expect(stdout).toMatch(/web +no address +port-down/);
    expect(stdout).toContain(`hack down --path=${opts.scope.projectRoot}`);
  } else {
    expect(stdout + stderr).toContain("Run hack down");
  }
}, 20_000);
test("bounded logs verify current container before and after using exact CLI contract", async () => {
  const opts = await fixture();
  const calls: string[][] = [];
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push([...request.args]);
    return request.args[1] === "logs"
      ? {
          container: id,
          stdout: "application output\n",
          stderr: "",
          truncated: false,
        }
      : snapshot();
  };
  const result = await nativeProjectLogs({
    ...opts,
    invoke,
    service: "web",
    tail: 25,
    follow: false,
  });
  expect(result.stdout).toBe("application output\n");
  // The container checks around the read are lease-free (`graph status`), so a
  // warming run's owner holding the lease does not block them (PR B review, item 3).
  expect(calls.map((call) => call[1])).toEqual(["status", "logs", "status"]);
  expect(calls[1]).toEqual([
    "graph",
    "logs",
    "--run-id",
    run.run,
    "--service",
    "web",
    "--tail",
    "25",
    "--json",
  ]);
});
/** Three services: api and web have containers, a not-yet-created worker has none. */
function multiSnapshot(webId = id) {
  const apiId = "1".repeat(64);
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: webId,
          phase: "started",
        },
        "container:api": {
          kind: "container",
          key: "api",
          id: apiId,
          phase: "started",
        },
        "container:worker": {
          kind: "container",
          key: "worker",
          id: null,
          phase: "planned",
        },
      },
    },
    journal_incomplete: false,
    observations: {
      "container:web": { state: "running", health: "healthy" },
      "container:api": { state: "running" },
      "container:worker": { state: "created" },
    },
  };
}

test("logs without a service read every service with a container, in name order", async () => {
  const opts = await fixture();
  const calls: string[][] = [];
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push([...request.args]);
    if (request.args[1] !== "logs") {
      return multiSnapshot();
    }
    const service = request.args[5];
    return {
      container: service === "api" ? "1".repeat(64) : id,
      stdout: `${service} output\n`,
      stderr: "",
      truncated: service === "web",
    };
  };
  const result = await nativeProjectAllLogs({ ...opts, invoke, tail: 30 });
  expect(result.services.map((entry) => entry.service)).toEqual(["api", "web"]);
  expect(result.services.map((entry) => entry.stdout)).toEqual([
    "api output\n",
    "web output\n",
  ]);
  expect(result.services.map((entry) => entry.truncated)).toEqual([
    false,
    true,
  ]);
  expect(result.skipped).toEqual(["worker"]);
  expect(calls.map((call) => [call[1], call[5]])).toEqual([
    ["status", undefined],
    ["logs", "api"],
    ["logs", "web"],
    ["status", undefined],
  ]);
  expect(calls[1]?.slice(6)).toEqual(["--tail", "30", "--json"]);
});

test("logs without a service refuse when a container changed while reading", async () => {
  const opts = await fixture();
  let inspects = 0;
  const invoke = async (request: { args: readonly string[] }) => {
    if (request.args[1] !== "logs") {
      inspects++;
      return multiSnapshot(inspects > 1 ? "f".repeat(64) : id);
    }
    return {
      container: request.args[5] === "api" ? "1".repeat(64) : id,
      stdout: "must not return\n",
      stderr: "",
      truncated: false,
    };
  };
  await expect(
    nativeProjectAllLogs({ ...opts, invoke, tail: 30 })
  ).rejects.toThrow("Native graph observation refused");
});

test("follow without a service selects every service with a container", async () => {
  const opts = await fixture();
  const services = await nativeProjectLogServices({
    ...opts,
    invoke: async () => multiSnapshot(),
  });
  expect(services).toEqual(["api", "web"]);
});

test("follow, invalid tails and changed container refuse without returning logs", async () => {
  const opts = await fixture();
  let calls = 0;
  const invoke = async () => {
    calls++;
    return snapshot();
  };
  await expect(
    nativeProjectLogs({
      ...opts,
      invoke,
      service: "web",
      tail: 20,
      follow: true,
    })
  ).rejects.toThrow("--no-follow");
  await expect(
    nativeProjectLogs({
      ...opts,
      invoke,
      service: "web",
      tail: 1001,
      follow: false,
    })
  ).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    nativeProjectLogs({
      ...opts,
      service: "web",
      tail: 20,
      follow: false,
      invoke: async (request) =>
        request.args[1] === "logs"
          ? {
              container: "f".repeat(64),
              stdout: "must not return",
              stderr: "",
              truncated: false,
            }
          : snapshot(),
    })
  ).rejects.toThrow();
});

test("source CLI native ps reports not-started with Docker unavailable", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const opts = await fixture(false);
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    '{"name":"native-observe"}'
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: example:public\n"
  );
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "ps",
      "--path",
      opts.scope.projectRoot,
      "--json",
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: opts.scope.projectRoot,
        HACK_HOME: join(opts.scope.projectRoot, "isolated-global"),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/not-invoked",
        HACK_NATIVE_HOME: opts.scope.nativeHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: {
        backend: "native",
        status: "not_started",
        run: null,
        phase: null,
        items: [],
      },
    });
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
});
test("plain native ps warns when the foreground owner has died despite running containers", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const opts = await fixture();
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    '{"name":"native-observe"}'
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: example:public\n"
  );
  const binary = join(opts.scope.projectRoot, "fake-native");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$3" = graph ] && { [ "$4" = inspect ] || [ "$4" = status ]; }; then
  cat <<'JSON'
${JSON.stringify(snapshot(true))}
JSON
  exit 0
fi
if [ "$3" = graph ] && [ "$4" = owner-status ]; then
  echo '{"code":"graph_owner_recovery"}' >&2
  exit 1
fi
exit 2
`
  );
  await chmod(binary, 0o700);
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "ps",
      "--path",
      opts.scope.projectRoot,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: opts.scope.projectRoot,
        HACK_HOME: join(opts.scope.projectRoot, "isolated-global"),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: opts.scope.nativeHome,
        HACK_LOGGER: "console",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("web");
    expect(stdout).toContain("owner is unconfirmed");
    expect(stdout).toContain(`hack down --path=${opts.scope.projectRoot}`);
    expect(stderr).not.toContain("owner is unconfirmed");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("native admission errors and missing restart consent refuse before Docker or hooks", async () => {
  const { writeFile, readFile, chmod } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const opts = await fixture(false);
  const bin = join(opts.scope.projectRoot, "bin");
  await mkdir(bin);
  const marker = join(opts.scope.projectRoot, "effects");
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf invoked >> '${marker}'\nexit 99\n`
  );
  await chmod(join(bin, "docker"), 0o700);
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "native-test",
      startup: [`touch '${marker}'`],
      lifecycle: { up: [`touch '${marker}'`] },
    })
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: public:fixture\n"
  );
  for (const operation of ["up", "restart", "run", "exec"]) {
    const args = [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      operation,
      ...(operation === "up" ? ["--detach"] : []),
      "--path",
      opts.scope.projectRoot,
      ...(["run", "exec"].includes(operation) ? ["web", "--", "true"] : []),
    ];
    const child = Bun.spawn(args, {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: opts.scope.projectRoot,
        HACK_HOME: join(opts.scope.projectRoot, "isolated-global"),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: join(bin, "native-never-invoked"),
        HACK_NATIVE_HOME: opts.scope.nativeHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain(
        operation === "up"
          ? "E_STARTUP_INCOMPLETE: Native runtime installation could not be inspected; check the selected home's access and retry."
          : operation === "restart"
            ? "E_PERMISSION: Native restart requires HACK_NATIVE_SHARED_SOURCE=1"
            : operation === "exec"
              ? "Native project has not been started"
              : "Native run currently requires a started project"
      );
      // A known refusal is one closed line: no command help and no stack.
      expect(stdout + stderr).not.toContain("hack <command> [options]");
      expect(stdout + stderr).not.toMatch(/^\s+at /m);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
});

test("absent native selector preserves legacy command availability", async () => {
  const { requireComposeOperationAvailable } = await import(
    "../src/backends/native-project-observe.ts"
  );
  for (const operation of ["down", "restart", "run", "exec"] as const) {
    expect(() => requireComposeOperationAvailable(operation, {})).not.toThrow();
  }
});

function nativeRefusal(nativeCode: string) {
  return new NativeRuntimeRequestError({
    message: `Native runtime request failed (${nativeCode}); inspect owned state before retrying.`,
    nativeCode,
  });
}
test("ps reports a stopped runtime for an owned mapping instead of failing", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push(request.args.join(" "));
    throw nativeRefusal("runtime_not_running");
  };
  expect(await nativeProjectPs({ ...opts, invoke })).toEqual({
    backend: "native",
    status: "runtime_not_running",
    run: run.run,
    phase: null,
    items: [],
  });
  // One inspect; no owner-status or other follow-up request.
  expect(calls).toEqual([`graph status --run-id ${run.run} --json`]);
});
test("ps still fails on every other native refusal", async () => {
  const opts = await fixture();
  for (const code of ["engine_protocol", "graph_journal_incomplete"]) {
    await expect(
      nativeProjectPs({
        ...opts,
        invoke: () => Promise.reject(nativeRefusal(code)),
      })
    ).rejects.toThrow(`(${code})`);
  }
  // An unstructured failure is not a stopped runtime either.
  await expect(
    nativeProjectPs({
      ...opts,
      invoke: () => Promise.reject(new Error("runtime_not_running")),
    })
  ).rejects.toThrow("runtime_not_running");
});
test("logs refuse a stopped runtime with a closed, coded error", async () => {
  const opts = await fixture();
  const error = await nativeProjectLogs({
    ...opts,
    invoke: () => Promise.reject(nativeRefusal("runtime_not_running")),
    service: "web",
    follow: false,
    tail: 20,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toMatchObject({
    code: "E_DOCKER_UNAVAILABLE",
    message:
      "Native runtime is not running; no service logs are available. Start the native runtime and retry.",
  });
  await expect(
    nativeProjectLogs({
      ...opts,
      invoke: () => Promise.reject(nativeRefusal("engine_protocol")),
      service: "web",
      follow: false,
      tail: 20,
    })
  ).rejects.toThrow("(engine_protocol)");
});
test("ps reports a changing snapshot without taking or retrying a lease", async () => {
  const opts = await fixture();
  let calls = 0;
  const started = performance.now();
  expect(
    await nativeProjectPs({
      ...opts,
      invoke: () => {
        calls++;
        return Promise.reject(nativeRefusal("graph_status_changed"));
      },
    })
  ).toEqual({
    backend: "native",
    status: "runtime_busy",
    run: run.run,
    phase: null,
    items: [],
  });
  // One status read, then the existing pending-publisher observation.
  expect(calls).toBe(2);
  expect(performance.now() - started).toBeLessThan(10_000);
});
test("ps and logs observe after brief lease contention without failing", async () => {
  const opts = await fixture();
  let busy = 1;
  const invoke = async (request: { args: readonly string[] }) => {
    if (request.args[1] === "inspect" && busy-- > 0) {
      throw nativeRefusal("provider_busy");
    }
    if (["inspect", "status"].includes(request.args[1] ?? "")) {
      return snapshot();
    }
    return { container: id, stdout: "out\n", stderr: "", truncated: false };
  };
  expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
    status: "observed",
    items: [{ service: "web", state: "running" }],
  });
  busy = 1;
  expect(
    await nativeProjectLogs({
      ...opts,
      invoke,
      service: "web",
      follow: false,
      tail: 20,
    })
  ).toMatchObject({ stdout: "out\n" });
});
test("plain native ps explains a busy runtime and shows exit codes like Compose", async () => {
  const { writeFile, chmod } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const opts = await fixture();
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    '{"name":"native-observe"}'
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: example:public\n"
  );
  const exited = snapshot();
  exited.observations["container:web"] = {
    state: "exited",
    code: 3,
  } as never;
  const binary = join(opts.scope.projectRoot, "fake-native");
  const marker = join(opts.scope.projectRoot, "busy");
  await writeFile(
    binary,
    `#!/bin/sh
if [ -e '${marker}' ]; then
  echo '{"code":"provider_busy","message":"Another candidate operation holds the provider lock."}' >&2
  exit 2
fi
if [ "$3" = graph ] && { [ "$4" = inspect ] || [ "$4" = status ]; }; then
  cat <<'JSON'
${JSON.stringify(exited)}
JSON
  exit 0
fi
exit 2
`
  );
  await chmod(binary, 0o700);
  const ps = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../index.ts"),
        "ps",
        "--path",
        opts.scope.projectRoot,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: opts.scope.projectRoot,
          HACK_HOME: join(opts.scope.projectRoot, "isolated-global"),
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_BINARY: binary,
          HACK_NATIVE_HOME: opts.scope.nativeHome,
          HACK_LOGGER: "console",
          HACK_DAEMON_AUTOSTART_DISABLE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await child.exited;
    }
  };
  const observed = await ps();
  expect(observed.code).toBe(0);
  expect(observed.stdout).toContain("exited (3)");
  await writeFile(marker, "");
  const busy = await ps();
  expect(busy.code).toBe(0);
  expect(busy.stdout).toBe("service status is being updated\n");
  expect(busy.stderr).not.toContain("provider_busy");
}, 60_000);
test("busy native ps keeps known port failures and the exact recovery command", async () => {
  const chunks: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((line) => {
    chunks.push(String(line));
    return true;
  });
  const path = "/tmp/fixture\n";
  const recoveryCommand = scopedHackCommand("down", { path });
  try {
    await displayNativePs(
      {
        backend: "native",
        status: "runtime_busy",
        run: null,
        phase: null,
        items: [],
        ports: [{ service: "web", state: "down", port: 18_080, target: 8080 }],
      },
      false,
      { addresses: new Map(), recoveryCommand }
    );
    expect(chunks.join("")).toMatch(/web +no address +port-down/);
    expect(chunks.join("")).toContain(
      `retain data and stop with ${recoveryCommand}\n`
    );
    expect(chunks.join("")).not.toContain("0 services");
  } finally {
    stdout.mockRestore();
  }
});

test("ps names a failure after started by its reason, and --json carries the failed services", async () => {
  const chunks: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const result: NativeProjectPsResult = {
    backend: "native",
    status: "observed",
    run: run.run,
    phase: "stopped-data-retained",
    items: [],
    failure: {
      code: "graph_service_failed",
      service: "api",
      at: 1,
      reason: "exited",
      exitCode: 1,
    },
    failed: ["api"],
  };
  try {
    await displayNativePs(result, false, { addresses: new Map() });
    const text = chunks.join("");
    expect(text).toContain("exited (1) after up returned");
    expect(text).toContain("hack logs api");
    chunks.length = 0;
    await displayNativePs(result, true, { addresses: new Map() });
    expect(JSON.parse(chunks.join("")).data.failed).toEqual(["api"]);
  } finally {
    stdout.mockRestore();
  }
});

test("logs keep the runtime's interleaved whole lines and refuse malformed ones", async () => {
  const opts = await fixture();
  const lines: NativeLogLine[] = [
    { stream: "stdout", text: "starting\n" },
    { stream: "stderr", text: "warning\n" },
    { stream: "stdout", text: "ready\n" },
  ];
  const reply =
    (extra: Record<string, unknown>) =>
    async (request: { args: readonly string[] }) =>
      request.args[1] === "logs"
        ? {
            container: id,
            stdout: "starting\nready\n",
            stderr: "warning\n",
            truncated: false,
            ...extra,
          }
        : snapshot();
  const logs = (invoke: ReturnType<typeof reply>) =>
    nativeProjectLogs({
      ...opts,
      invoke,
      service: "web",
      tail: 20,
      follow: false,
    });
  expect((await logs(reply({ lines }))).lines).toEqual(lines);
  // An older runtime without engine order keeps stdout before stderr.
  expect((await logs(reply({}))).lines).toEqual([
    { stream: "stdout", text: "starting\nready\n" },
    { stream: "stderr", text: "warning\n" },
  ]);
  for (const malformed of [
    "not-a-list",
    [{ stream: "stdin", text: "x" }],
    [{ stream: "stdout", text: 1 }],
  ]) {
    await expect(logs(reply({ lines: malformed }))).rejects.toThrow(
      "observation refused"
    );
  }
});

test("pending startup evidence is branch scoped and each invocation retires only its marker", async () => {
  const opts = await fixture(false);
  const first = await beginNativeProjectStartupObservation(opts.scope);
  const second = await beginNativeProjectStartupObservation(opts.scope);
  expect((await nativeProjectPs(opts)).status).toBe("pending");
  expect(
    (
      await nativeProjectPs({
        ...opts,
        scope: { ...opts.scope, branch: "other" },
      })
    ).status
  ).toBe("not_started");
  await first();
  expect((await nativeProjectPs(opts)).status).toBe("pending");
  await second();
  expect((await nativeProjectPs(opts)).status).toBe("not_started");
});

test("startup completion preserves a substituted observation marker", async () => {
  const opts = await fixture(false);
  const finish = await beginNativeProjectStartupObservation(opts.scope);
  const directory = join(opts.scope.projectDir, ".internal", "native-runs");
  const marker = (await readdir(directory)).find((name) =>
    name.includes(".starting-")
  );
  expect(marker).toBeDefined();
  const path = join(directory, marker!);
  await rename(path, `${path}.original`);
  await writeFile(path, "replacement owned by another writer\n");
  await finish();
  await finish();
  expect(await readFile(path, "utf8")).toBe(
    "replacement owned by another writer\n"
  );
});

test("internal readiness admission reads only closed goals from the owned receipt; ordinary ps output stays unchanged", async () => {
  const opts = await fixture();
  for (const readiness of [
    "completed",
    "started",
    "healthy",
    "unknown",
    undefined,
  ] as const) {
    const observed = snapshot();
    const reply = {
      ...observed,
      receipt: { ...observed.receipt, readiness: { web: readiness } },
    };
    const ordinary = await nativeProjectPs({
      ...opts,
      invoke: async () => reply,
    });
    expect(ordinary.items[0]).not.toHaveProperty("readiness");
    const internal = await nativeProjectPs({
      ...opts,
      includeReadiness: true,
      invoke: async () => reply,
    });
    expect(internal.items[0]?.readiness).toBe(
      readiness === "unknown" ? undefined : readiness
    );
  }
});

test("native image pins and resolution times appear only in wide text and JSON", async () => {
  const chunks: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((line) => {
    chunks.push(String(line));
    return true;
  });
  const result: Parameters<typeof displayNativePs>[0] = {
    backend: "native",
    status: "runtime_busy",
    run: null,
    phase: null,
    items: [],
    imageTags: [
      {
        reference: "example.invalid/sample:latest",
        registry: "example.invalid",
        source_digest: "sha256:fixture",
        resolved_at_unix_seconds: 1,
        aliases: [],
        selections: [
          { policy: "local", platform: "linux/arm64", image_id: "fixture" },
        ],
      },
    ],
  };
  try {
    const addresses = new Map<string, readonly string[]>();
    await displayNativePs(result, false, { addresses });
    expect(chunks.join("")).toBe("service status is being updated\n");
    chunks.length = 0;
    await displayNativePs(result, false, { addresses, wide: true });
    expect(chunks.join("")).toContain("RESOLVED AT");
    expect(chunks.join("")).toContain("sha256:fixture");
    expect(chunks.join("")).toContain("1970-01-01T00:00:01.000Z");
    chunks.length = 0;
    await displayNativePs(result, true, { addresses });
    expect(JSON.parse(chunks.join("")).data.imageTags).toEqual(
      result.imageTags
    );
  } finally {
    stdout.mockRestore();
  }
});
