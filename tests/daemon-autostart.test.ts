import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutostartDependencies,
  autostartRuntimeRefusal,
  classifyAutostartContainers,
  classifyAutostartExit,
  runAutostartAtLogin,
  runAutostartSubprocess,
} from "../src/daemon/autostart.ts";
import {
  readProjectsRegistry,
  setProjectAutostartPaused,
} from "../src/lib/projects-registry.ts";

let root = "";
let registryPath = "";
let clock = 0;
let events: string[];
let starts: { id: string; at: number }[];
let deps: AutostartDependencies;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-autostart-sequence-"));
  registryPath = join(root, "projects.json");
  clock = 0;
  events = [];
  starts = [];
  deps = {
    bootId: async () => "boot-1",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    engineReady: async () => {
      events.push("engine");
      return true;
    },
    routingInstalled: async () => true,
    startRouting: async () => {
      events.push("routing");
      return true;
    },
    inspect: async () => "stopped",
    start: async (project) => {
      starts.push({ id: project.id, at: clock });
      events.push(project.id);
      return { status: "started", reason: null };
    },
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(
  names: readonly string[] = ["charlie", "alpha", "bravo"]
): Promise<void> {
  await Bun.write(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: names.map((name) => ({
        id: name,
        name,
        repoRoot: join(root, name),
        projectDir: join(root, name, ".hack"),
        projectDirName: ".hack",
        createdAt: "2026-01-01T00:00:00.000Z",
        autostart: {
          branch: null,
          paused: false,
          lastResult: null,
          lastAttemptBootId: null,
        },
      })),
    })
  );
}

async function run(signal?: AbortSignal): Promise<void> {
  await runAutostartAtLogin({ registryPath, dependencies: deps, signal });
}

async function results() {
  return (await readProjectsRegistry({ registryPath })).projects.map(
    (project) => ({ id: project.id, result: project.autostart?.lastResult })
  );
}

test("login waits for engine, restores installed routing, then starts in stable staggered order", async () => {
  await seed();
  let probes = 0;
  deps = {
    ...deps,
    engineReady: async () => {
      probes++;
      return probes === 3;
    },
  };
  await run();
  expect(events).toEqual(["routing", "alpha", "bravo", "charlie"]);
  expect(starts).toEqual([
    { id: "alpha", at: 4000 },
    { id: "bravo", at: 4500 },
    { id: "charlie", at: 5000 },
  ]);
  expect(
    (await results()).every((entry) => entry.result?.status === "started")
  ).toBe(true);
});

test("a daemon restart in the same boot never dispatches twice; a new boot can replay", async () => {
  await seed(["alpha"]);
  await run();
  await run();
  expect(events).toEqual(["engine", "routing", "alpha"]);
  deps = { ...deps, bootId: async () => "boot-2" };
  await run();
  expect(starts.map((start) => start.id)).toEqual(["alpha", "alpha"]);
});

test("paused projects and down followed by daemon restart are not started", async () => {
  await seed(["alpha", "bravo"]);
  await setProjectAutostartPaused({ id: "alpha", paused: true, registryPath });
  await run();
  expect(starts.map((start) => start.id)).toEqual(["bravo"]);
  await setProjectAutostartPaused({ id: "bravo", paused: true, registryPath });
  deps = { ...deps, bootId: async () => "boot-2" };
  await run();
  expect(starts.map((start) => start.id)).toEqual(["bravo"]);
});

test("pause while inspecting prevents dispatch", async () => {
  await seed(["alpha"]);
  deps = {
    ...deps,
    inspect: async () => {
      await setProjectAutostartPaused({
        id: "alpha",
        paused: true,
        registryPath,
      });
      return "stopped";
    },
  };
  await run();
  expect(starts).toEqual([]);
});

test("engine wait has a finite bound and records a closed skip reason", async () => {
  await seed(["alpha"]);
  deps = { ...deps, engineReady: async () => false };
  await run();
  expect(clock).toBe(60_000);
  expect(starts).toEqual([]);
  expect((await results())[0]?.result).toMatchObject({
    status: "skipped",
    reason: "engine_timeout",
  });
});

