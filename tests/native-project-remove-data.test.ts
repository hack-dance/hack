import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeProjectRemoveData } from "../src/backends/native-project-down.ts";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import {
  loadNativeProjectRun,
  removeNativeProjectRun,
  saveNativeProjectRun,
  saveNativeRestartIntent,
} from "../src/backends/native-project-run.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "../src/backends/native-runtime-client.ts";
import { runNativeDownRemoveData } from "../src/commands/project-native-remove-data.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";
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
const cache = {
  scope: "1".repeat(64),
  fingerprint: "2".repeat(64),
  image: `sha256:${"3".repeat(64)}`,
};

type Phase =
  | "ready-observed"
  | "stopped-data-retained"
  | "cleanup-intent"
  | "removed";

/**
 * A synthetic `graph inspect` reply: one service, one owned data volume and
 * one shared dependency cache. `remaining` keeps the owned volume visible.
 */
function graph(phase: Phase, opts: { readonly remaining?: boolean } = {}) {
  const removed = phase === "removed";
  const running = phase === "ready-observed";
  return {
    receipt: {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      phase,
      resources: {
        "container:db": {
          kind: "container",
          key: "db",
          id,
          phase: running ? "started" : "absent",
        },
        "volume:data": {
          kind: "volume",
          key: "data",
          id: null,
          phase: removed ? "absent" : "created",
        },
        "volume:deps": {
          kind: "volume",
          key: "deps",
          id: null,
          cache,
          phase: removed ? "released" : "created",
        },
      },
    },
    journal_incomplete: false,
    observations: {
      "container:db": { state: running ? "running" : "absent" },
      "volume:data": {
        state: removed && !opts.remaining ? "absent" : "present",
      },
      "volume:deps": { state: "present" },
    },
  };
}

async function fixture(saved = true) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-remove-data-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  if (saved) {
    await saveNativeProjectRun({ ...scope, run });
  }
  const finalization = await beginNativeProjectFinalization({ scope, run });
  await finalization.complete();
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}

/** Scripted runtime: inspect replies follow `phases`; cleanup may fail. */
function runtime(opts: {
  readonly phases: readonly Phase[];
  readonly cleanupFails?: boolean;
  readonly remaining?: boolean;
}) {
  const calls: string[][] = [];
  const phases = [...opts.phases];
  const invoke = (async (request) => {
    calls.push([...request.args]);
    if (request.args[1] === "cleanup") {
      if (opts.cleanupFails) {
        throw new NativeRuntimeRequestError({
          message: "synthetic-private-diagnostic /secret/path",
          nativeCode: "graph_cleanup_uncertain",
        });
      }
      return {};
    }
    const phase = phases.length > 1 ? phases.shift()! : phases[0]!;
    return graph(phase, { remaining: opts.remaining });
  }) as typeof invokeNativeRuntime;
  const verbs = () => calls.map((args) => args[1]);
  return { calls, invoke, verbs };
}

test("no saved run reports not started and requests nothing", async () => {
  const opts = await fixture(false);
  const r = runtime({ phases: ["stopped-data-retained"] });
  expect(await nativeProjectRemoveData({ ...opts, invoke: r.invoke })).toEqual({
    backend: "native",
    status: "not_started",
    dataPreserved: true,
  });
  expect(r.calls).toEqual([]);
});

