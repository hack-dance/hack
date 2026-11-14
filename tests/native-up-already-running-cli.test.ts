import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type NativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import {
  classifyNativeAlreadyRunning,
  nativeScopedCommand,
} from "../src/commands/native-up-already-running.ts";
import { nativeSetupShellReply } from "./helpers/native-setup-inspection.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2102. `hack up -d` on a native project that is already up used to exit
 * 1 within a fraction of a second with `E_STARTUP_INCOMPLETE: Native detached
 * startup was not confirmed`: the background `up` it launched refused the
 * running graph and exited, and the launcher reported only that it never
 * heard "ready". On Compose the same command is a successful no-op.
 *
 * These cases run the source CLI against a stub runtime that reports a saved
 * run as a live, ready graph. Nothing here starts a VM or a real runtime.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
const run: NativeProjectRun = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  profiles: [],
  effectiveEnvName: null,
  aws: null,
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type Observation = {
  readonly state: string;
  readonly health?: string;
  readonly code?: number;
  readonly readiness?: "started" | "healthy" | "completed";
};

/** A project with a saved run whose graph the stub runtime reports as given. */
async function fixture(opts: {
  readonly phase: string;
  readonly services: Readonly<Record<string, Observation>>;
  /** What `graph owner-status` answers; omitted, the request fails. */
  readonly owner?: Record<string, unknown>;
  readonly savedRun?: boolean;
  readonly record?: NativeProjectRun;
  readonly branch?: string;
}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-up-running-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  const stub = join(root, "stub");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(stub);
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify({
      services: Object.fromEntries(
        Object.keys(opts.services).map((name) => [name, { image: IMAGE }])
      ),
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "running-fixture" })
  );
  const binary = join(root, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
${nativeSetupShellReply()}
printf '%s\\n' "$*" >> '${stub}/calls'
if [ -f '${stub}/'"$3-$4"'.out' ]; then cat '${stub}/'"$3-$4"'.out'; exit 0; fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  await writeFile(
    join(stub, "graph-status.out"),
    JSON.stringify({
      journal_incomplete: false,
      receipt: {
        run: run.run,
        owner: run.owner,
        namespace: run.namespace,
        plan_id: run.planId,
        phase: opts.phase,
        readiness: Object.fromEntries(
          Object.entries(opts.services).map(([name, item]) => [
            name,
            item.readiness ?? "started",
          ])
        ),
        // A foreground-owned graph: its owner can be asked for its status.
        relay_startup: {},
        resources: Object.fromEntries(
          Object.keys(opts.services).map((name) => [
            `container:${name}`,
            {
              kind: "container",
              key: name,
              id: "f".repeat(64),
              phase: "started",
            },
          ])
        ),
      },
      observations: Object.fromEntries(
        Object.entries(opts.services).map(([name, observation]) => [
          `container:${name}`,
          observation.state === "running"
            ? { ...observation, health: observation.health ?? "none" }
            : observation,
        ])
      ),
    })
  );
  if (opts.owner) {
    await writeFile(
      join(stub, "graph-owner-status.out"),
      JSON.stringify(opts.owner)
    );
  }
  if (opts.savedRun !== false) {
    await saveNativeProjectRun({
      projectRoot: project,
      projectDir,
      nativeHome,
      branch: opts.branch ?? null,
      run: opts.record ?? run,
    });
  }
  const registryDir = join(root, "user-home", ".hack");
  await mkdir(registryDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(registryDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "1".repeat(12),
          name: "running-fixture",
          repoRoot: project,
          projectDirName: ".hack",
          projectDir,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })
  );
  return {
    root,
    project,
    nativeHome,
    projectDir,
    env: privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NATIVE_SHARED_SOURCE: "1",
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_STATE_HOME: join(root, "xdg-state"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_DATA_HOME: join(root, "xdg-data"),
      },
    }),
    calls: async () =>
      (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").slice(2, 4).join(" ")),
  };
}

const LIVE_OWNER = {
  ok: true,
  run: run.run,
  plan: run.planId,
  phase: "ready-observed",
  foreground_alive: true,
  runtime_verified: true,
};

async function up(
  f: Awaited<ReturnType<typeof fixture>>,
  args: readonly string[],
  opts: {
    readonly scopeArgs?: readonly string[];
    readonly timeoutMs?: number;
  } = {}
) {
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      ...(opts.scopeArgs ?? ["--path", f.project]),
      "up",
      ...args,
    ],
    {
      cwd: f.root,
      env: f.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs ?? SPAWN_TIMEOUT_MS - 5000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: stdout + stderr };
}