test("routing failure, unknown runtime and unavailable boot identity fail closed", async () => {
  await seed(["alpha"]);
  deps = { ...deps, startRouting: async () => false };
  await run();
  expect((await results())[0]?.result?.reason).toBe("routing_failed");
  await seed(["alpha"]);
  deps = {
    ...deps,
    routingInstalled: async () => false,
    inspect: async () => "unknown",
  };
  await run();
  expect((await results())[0]?.result?.reason).toBe("runtime_unknown");
  await seed(["alpha"]);
  deps = { ...deps, bootId: async () => null };
  await run();
  expect((await results())[0]?.result?.reason).toBe(
    "boot_identity_unavailable"
  );
  expect(starts).toEqual([]);
});

test("running projects are adopted without running up hooks again", async () => {
  await seed(["alpha"]);
  deps = { ...deps, inspect: async () => "running" };
  await run();
  expect(starts).toEqual([]);
  expect((await results())[0]?.result).toMatchObject({
    status: "already_running",
    reason: null,
  });
});

test("concurrency is capped at two while launches retain their stagger and stable order", async () => {
  await seed(["delta", "charlie", "bravo", "alpha"]);
  const releases: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  deps = {
    ...deps,
    start: async (project) => {
      active++;
      peak = Math.max(peak, active);
      starts.push({ id: project.id, at: clock });
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { status: "started", reason: null };
    },
  };
  const running = run();
  while (releases.length < 2) {
    await Bun.sleep(1);
  }
  expect(starts.map((start) => start.id)).toEqual(["alpha", "bravo"]);
  releases[0]?.();
  while (releases.length < 3) {
    await Bun.sleep(1);
  }
  expect(starts.map((start) => start.id)).toEqual([
    "alpha",
    "bravo",
    "charlie",
  ]);
  releases[1]?.();
  while (releases.length < 4) {
    await Bun.sleep(1);
  }
  releases[2]?.();
  releases[3]?.();
  await running;
  expect(peak).toBe(2);
  expect(starts.map((start) => start.at)).toEqual([0, 500, 1000, 1500]);
});

test("shutdown cancellation prevents any further launch", async () => {
  await seed(["alpha", "bravo"]);
  const abort = new AbortController();
  deps = {
    ...deps,
    start: async (project) => {
      starts.push({ id: project.id, at: clock });
      abort.abort();
      return { status: "started", reason: null };
    },
  };
  await run(abort.signal);
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
});

test("only classified safe reasons are persisted; missing keys and prompts are skipped", () => {
  for (const [code, reason] of [
    ["E_INTERACTIVE_REQUIRED", "interactive_required"],
    ["E_ENV_KEY_MISSING", "env_key_missing"],
  ] as const) {
    expect(
      classifyAutostartExit({
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code, message: "sensitive example output" },
        }),
      })
    ).toEqual({ status: "skipped", reason });
  }
  expect(
    classifyAutostartExit({ exitCode: 1, stdout: "sensitive example output" })
  ).toEqual({ status: "failed", reason: "start_failed" });
  expect(classifyAutostartExit({ exitCode: 124, stdout: "" })).toEqual({
    status: "failed",
    reason: "start_timeout",
  });
});

test("production runner has no input terminal or keychain and does not retain stderr", async () => {
  const result = await runAutostartSubprocess(
    [
      process.execPath,
      "--eval",
      `
    process.stderr.write("example-sensitive-output");
    process.stdout.write(JSON.stringify({
      input: await Bun.stdin.text(),
      tty: process.stdin.isTTY === true,
      interactive: process.env.HACK_NO_INTERACTIVE,
      keychain: process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK,
      daemon: process.env.HACK_DAEMON_AUTOSTART_DISABLE,
      login: process.env.HACK_AUTOSTART_LOGIN,
      home: process.env.HOME,
      key: process.env.HACK_ENV_SECRET_KEY ?? null,
    }));
  `,
    ],
    {
      timeoutMs: 5000,
      env: {
        HOME: root,
        HACK_HOME: join(root, "state"),
        HACK_ENV_SECRET_KEY: "synthetic-key-material",
      },
    }
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    input: "",
    tty: false,
    interactive: "1",
    keychain: "1",
    daemon: "1",
    login: "1",
    home: root,
    key: null,
  });
  expect(JSON.stringify(result)).not.toContain("example-sensitive-output");
});