test("a running project refuses before confirmation or cleanup", async () => {
  const opts = await fixture();
  const r = runtime({ phases: ["ready-observed"] });
  let asked = false;
  await expectClosedRefusal(
    nativeProjectRemoveData({
      ...opts,
      invoke: r.invoke,
      confirm: async () => {
        asked = true;
        return true;
      },
    }),
    "requires a stopped project; run `hack down` first"
  );
  expect(asked).toBe(false);
  expect(r.verbs()).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a declined confirmation keeps the data and the mapping", async () => {
  const opts = await fixture();
  const r = runtime({ phases: ["stopped-data-retained"] });
  const result = await nativeProjectRemoveData({
    ...opts,
    invoke: r.invoke,
    confirm: async () => false,
  });
  expect(result).toEqual({
    backend: "native",
    status: "kept",
    run: run.run,
    dataPreserved: true,
  });
  expect(r.verbs()).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a stopped project removes owned data, keeps caches and retires the mapping last", async () => {
  const opts = await fixture();
  const r = runtime({
    phases: ["stopped-data-retained", "stopped-data-retained", "removed"],
  });
  const result = await nativeProjectRemoveData({ ...opts, invoke: r.invoke });
  expect(result).toEqual({
    backend: "native",
    status: "removed",
    run: run.run,
    dataPreserved: false,
  });
  expect(r.calls).toEqual([
    ["graph", "inspect", "--run-id", run.run, "--json"],
    ["graph", "inspect", "--run-id", run.run, "--json"],
    ["graph", "cleanup", "--run-id", run.run, "--remove-data", "--json"],
    ["graph", "inspect", "--run-id", run.run, "--json"],
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});

test("a failed cleanup keeps the mapping and a rerun resumes the durable intent", async () => {
  const opts = await fixture();
  const failed = runtime({
    phases: ["stopped-data-retained"],
    cleanupFails: true,
  });
  const refusal = await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke: failed.invoke }),
    "Native data removal is unconfirmed (graph_cleanup_uncertain); the run mapping is kept"
  );
  expect(refusal.message).not.toContain("secret");
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  const resumed = runtime({
    phases: ["cleanup-intent", "cleanup-intent", "removed"],
  });
  expect(
    (await nativeProjectRemoveData({ ...opts, invoke: resumed.invoke })).status
  ).toBe("removed");
  expect(resumed.verbs()).toEqual(["inspect", "inspect", "cleanup", "inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});

test("an already removed receipt retires the mapping without replaying cleanup", async () => {
  const opts = await fixture();
  const r = runtime({ phases: ["removed"] });
  expect(
    (await nativeProjectRemoveData({ ...opts, invoke: r.invoke })).status
  ).toBe("removed");
  expect(r.verbs()).toEqual(["inspect", "inspect", "inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});

test("a volume that remains visible after cleanup keeps the mapping", async () => {
  const opts = await fixture();
  const r = runtime({
    phases: ["stopped-data-retained", "stopped-data-retained", "removed"],
    remaining: true,
  });
  await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke: r.invoke }),
    "Native data removal is unconfirmed"
  );
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a shared cache reported deleted instead of released keeps the mapping", async () => {
  const opts = await fixture();
  const removed = graph("removed");
  removed.receipt.resources["volume:deps"].phase = "absent";
  const replies: unknown[] = [
    graph("stopped-data-retained"),
    graph("stopped-data-retained"),
    removed,
  ];
  const invoke = (async (request) =>
    request.args[1] === "cleanup"
      ? {}
      : replies.shift()) as typeof invokeNativeRuntime;
  await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke }),
    "Native data removal is unconfirmed"
  );
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a stopped receipt whose volume is already missing refuses without cleanup", async () => {
  const opts = await fixture();
  const stopped = graph("stopped-data-retained");
  stopped.observations["volume:data"] = { state: "absent" };
  const calls: string[] = [];
  const invoke = (async (request) => {
    calls.push(request.args[1]!);
    return stopped;
  }) as typeof invokeNativeRuntime;
  await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke }),
    "Native data removal is unconfirmed; the run mapping is kept"
  );
  expect(calls).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("cleanup intent with compute still present refuses as running", async () => {
  const opts = await fixture();
  const intent = graph("cleanup-intent");
  intent.observations["container:db"] = { state: "running" };
  const invoke = (async () => intent) as unknown as typeof invokeNativeRuntime;
  await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke }),
    "requires a stopped project"
  );
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a foreign or malformed receipt refuses without cleanup", async () => {
  const opts = await fixture();
  for (const reply of [
    null,
    { ...graph("stopped-data-retained"), journal_incomplete: true },
    {
      ...graph("removed"),
      receipt: { ...graph("removed").receipt, owner: "f".repeat(32) },
    },
  ]) {
    const calls: string[] = [];
    const invoke = (async (request) => {
      calls.push(request.args[1]!);
      return reply;
    }) as typeof invokeNativeRuntime;
    await expectClosedRefusal(
      nativeProjectRemoveData({ ...opts, invoke }),
      "Native data removal is unconfirmed"
    );
    expect(calls).toEqual(["inspect"]);
  }
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a pending restart refuses under the restart lock", async () => {
  const opts = await fixture();
  const finalization = await captureNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  await saveNativeRestartIntent({
    ...opts.scope,
    intent: { phase: "prepared", run, finalization },
  });
  const r = runtime({ phases: ["stopped-data-retained"] });
  await expectClosedRefusal(
    nativeProjectRemoveData({ ...opts, invoke: r.invoke }),
    "a native restart is pending"
  );
  expect(r.verbs()).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("a mapping replaced while confirming is never removed", async () => {
  const opts = await fixture();
  const replacement = { ...run, run: "9".repeat(32) };
  const r = runtime({ phases: ["stopped-data-retained"] });
  await expectClosedRefusal(
    nativeProjectRemoveData({
      ...opts,
      invoke: r.invoke,
      confirm: async () => {
        await removeNativeProjectRun({ ...opts.scope, expected: run });
        await saveNativeProjectRun({ ...opts.scope, run: replacement });
        return true;
      },
    }),
    "Native data removal is unconfirmed"
  );
  expect(r.verbs()).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(replacement);
});

