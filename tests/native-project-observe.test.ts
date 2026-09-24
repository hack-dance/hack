import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeProjectLogs,
  nativeProjectPs,
} from "../src/backends/native-project-observe.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";

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
    return request.args[1] === "inspect" ? snapshot(true) : owner;
  };
  expect(await nativeProjectPs({ ...opts, invoke })).toMatchObject({
    status: "observed",
    phase: "ready-observed",
  });
  expect(calls).toEqual(["inspect", "owner-status"]);
  const failed = await nativeProjectPs({
    ...opts,
    invoke: async (request) => {
      if (request.args[1] === "inspect") {
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
        request.args[1] === "inspect"
          ? snapshot(true)
          : { ...owner, runtime_verified: false },
    })
  ).toMatchObject({ status: "runtime_degraded" });
  expect(
    await nativeProjectPs({
      ...opts,
      invoke: async (request) =>
        request.args[1] === "inspect"
          ? snapshot(true)
          : { ...owner, run: "foreign" },
    })
  ).toMatchObject({ status: "owner_unconfirmed" });
});
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
  expect(calls.map((call) => call[1])).toEqual(["inspect", "logs", "inspect"]);
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
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "native",
      status: "not_started",
      items: [],
    });
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("unsupported native forms and missing restart consent refuse before Docker or hooks", async () => {
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
          ? "foreground whole-project startup only"
          : operation === "restart"
            ? "Native restart requires HACK_NATIVE_SHARED_SOURCE=1"
            : operation === "exec"
              ? "Native project has not been started"
              : "Native run currently requires a started project"
      );
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
