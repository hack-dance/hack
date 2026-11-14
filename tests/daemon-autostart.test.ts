import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutostartDependencies,
  autostartComposeModel,
  autostartRoutingInstalled,
  autostartRuntimeRefusal,
  autostartServiceEnvironment,
  autostartServicePath,
  buildAutostartProjectInvocation,
  canAdoptAutostartEnvironment,
  classifyAutostartContainers,
  classifyAutostartExit,
  completedDependencyServices,
  createAutostartProductionDependencies,
  resolveAutostartEngineWaitMs,
  runAutostartAtLogin,
  runAutostartSubprocess,
} from "../src/daemon/autostart.ts";
import { assertAutostartExecutablePathTrusted } from "../src/lib/autostart-executable-trust.ts";
import {
  beginAutostartLoginRun,
  claimProjectAutostart,
  readAutostartGlobal,
  readProjectsRegistry,
  removeProjectAutostart,
  setAutostartGlobalPaused,
  setProjectAutostart,
  setProjectAutostartPaused,
} from "../src/lib/projects-registry.ts";

let root = "";
let registryPath = "";
let clock = 0;
let events: string[];
let starts: { id: string; at: number }[];
let deps: AutostartDependencies;

test("declared replica counts require ordinary up rather than partial adoption", () => {
  for (const count of [0, 1, 2, "${REPLICAS}"]) {
    for (const settings of [
      { scale: count },
      { deploy: { replicas: count } },
    ]) {
      expect(
        autostartComposeModel({
          services: { web: { image: "example", ...settings } },
        })
      ).toBeNull();
    }
  }
});

test("routing installation probe uses the installed Caddy Compose path", async () => {
  expect(await autostartRoutingInstalled(root)).toBe(false);
  await mkdir(join(root, "caddy"));
  await Bun.write(join(root, "caddy", "docker-compose.yml"), "services: {}\n");
  expect(await autostartRoutingInstalled(root)).toBe(true);
});

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
  await chmod(registryPath, 0o600);
}

async function run(signal?: AbortSignal) {
  return await runAutostartAtLogin({
    registryPath,
    dependencies: deps,
    signal,
  });
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
    { id: "alpha", at: 6000 },
    { id: "bravo", at: 6500 },
    { id: "charlie", at: 7000 },
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

test("an untrusted registry cannot trigger even an engine probe or start", async () => {
  await seed(["alpha"]);
  await chmod(registryPath, 0o660);
  await expect(run()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(events).toEqual([]);
  expect(starts).toEqual([]);
});

test("trust is rechecked after observation immediately before dispatch", async () => {
  await seed(["alpha"]);
  deps = {
    ...deps,
    inspect: async () => {
      await chmod(registryPath, 0o660);
      return "stopped";
    },
  };
  await expect(run()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(starts).toEqual([]);
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
  expect((await readAutostartGlobal({ registryPath })).loginRun.failed).toEqual(
    []
  );
});

test("engine wait uses bounded exponential backoff and leaves attempts unclaimed for a later pass", async () => {
  await seed(["alpha"]);
  const delays: number[] = [];
  deps = {
    ...deps,
    engineReady: async () => false,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
    },
  };
  expect(await run()).toEqual({ waitingForEngine: true });
  expect(clock).toBe(600_000);
  expect(delays.slice(0, 5)).toEqual([2000, 4000, 8000, 16_000, 30_000]);
  expect(Math.max(...delays)).toBe(30_000);
  expect(starts).toEqual([]);
  const project = (await readProjectsRegistry({ registryPath })).projects[0];
  expect(project?.autostart?.lastAttemptBootId).toBeNull();
  expect(project?.autostart?.lastResult).toBeNull();
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    inProgress: false,
    waitingForEngine: true,
    pending: ["alpha"],
    failed: [],
  });
  deps = { ...deps, engineReady: async () => true };
  expect(await run()).toEqual({ waitingForEngine: false });
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    inProgress: false,
    waitingForEngine: false,
    pending: [],
    started: ["alpha"],
    failed: [],
  });
});