test("production runner enforces output and time bounds", async () => {
  const env = { HOME: root, HACK_HOME: join(root, "state") };
  expect(
    await runAutostartSubprocess(
      [process.execPath, "--eval", 'process.stdout.write("x".repeat(70000))'],
      { timeoutMs: 5000, env }
    )
  ).toEqual({ exitCode: 124, stdout: "", reason: "output_limit" });
  expect(
    await runAutostartSubprocess(
      [process.execPath, "--eval", "await Bun.sleep(10000)"],
      { timeoutMs: 30, env }
    )
  ).toEqual({ exitCode: 124, stdout: "", reason: "start_timeout" });
});

test("migration and missing project refusals have stable safe skip reasons", () => {
  const failure = (code: string, detail?: unknown) =>
    classifyAutostartExit({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code, detail, message: "example-sensitive-output" },
      }),
    });
  expect(
    failure("E_CONFIG_INVALID", { reason: "pending_env_migration" })
  ).toEqual({ status: "skipped", reason: "pending_env_migration" });
  expect(
    failure("E_CONFIG_INVALID", { reason: "example-sensitive-output" })
  ).toEqual({ status: "failed", reason: "start_failed" });
  expect(failure("E_PROJECT_NOT_FOUND")).toEqual({
    status: "skipped",
    reason: "project_unavailable",
  });
});

test("native selection is explicitly refused before any Docker or routing probe", async () => {
  expect(
    autostartRuntimeRefusal({
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: "/fixture/runtime",
      HACK_NATIVE_HOME: "/fixture/state",
    })
  ).toBe("native_unsupported");
  expect(autostartRuntimeRefusal({ HACK_RUNTIME_BACKEND: "native" })).toBe(
    "native_unsupported"
  );
  expect(
    autostartRuntimeRefusal({ HACK_RUNTIME_BACKEND: "compose" })
  ).toBeNull();
  await seed(["alpha"]);
  deps = { ...deps, startupRefusal: () => "native_unsupported" };
  await run();
  expect(events).toEqual([]);
  expect(starts).toEqual([]);
  expect((await results())[0]?.result).toMatchObject({
    status: "skipped",
    reason: "native_unsupported",
  });
});

test("successful one-shot containers are adopted without replaying hooks", () => {
  expect(classifyAutostartContainers("running|0\nexited|0\n")).toBe("running");
  expect(classifyAutostartContainers("exited|0\n")).toBe("stopped");
  expect(classifyAutostartContainers("exited|0\nexited|0\n")).toBe("stopped");
  expect(classifyAutostartContainers("running|0\nexited|1\n")).toBe("stopped");
  expect(classifyAutostartContainers("created|0\n")).toBe("stopped");
  expect(classifyAutostartContainers("invalid response")).toBe("unknown");
  expect(classifyAutostartContainers("")).toBe("unknown");
});

test("keychain preflight and subprocess termination have distinct closed reasons", async () => {
  expect(
    classifyAutostartExit({
      exitCode: 1,
      stdout: JSON.stringify({
        error: {
          code: "E_CONFIG_INVALID",
          detail: { reason: "keychain_unavailable" },
        },
      }),
    })
  ).toEqual({ status: "skipped", reason: "keychain_unavailable" });
  for (const reason of [
    "output_limit",
    "start_timeout",
    "daemon_stopped",
  ] as const) {
    expect(
      classifyAutostartExit({ exitCode: 124, stdout: "", reason })
    ).toEqual({
      status: reason === "daemon_stopped" ? "skipped" : "failed",
      reason,
    });
  }
  const abort = new AbortController();
  abort.abort();
  expect(
    await runAutostartSubprocess(
      [process.execPath, "--eval", "throw Error('must not run')"],
      { timeoutMs: 1000, signal: abort.signal, env: { HOME: root } }
    )
  ).toEqual({ exitCode: 124, stdout: "", reason: "daemon_stopped" });
});