test(
  "hack up -d on a native project that is already up and ready succeeds without starting anything",
  async () => {
    const f = await fixture({
      phase: "ready-observed",
      services: {
        web: { state: "running", health: "healthy" },
        db: { state: "running" },
        seed: { state: "exited", code: 0, readiness: "completed" },
      },
      owner: LIVE_OWNER,
    });
    const human = await up(f, ["-d"]);
    expect(human.output).not.toContain("E_STARTUP_INCOMPLETE");
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(
      `Project is already running. Configuration changes were not applied; run hack restart --path ${f.project} to apply edits.\n`
    );
    const json = await up(f, ["--detach", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      data: {
        action: "up",
        alreadyRunning: true,
        project: "running-fixture",
        branch: null,
        composeProject: "running-fixture",
        services: {
          started: ["db", "web"],
          completed: ["seed"],
          stopped: [],
          failed: [],
        },
        durationMs: expect.any(Number),
      },
    });
    // Only read-only observations: nothing was started, stopped or reviewed.
    for (const call of await f.calls()) {
      expect(["graph status", "graph owner-status"]).toContain(call);
    }
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a running project with a service that is down says which, and what to run, instead of 'not confirmed'",
  async () => {
    const f = await fixture({
      phase: "ready-observed",
      services: {
        web: { state: "running", health: "healthy" },
        db: { state: "exited", code: 0, readiness: "started" },
        worker: { state: "running", health: "unhealthy" },
      },
      owner: LIVE_OWNER,
    });
    const human = await up(f, ["-d"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(
      "ERROR: E_STARTUP_INCOMPLETE: Native project is already running, but these services have not reached their required state: db, worker."
    );
    expect(human.stderr).toContain(`run hack restart --path ${f.project}.`);
    expect(human.stderr).not.toContain("was not confirmed");
    const json = await up(f, ["-d", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_STARTUP_INCOMPLETE" },
    });
    for (const call of await f.calls()) {
      expect(["graph status", "graph owner-status"]).toContain(call);
    }
  },
  SPAWN_TIMEOUT_MS
);

test("only a live, ready graph whose owner answers counts as already running", () => {
  const item = (service: string, observation: Observation) => ({
    service,
    container: "f".repeat(64),
    phase: "started",
    state: observation.state,
    health: observation.health ?? null,
    exitCode: observation.code ?? null,
    readiness: observation.readiness,
  });
  const observed = {
    backend: "native" as const,
    status: "observed" as const,
    run: run.run,
    phase: "ready-observed",
    items: [item("web", { state: "running" })],
  };
  expect(classifyNativeAlreadyRunning(observed)).toEqual({
    kind: "running",
    started: ["web"],
    completed: [],
  });
  expect(
    classifyNativeAlreadyRunning({
      ...observed,
      items: [
        item("web", {
          state: "running",
          health: "none",
          readiness: "started",
        }),
      ],
    })
  ).toEqual({ kind: "running", started: ["web"], completed: [] });
  // Anything short of a confirmed ready graph launches as before, so a start
  // that is genuinely unconfirmed still reports its own reason.
  for (const other of [
    { ...observed, status: "owner_unconfirmed" as const },
    { ...observed, status: "runtime_degraded" as const },
    { ...observed, status: "runtime_not_running" as const, items: [] },
    { ...observed, status: "runtime_busy" as const, items: [] },
    { ...observed, status: "pending" as const, run: null, items: [] },
    { ...observed, status: "not_started" as const, run: null, items: [] },
    { ...observed, phase: "stopped-data-retained" },
    { ...observed, phase: "starting" },
    { ...observed, items: [] },
  ]) {
    expect(classifyNativeAlreadyRunning(other)).toEqual({ kind: "launch" });
  }
  expect(
    classifyNativeAlreadyRunning({
      ...observed,
      items: [
        item("web", { state: "running", health: "starting" }),
        item("api", { state: "running", health: "healthy" }),
        item("job", { state: "exited", code: 2 }),
        item("gone", { state: "absent" }),
        item("clean-exit", { state: "exited", code: 0, readiness: "started" }),
        item("unknown-role", { state: "exited", code: 0 }),
        item("unfinished-job", { state: "running", readiness: "completed" }),
        item("unknown-health", { state: "running", readiness: "healthy" }),
        item("no-probe", {
          state: "running",
          health: "none",
          readiness: "healthy",
        }),
      ],
    })
  ).toEqual({
    kind: "partial",
    down: [
      "clean-exit",
      "gone",
      "job",
      "no-probe",
      "unfinished-job",
      "unknown-health",
      "unknown-role",
      "web",
    ],
  });
});

test("a ready graph of completed one-shots is a successful no-op", async () => {
  const f = await fixture({
    phase: "ready-observed",
    services: { seed: { state: "exited", code: 0, readiness: "completed" } },
    owner: LIVE_OWNER,
  });
  const result = await up(f, ["-d", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).data.services).toEqual({
    started: [],
    completed: ["seed"],
    stopped: [],
    failed: [],
  });
});

test(
  "explicit env/profile flags must match the retained selection, including legacy unknown selections",
  async () => {
    const {
      effectiveEnvName: _env,
      profiles: _profiles,
      aws: _aws,
      ...legacy
    } = run;
    const cases = [
      ...["base", "default", "BASE", "", "DEFAULT"].map((env) => ({
        record: run,
        args: ["--env", env],
        accepted: true,
      })),
      {
        record: { ...run, effectiveEnvName: "staging" },
        args: ["--env", " staging "],
        accepted: true,
      },
      { record: run, args: ["--profile", "worker"], accepted: false },
      {
        record: { ...run, effectiveEnvName: "qa" },
        args: ["--env", "staging"],
        accepted: false,
      },
      { record: legacy, args: ["--profile", "worker"], accepted: false },
      { record: legacy, args: ["--env", "staging"], accepted: false },
      {
        record: {
          ...run,
          profiles: ["api", "worker"],
          effectiveEnvName: "staging",
        },
        args: ["--env", "staging", "--profile", "worker,api"],
        accepted: true,
      },
    ];
    for (const item of cases) {
      const f = await fixture({
        phase: "ready-observed",
        services: { web: { state: "running" } },
        owner: LIVE_OWNER,
        record: item.record,
      });
      const result = await up(f, ["-d", "--json", ...item.args], {
        timeoutMs: 5000,
      });
      expect(result.code).toBe(item.accepted ? 0 : 1);
      if (item.accepted) {
        expect(JSON.parse(result.stdout).data.alreadyRunning).toBe(true);
      } else {
        expect(result.output).toContain(
          "different or unknown environment/profile selection"
        );
        expect(result.output).not.toContain('"alreadyRunning": true');
      }
      for (const call of await f.calls()) {
        expect(["graph status", "graph owner-status"]).toContain(call);
      }
    }
  },
  SPAWN_TIMEOUT_MS
);

test("project and branch selection are preserved in the one working recovery command", async () => {
  const f = await fixture({
    phase: "ready-observed",
    services: { web: { state: "running" }, db: { state: "exited", code: 0 } },
    owner: LIVE_OWNER,
    branch: "preview",
  });
  const result = await up(f, ["-d", "--branch", "preview"], {
    scopeArgs: ["--project", "running-fixture"],
  });
  expect(result.code).toBe(1);
  expect(result.output).toContain(
    "run hack restart --project running-fixture --branch preview."
  );
  const same = await up(f, ["-d", "--branch", "preview"]);
  expect(same.code).toBe(1);
  expect(same.output).toContain(
    `run hack restart --path ${f.project} --branch preview.`
  );
});

test("recovery command quotes every explicit selector as one shell argument", () => {
  expect(
    nativeScopedCommand({
      action: "restart",
      selection: { path: "/tmp/project with space", branch: "preview" },
    })
  ).toBe("hack restart --path '/tmp/project with space' --branch preview");
  expect(
    nativeScopedCommand({
      action: "restart",
      selection: { project: "fixture's project" },
    })
  ).toBe("hack restart --project 'fixture'\\''s project'");
});

test("an already-running observation never blocks while reading a FIFO Compose name", async () => {
  const f = await fixture({
    phase: "ready-observed",
    services: { web: { state: "running" } },
    owner: LIVE_OWNER,
  });
  const compose = join(f.projectDir, "docker-compose.yml");
  await rm(compose);
  expect(Bun.spawnSync(["mkfifo", compose]).exitCode).toBe(0);
  const result = await up(f, ["-d"], { timeoutMs: 3000 });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Project is already running.");
});