test("a failed boot probe preserves prior claims and cannot authorize replay when identity recovers", async () => {
  await seed(["alpha"]);
  await run();
  expect(starts).toHaveLength(1);
  deps = { ...deps, bootId: async () => null };
  await run();
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
  ).toMatchObject({
    lastAttemptBootId: "boot-1",
    lastResult: { reason: "boot_identity_unavailable" },
  });
  deps = { ...deps, bootId: async () => "boot-1" };
  await run();
  expect(starts).toHaveLength(1);
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
  expect((await readAutostartGlobal({ registryPath })).loginRun.failed).toEqual(
    []
  );
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

test("routing children suppress Compose env files without inheriting shell overrides", async () => {
  const invocation = [
    process.execPath,
    "--eval",
    "process.stdout.write(process.env.COMPOSE_ENV_FILES ?? 'absent')",
  ];
  for (const routing of [false, true]) {
    const result = await runAutostartSubprocess(invocation, {
      timeoutMs: 5000,
      routing,
      env: { COMPOSE_ENV_FILES: "/untrusted.env" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(routing ? "/dev/null" : "absent");
  }
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

test("only declared completed dependency services are adopted alongside running services", () => {
  const completed = completedDependencyServices({
    services: {
      init: { restart: "no" },
      web: {
        depends_on: { init: { condition: "service_completed_successfully" } },
        restart: "no",
      },
      db: {},
    },
  });
  expect([...completed]).toEqual(["init"]);
  expect(
    classifyAutostartContainers("db|running|0\nweb|exited|0\n", completed)
  ).toBe("stopped");
  expect(
    classifyAutostartContainers("web|running|0\ninit|exited|0\n", completed)
  ).toBe("running");
  expect(classifyAutostartContainers("web|running|0\ninit|exited|0\n")).toBe(
    "stopped"
  );
  expect(classifyAutostartContainers("init|exited|0\n", completed)).toBe(
    "stopped"
  );
  expect(
    classifyAutostartContainers("web|running|0\ninit|exited|1\n", completed)
  ).toBe("stopped");
  expect(classifyAutostartContainers("web|created|0\n", completed)).toBe(
    "stopped"
  );
  expect(classifyAutostartContainers("invalid response", completed)).toBe(
    "unknown"
  );
  expect(classifyAutostartContainers("", completed)).toBe("unknown");
});

test("completion targets require a declared service and the exact dependency condition", () => {
  expect([
    ...completedDependencyServices({
      services: {
        init: {},
        web: {
          depends_on: {
            init: { condition: "service_started" },
            missing: { condition: "service_completed_successfully" },
          },
        },
        worker: { depends_on: ["init"] },
      },
    }),
  ]).toEqual([]);
  expect([...completedDependencyServices(null)]).toEqual([]);
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

test("independent global pause blocks existing and newly marked projects", async () => {
  await seed(["alpha", "bravo"]);
  await removeProjectAutostart({ id: "bravo", registryPath });
  await setAutostartGlobalPaused({ paused: true, registryPath });
  await setProjectAutostart({ id: "bravo", registryPath });
  await run();
  expect(events).toEqual([]);
  expect(starts).toEqual([]);
  expect((await readAutostartGlobal({ registryPath })).paused).toBe(true);
  expect(
    (await readProjectsRegistry({ registryPath })).projects.every(
      (project) => project.autostart?.paused === false
    )
  ).toBe(true);
});

test("global pause during inspection blocks dispatch and preserves manual project intent", async () => {
  await seed(["alpha", "bravo"]);
  await setProjectAutostartPaused({ id: "bravo", paused: true, registryPath });
  deps = {
    ...deps,
    inspect: async () => {
      await setAutostartGlobalPaused({ paused: true, registryPath });
      return "stopped";
    },
  };
  await run();
  expect(starts).toEqual([]);
  expect(
    (await results()).find((project) => project.id === "alpha")?.result?.reason
  ).toBe("global_paused");
  await setAutostartGlobalPaused({ paused: false, registryPath });
  expect(
    (await readProjectsRegistry({ registryPath })).projects.find(
      (project) => project.id === "bravo"
    )?.autostart?.paused
  ).toBe(true);
  const progress = (await readAutostartGlobal({ registryPath })).loginRun;
  expect(progress).toMatchObject({
    inProgress: false,
    pending: [],
    started: [],
    failed: [],
  });
});

test("global pause during engine or routing discovery prevents routing and project starts", async () => {
  for (const during of ["engine", "routing"]) {
    await seed(["alpha"]);
    deps = {
      ...deps,
      engineReady: async () => {
        if (during === "engine") {
          await setAutostartGlobalPaused({ paused: true, registryPath });
        }
        return true;
      },
      routingInstalled: async () => {
        if (during === "routing") {
          await setAutostartGlobalPaused({ paused: true, registryPath });
        }
        return true;
      },
    };
    await run();
    expect(events).toEqual([]);
    expect(starts).toEqual([]);
    expect(
      (await readAutostartGlobal({ registryPath })).loginRun
    ).toMatchObject({ inProgress: false, pending: [], failed: [] });
  }
});

test("login progress is persisted before engine probing and separates successful and failed outcomes", async () => {
  await seed(["bravo", "alpha"]);
  deps = {
    ...deps,
    engineReady: async () => {
      expect(
        (await readAutostartGlobal({ registryPath })).loginRun
      ).toMatchObject({
        inProgress: true,
        startedAt: "1970-01-01T00:00:00.000Z",
        pending: ["alpha", "bravo"],
        started: [],
        failed: [],
      });
      return true;
    },
    start: async (project) => {
      const progress = (await readAutostartGlobal({ registryPath })).loginRun;
      expect(progress.inProgress).toBe(true);
      expect(progress.pending).toContain(project.id);
      return project.id === "alpha"
        ? { status: "started", reason: null }
        : { status: "failed", reason: "start_failed" };
    },
  };
  await run();
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    inProgress: false,
    pending: [],
    started: ["alpha"],
    failed: ["bravo"],
  });
});

test("cancelled and interrupted login runs close their pending progress without replaying claims", async () => {
  await seed(["alpha", "bravo"]);
  const abort = new AbortController();
  deps = {
    ...deps,
    engineReady: async () => {
      abort.abort();
      return true;
    },
  };
  await run(abort.signal);
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    inProgress: false,
    pending: [],
    started: [],
    failed: [],
  });
  const previous = await beginAutostartLoginRun({
    bootId: "boot-1",
    startedAt: "1970-01-01T00:00:00.000Z",
    pendingIds: ["alpha", "bravo"],
    registryPath,
  });
  expect(previous?.inProgress).toBe(true);
  await claimProjectAutostart({ id: "alpha", bootId: "boot-1", registryPath });
  await claimProjectAutostart({ id: "bravo", bootId: "boot-1", registryPath });
  await run();
  expect(starts).toEqual([]);
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    runId: previous?.runId,
    inProgress: false,
    pending: [],
    failed: [],
  });
});

test("a thrown project start records failure and finishes global progress", async () => {
  await seed(["alpha"]);
  deps = {
    ...deps,
    start: async () => {
      throw new Error("example sensitive details");
    },
  };
  await run();
  expect((await readAutostartGlobal({ registryPath })).loginRun).toMatchObject({
    inProgress: false,
    pending: [],
    failed: ["alpha"],
  });
  expect(
    JSON.stringify(await readAutostartGlobal({ registryPath }))
  ).not.toContain("example sensitive details");
});

test("adoption requires every default service rather than a running subset", () => {
  const model = autostartComposeModel({
    services: { web: {}, db: {}, debug: { profiles: ["debug"] } },
  });
  expect(model).not.toBeNull();
  expect([...(model?.requiredServices ?? [])]).toEqual(["web", "db"]);
  expect(
    classifyAutostartContainers(
      "db|running|0",
      model?.completedServices,
      model?.requiredServices
    )
  ).toBe("stopped");
  expect(
    classifyAutostartContainers(
      "web|running|0\ndb|running|0",
      model?.completedServices,
      model?.requiredServices
    )
  ).toBe("running");
});

test("required dependency targets include completed initializers but optional disabled profiles stay excluded", () => {
  const model = autostartComposeModel({
    services: {
      web: {
        depends_on: {
          init: { condition: "service_completed_successfully" },
          metrics: { required: false },
        },
      },
      init: { profiles: ["setup"] },
      metrics: { profiles: ["monitoring"] },
    },
  });
  expect([...(model?.requiredServices ?? [])]).toEqual(["web", "init"]);
  expect(
    classifyAutostartContainers(
      "web|running|0",
      model?.completedServices,
      model?.requiredServices
    )
  ).toBe("stopped");
  expect(
    classifyAutostartContainers(
      "web|running|0\ninit|exited|0",
      model?.completedServices,
      model?.requiredServices
    )
  ).toBe("running");
});

test("ambiguous Compose models cannot prove adoption", () => {
  expect(
    autostartComposeModel({ include: ["other.yml"], services: { web: {} } })
  ).toBeNull();
  expect(
    autostartComposeModel({
      services: { web: { extends: { service: "base", file: "other.yml" } } },
    })
  ).toBeNull();
  expect(
    autostartComposeModel({ services: { web: { depends_on: ["missing"] } } })
  ).toBeNull();
  expect(
    autostartComposeModel({ services: { web: { profiles: "debug" } } })
  ).toBeNull();
});

test("engine wait is explicitly configurable and visible while probing", async () => {
  await seed(["alpha"]);
  expect(resolveAutostartEngineWaitMs()).toBe(600_000);
  expect(() => resolveAutostartEngineWaitMs(0)).toThrow();
  expect(() => resolveAutostartEngineWaitMs(3_600_001)).toThrow();
  deps = {
    ...deps,
    engineReady: async () => {
      expect(
        (await readAutostartGlobal({ registryPath })).loginRun.waitingForEngine
      ).toBe(true);
      return false;
    },
  };
  expect(
    await runAutostartAtLogin({
      registryPath,
      dependencies: deps,
      engineWaitMs: 5000,
    })
  ).toEqual({ waitingForEngine: true });
  expect(clock).toBe(5000);
});

test("service environment ignores shell Docker Compose and Hack overrides", async () => {
  const env = autostartServiceEnvironment({
    home: root,
    hackHome: join(root, "state"),
  });
  expect(Object.keys(env).sort()).toEqual(
    (process.platform === "linux"
      ? [
          "HOME",
          "HACK_HOME",
          "USER",
          "LOGNAME",
          "TMPDIR",
          "PATH",
          "XDG_RUNTIME_DIR",
        ]
      : ["HOME", "HACK_HOME", "USER", "LOGNAME", "TMPDIR", "PATH"]
    ).sort()
  );
  const result = await runAutostartSubprocess(
    [
      process.execPath,
      "--eval",
      'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("DOCKER_") || key.startsWith("COMPOSE_") || key.startsWith("HACK_")))))',
    ],
    {
      timeoutMs: 5000,
      env: {
        ...env,
        DOCKER_HOST: "invalid://example",
        COMPOSE_PROFILES: "debug",
        HACK_GLOBAL_CONFIG_PATH: "/invalid/config",
        HACK_RUNTIME_BACKEND: "native",
        HACK_ENV_SECRET_KEY: "synthetic-fixture-key",
      },
      projectId: "alpha",
    }
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    HACK_HOME: join(root, "state"),
    HACK_NO_INTERACTIVE: "1",
    HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
    HACK_AUTOSTART_LOGIN: "1",
    HACK_AUTOSTART_PROJECT_ID: "alpha",
  });
  await expect(runAutostartAtLogin()).rejects.toThrow(
    "explicit absolute service home paths"
  );
});

test("Linux service startup uses an invocation-owned user scope and has no direct fallback", async () => {
  await seed(["alpha"]);
  const project = (await readProjectsRegistry({ registryPath })).projects[0];
  if (!project) {
    throw new Error("Missing fixture project");
  }
  const invocation = ["/fixture/hack"];
  const args = buildAutostartProjectInvocation({
    invocation,
    project,
    serviceOrigin: true,
    platform: "linux",
  });
  expect(args.slice(0, 4)).toEqual([
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
  ]);
  expect(args[4]).toMatch(/^--unit=hack-autostart-[a-f0-9-]+$/);
  expect(args.slice(5)).toEqual([
    "/fixture/hack",
    "up",
    "-d",
    "--no-interactive",
    "--json",
    "--path",
    project.repoRoot,
  ]);
  expect(
    buildAutostartProjectInvocation({
      invocation,
      project,
      serviceOrigin: false,
      platform: "linux",
    })[0]
  ).toBe("/fixture/hack");
  expect(
    buildAutostartProjectInvocation({
      invocation,
      project,
      serviceOrigin: true,
      platform: "darwin",
    })[0]
  ).toBe("/fixture/hack");
  expect(() =>
    buildAutostartProjectInvocation({
      invocation,
      project,
      serviceOrigin: true,
    })
  ).toThrow();
});

test("start timeout sends TERM for cleanup before escalating to KILL", async () => {
  const receipt = join(root, "term-received");
  const script =
    'process.on("SIGTERM", async () => { await Bun.write(process.env.HOME + "/term-received", "cleaned"); process.exit(0); }); await Bun.sleep(10000);';
  const result = await runAutostartSubprocess(
    [process.execPath, "--eval", script],
    { timeoutMs: 300, terminationGraceMs: 500, env: { HOME: root } }
  );
  expect(result.reason).toBe("start_timeout");
  expect(await Bun.file(receipt).text()).toBe("cleaned");
  const startedAt = performance.now();
  const ignored = await runAutostartSubprocess(
    [
      process.execPath,
      "--eval",
      'process.on("SIGTERM", () => {}); await Bun.sleep(10000);',
    ],
    { timeoutMs: 200, terminationGraceMs: 100, env: { HOME: root } }
  );
  expect(ignored.reason).toBe("start_timeout");
  expect(performance.now() - startedAt).toBeLessThan(2000);
});

test("login lock cancellations persist only the closed neutral reason vocabulary", () => {
  for (const reason of ["paused", "global_paused", "target_changed"]) {
    expect(
      classifyAutostartExit({
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: "E_CANCELLED",
            detail: { reason },
            message: "synthetic omitted details",
          },
        }),
      })
    ).toEqual({ status: "skipped", reason });
  }
  expect(
    classifyAutostartExit({
      exitCode: 1,
      stdout: JSON.stringify({
        error: {
          code: "E_CANCELLED",
          detail: { reason: "synthetic omitted details" },
        },
      }),
    })
  ).toEqual({ status: "failed", reason: "start_failed" });
});