test("the command refuses --json without --yes before any runtime request", async () => {
  let called = false;
  const error = await runNativeDownRemoveData({
    runtime: { binary: "/not-invoked", home: "/not-used" },
    scope: {
      projectRoot: "/not-used",
      projectDir: "/not-used/.hack",
      nativeHome: "/not-used",
      branch: null,
    },
    yes: false,
    json: true,
    remove: (async () => {
      called = true;
      throw new Error("unreachable");
    }) as typeof nativeProjectRemoveData,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toMatchObject({ code: "E_INTERACTIVE_REQUIRED" });
  expect(called).toBe(false);
});

const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;

async function cliFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-remove-data-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    JSON.stringify({ services: { db: { image: `sha256:${id}` } } })
  );
  await writeFile(
    join(project, ".hack", "hack.config.json"),
    JSON.stringify({ name: "remove-data-fixture" })
  );
  const nativeHome = join(root, "native-home");
  await mkdir(nativeHome, { mode: 0o700 });
  const calls = join(root, "calls");
  const binary = join(root, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  const cli = async (args: readonly string[], backend: string) => {
    const child = Bun.spawn(
      [process.execPath, entrypoint, "--path", project, ...args],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          env: {
            HACK_RUNTIME_BACKEND: backend,
            HACK_NATIVE_BINARY: binary,
            HACK_NATIVE_HOME: nativeHome,
            HACK_NO_INTERACTIVE: "1",
            HACK_LOGGER: "console",
            HACK_DAEMON_AUTOSTART_DISABLE: "1",
          },
        }),
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
    const requested = await Bun.file(calls)
      .text()
      .catch(() => "");
    return { code, output: stdout + stderr, requested };
  };
  return { cli };
}

test(
  "native down --remove-data --json needs --yes and an unstarted project requests nothing",
  async () => {
    const f = await cliFixture();
    const json = await f.cli(["down", "--remove-data", "--json"], "native");
    expect(json.code).toBe(1);
    expect(json.output).toContain("E_INTERACTIVE_REQUIRED");
    expect(json.output).toContain("--remove-data --yes");
    // Without a saved run there is nothing to confirm or remove.
    for (const args of [
      ["down", "--remove-data"],
      ["down", "--remove-data", "--yes"],
    ]) {
      const result = await f.cli(args, "native");
      expect(result.code).toBe(0);
      expect(result.output).toContain("Native project is not started");
      expect(result.requested).toBe("");
    }
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "--remove-data combinations outside native removal are usage errors",
  async () => {
    const f = await cliFixture();
    const pruning = await f.cli(
      ["down", "--remove-data", "--prune-caches", "--yes"],
      "native"
    );
    expect(pruning.code).not.toBe(0);
    expect(pruning.output).toContain(
      "Native down --remove-data does not support"
    );
    const yesOnly = await f.cli(["down", "--yes"], "native");
    expect(yesOnly.code).not.toBe(0);
    expect(yesOnly.output).toContain("--yes confirms --remove-data");
    const compose = await f.cli(["down", "--remove-data", "--yes"], "compose");
    expect(compose.code).not.toBe(0);
    expect(compose.output).toContain(
      "--remove-data applies to the native backend only"
    );
    expect(compose.requested).toBe("");
  },
  SPAWN_TIMEOUT_MS * 2
);
