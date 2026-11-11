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
import { classifyNativeAlreadyRunning } from "../src/commands/native-up-already-running.ts";
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
};

/** A project with a saved run whose graph the stub runtime reports as given. */
async function fixture(opts: {
  readonly phase: string;
  readonly services: Readonly<Record<string, Observation>>;
  /** What `graph owner-status` answers; omitted, the request fails. */
  readonly owner?: Record<string, unknown>;
  readonly savedRun?: boolean;
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
printf '%s\\n' "$*" >> '${stub}/calls'
if [ -f '${stub}/'"$3-$4"'.out' ]; then cat '${stub}/'"$3-$4"'.out'; exit 0; fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  await writeFile(
    join(stub, "graph-inspect.out"),
    JSON.stringify({
      journal_incomplete: false,
      receipt: {
        run: run.run,
        owner: run.owner,
        namespace: run.namespace,
        plan_id: run.planId,
        phase: opts.phase,
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
          observation,
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
      branch: null,
      run,
    });
  }
  return {
    root,
    project,
    env: privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NATIVE_SHARED_SOURCE: "1",
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
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
  args: readonly string[]
) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "--path", f.project, "up", ...args],
    {
      cwd: f.root,
      env: f.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS - 5000,
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
        seed: { state: "exited", code: 0 },
      },
      owner: LIVE_OWNER,
    });
    const human = await up(f, ["-d"]);
    expect(human.output).not.toContain("E_STARTUP_INCOMPLETE");
    expect(human.code).toBe(0);
    expect(human.stdout).toBe(
      "Project is already running. Use hack ps, hack logs SERVICE --no-follow, and hack down.\n"
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
      expect(["graph inspect", "graph owner-status"]).toContain(call);
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
        db: { state: "exited", code: 137 },
        worker: { state: "running", health: "unhealthy" },
      },
      owner: LIVE_OWNER,
    });
    const human = await up(f, ["-d"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(
      "ERROR: E_STARTUP_INCOMPLETE: Native project is already running, but these services are not up: db, worker."
    );
    expect(human.stderr).toContain("hack restart");
    expect(human.stderr).not.toContain("was not confirmed");
    const json = await up(f, ["-d", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_STARTUP_INCOMPLETE" },
    });
    for (const call of await f.calls()) {
      expect(["graph inspect", "graph owner-status"]).toContain(call);
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
    // Only finished one-shots and nothing running is not a running project.
    { ...observed, items: [item("seed", { state: "exited", code: 0 })] },
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
      ],
    })
  ).toEqual({ kind: "partial", down: ["gone", "job", "web"] });
});