test("unrecognized error codes cannot inherit reasons from object prototypes", () => {
  for (const code of ["constructor", "__proto__", "toString"]) {
    expect(
      classifyAutostartExit({
        exitCode: 1,
        stdout: JSON.stringify({ error: { code } }),
      })
    ).toEqual({ status: "failed", reason: "start_failed" });
  }
  expect(
    classifyAutostartExit({
      exitCode: 1,
      stdout: JSON.stringify({
        error: { code: "E_CANCELLED", detail: { reason: { toString: null } } },
      }),
    })
  ).toEqual({ status: "failed", reason: "start_failed" });
});

test("service PATH derives known user install directories from its owned home and ignores hostile shell PATH", () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = "/hostile/shell/bin";
    const linux = autostartServiceEnvironment({
      home: root,
      hackHome: join(root, "state"),
      platform: "linux",
    });
    expect(linux.PATH).toBe(
      autostartServicePath({ home: root, platform: "linux" })
    );
    expect(linux.PATH?.split(":")).toEqual([
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      join(root, ".local/bin"),
      join(root, ".bun/bin"),
      join(root, ".hack/bin"),
      join(root, ".docker/bin"),
    ]);
    const mac = autostartServicePath({ home: root, platform: "darwin" }).split(
      ":"
    );
    expect(mac).toContain("/opt/homebrew/bin");
    expect(mac).toContain(join(root, ".bun/bin"));
    expect(mac).toContain(join(root, ".hack/bin"));
    expect(mac).toContain(join(root, ".docker/bin"));
    expect(mac).not.toContain(join(root, ".local/bin"));
    expect(linux.PATH).not.toContain("/hostile/shell/bin");
    expect(mac).not.toContain("/hostile/shell/bin");
  } finally {
    if (previous === undefined) {
      process.env.PATH = undefined;
    } else {
      process.env.PATH = previous;
    }
  }
});

test("production executable trust refuses a poisoned home bin before engine helpers execute", async () => {
  await seed(["alpha"]);
  const bin = join(root, ".bun/bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const receipt = join(root, "docker-executed");
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\nprintf invoked > '${receipt}'\n`,
    { mode: 0o700 }
  );
  await chmod(bin, 0o777);
  const production = createAutostartProductionDependencies(
    { home: root, hackHome: join(root, "state") },
    {
      executablePath: async ({ path }) => {
        expect(path.split(":")).toContain(bin);
        await assertAutostartExecutablePathTrusted({ path: bin });
      },
    }
  );
  deps = {
    ...deps,
    startupRefusal: production.startupRefusal,
    bootId: async () => {
      events.push("boot");
      return "boot-1";
    },
  };
  await run();
  expect(events).toEqual(["boot"]);
  expect(starts).toEqual([]);
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect((await results())[0]?.result).toMatchObject({
    status: "skipped",
    reason: "executable_path_untrusted",
  });
});

test("untrusted checkout observations and child permission refusals are closed skips", async () => {
  await seed(["alpha"]);
  deps = { ...deps, inspect: async () => "untrusted" };
  await run();
  expect(starts).toEqual([]);
  expect((await results())[0]?.result).toMatchObject({
    status: "skipped",
    reason: "checkout_untrusted",
  });
  for (const reason of ["checkout_untrusted", "executable_path_untrusted"]) {
    expect(
      classifyAutostartExit({
        exitCode: 1,
        stdout: JSON.stringify({
          error: { code: "E_PERMISSION", detail: { reason } },
        }),
      })
    ).toEqual({ status: "skipped", reason });
  }
});

test("a refused executable path never overwrites an earlier real-boot claim or permits duplicate starts", async () => {
  await seed(["alpha"]);
  await run();
  const before = (await readProjectsRegistry({ registryPath })).projects[0]
    ?.autostart;
  expect(before?.lastAttemptBootId).toBe("boot-1");
  deps = {
    ...deps,
    startupRefusal: async () => "executable_path_untrusted" as const,
  };
  await run();
  const refused = (await readProjectsRegistry({ registryPath })).projects[0]
    ?.autostart;
  expect(refused).toEqual(before);
  deps = { ...deps, startupRefusal: async () => null };
  await run();
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
  ).toEqual(before);
});

test("repairing an executable path permits a first attempt in the same boot", async () => {
  await seed(["alpha"]);
  deps = {
    ...deps,
    startupRefusal: async () => "executable_path_untrusted" as const,
  };
  await run();
  expect(starts).toEqual([]);
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
      ?.lastAttemptBootId
  ).toBeNull();
  deps = { ...deps, startupRefusal: async () => null };
  await run();
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
});

for (const reason of [
  "host_commands_require_manual_start",
  "adopted_project_requires_manual_start",
]) {
  test(`manual-start policy ${reason} refuses before engine access without claims or failed progress`, async () => {
    await seed(["alpha"]);
    deps = {
      ...deps,
      projectRefusal: async () => reason,
    };
    await run();
    expect(events).toEqual([]);
    expect(starts).toEqual([]);
    expect(
      (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
        ?.lastAttemptBootId
    ).toBeNull();
    expect(
      (await readAutostartGlobal({ registryPath })).loginRun.failed
    ).toEqual([]);
    expect((await results())[0]?.result).toMatchObject({
      status: "skipped",
      reason,
    });
    deps = { ...deps, projectRefusal: async () => null };
    await run();
    expect(starts.map((start) => start.id)).toEqual(["alpha"]);
  });
}

test("late child manual-start refusal releases only its unstarted claim and remains neutral", async () => {
  await seed(["alpha"]);
  deps = {
    ...deps,
    start: async () => ({
      status: "skipped",
      reason: "image_requires_manual_start",
    }),
  };
  await run();
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
      ?.lastAttemptBootId
  ).toBeNull();
  expect((await readAutostartGlobal({ registryPath })).loginRun.failed).toEqual(
    []
  );
  deps = {
    ...deps,
    start: async () => {
      starts.push({ id: "alpha", at: clock });
      return { status: "started", reason: null };
    },
  };
  await run();
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
});

test("unsafe Docker context selection refuses before engine access without consuming a claim", async () => {
  await seed(["alpha"]);
  await mkdir(join(root, ".docker"), { mode: 0o700 });
  const config = join(root, ".docker/config.json");
  await writeFile(config, JSON.stringify({ currentContext: "untrusted" }), {
    mode: 0o600,
  });
  await chmod(config, 0o666);
  const production = createAutostartProductionDependencies(
    { home: root, hackHome: join(root, "state") },
    { executablePath: async () => {} }
  );
  deps = { ...deps, startupRefusal: production.startupRefusal };
  await run();
  expect(events).toEqual([]);
  expect((await results())[0]?.result).toMatchObject({
    reason: "docker_config_untrusted",
  });
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
      ?.lastAttemptBootId
  ).toBeNull();
  await chmod(config, 0o600);
  const context = join(
    root,
    ".docker/contexts/meta",
    createHash("sha256").update("untrusted").digest("hex")
  );
  await mkdir(context, { recursive: true, mode: 0o700 });
  const metadata = join(context, "meta.json");
  await writeFile(
    metadata,
    JSON.stringify({ Endpoints: { docker: { Host: "ssh://fixture" } } }),
    { mode: 0o600 }
  );
  await run();
  expect(events).toEqual([]);
  expect(
    (await readProjectsRegistry({ registryPath })).projects[0]?.autostart
      ?.lastAttemptBootId
  ).toBeNull();
  await writeFile(
    metadata,
    JSON.stringify({ Endpoints: { docker: { Host: "unix:///fixture.sock" } } }),
    { mode: 0o600 }
  );
  await run();
  expect(starts.map((start) => start.id)).toEqual(["alpha"]);
});

test("managed global graph variables decline base-graph adoption without resolving their values", async () => {
  await seed(["alpha"]);
  const project = (await readProjectsRegistry({ registryPath })).projects[0];
  if (!project) {
    throw new Error("Missing fixture project");
  }
  await mkdir(project.projectDir, { recursive: true, mode: 0o700 });
  const compose = { services: { web: {}, worker: { profiles: ["jobs"] } } };
  const model = autostartComposeModel(compose);
  expect(
    classifyAutostartContainers(
      "web|running|0",
      model?.completedServices,
      model?.requiredServices
    )
  ).toBe("running");
  expect(
    await canAdoptAutostartEnvironment({
      projectRoot: project.repoRoot,
      projectDir: project.projectDir,
    })
  ).toBe(true);
  await writeFile(
    join(project.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: {
        global: { COMPOSE_PROFILES: "jobs", COMPOSE_FILE: "selected.yml" },
      },
    }),
    { mode: 0o600 }
  );
  expect(
    await canAdoptAutostartEnvironment({
      projectRoot: project.repoRoot,
      projectDir: project.projectDir,
    })
  ).toBe(false);
  const production = createAutostartProductionDependencies({
    home: root,
    hackHome: join(root, "state"),
  });
  expect(await production.inspect(project)).toBe("stopped");
});

test("encrypted contracts, machine overlays and dotenv graph inputs conservatively disable adoption", async () => {
  const projectRoot = join(root, "checkout");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  for (const [directory, name] of [
    [projectDir, "hack.env.json"],
    [projectDir, "hack.env.local.yaml"],
    [projectDir, ".env.preview"],
    [projectRoot, ".env"],
  ]) {
    if (!(directory && name)) {
      throw new Error("Missing fixture path");
    }
    const path = join(directory, name);
    await writeFile(path, "synthetic encrypted reference, not decrypted");
    expect(
      await canAdoptAutostartEnvironment({ projectRoot, projectDir })
    ).toBe(false);
    await rm(path);
  }
  expect(await canAdoptAutostartEnvironment({ projectRoot, projectDir })).toBe(
    true
  );
  await rm(projectDir, { recursive: true });
  expect(await canAdoptAutostartEnvironment({ projectRoot, projectDir })).toBe(
    false
  );
});
