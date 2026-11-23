import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectExec } from "../src/backends/native-project-exec.ts";
import { nativeProjectPs } from "../src/backends/native-project-observe.ts";
import {
  type NativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { startNativeProject } from "../src/backends/native-project-start.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { requireNativeSetup } from "../src/backends/native-runtime-setup.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";

/**
 * Runtime request budgets (HACK-2445). Each one-shot runtime request starts a
 * process (about 21 ms each on the reference Mac), so the number of requests
 * an ordinary command makes is part of its cost. These tests run the real
 * review, retained-image and observation code against a fake runtime and pin
 * the exact request sequence, so a duplicate request cannot creep back
 * unnoticed. A deliberate new request updates the list here with its reason.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const COMPOSE = JSON.stringify({
  services: { web: { image: `sha256:${"e".repeat(64)}` } },
});
const SHA = createHash("sha256").update(COMPOSE).digest("hex");
const NAMESPACE = "b".repeat(64);
const PLAN = "a".repeat(64);
const OWNER = "c".repeat(32);
const CONTAINER = "f".repeat(64);
const GENERATION = "9".repeat(64);

async function project() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-call-budget-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(join(root, ".hack/docker-compose.yml"), COMPOSE);
  await writeFile(join(root, "hack-relay-guest"), "synthetic relay artifact");
  return {
    root,
    runtime: { binary: join(root, "hack-local"), home: root },
    scope: {
      projectRoot: root,
      projectDir: join(root, ".hack"),
      nativeHome: root,
      branch: null,
    },
    composeFile: join(root, ".hack/docker-compose.yml"),
  };
}

/** A fake runtime that answers the requests these commands make. */
function fakeRuntime(opts: {
  readonly root: string;
  readonly state: { run: string; ready: boolean };
}) {
  const calls: string[] = [];
  const graph = () => ({
    journal_incomplete: false,
    receipt: {
      run: opts.state.run,
      owner: OWNER,
      namespace: NAMESPACE,
      plan_id: PLAN,
      phase: opts.state.ready ? "ready-observed" : "stopped-data-retained",
      // A foreground owner serves the graph.
      relay_startup: {},
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: CONTAINER,
          phase: "started",
        },
      },
    },
    observations: {
      "container:web": { state: opts.state.ready ? "running" : "absent" },
    },
  });
  const invoke: typeof invokeNativeRuntime = async (request) => {
    const [group = "", action = ""] = request.args;
    calls.push(`${group} ${action}`);
    switch (`${group} ${action}`) {
      case "project plan": {
        const normalized = request.args.includes("--normalized-file");
        return normalized
          ? {
              plan_id: PLAN,
              start_refusals: [],
              plan: {
                namespace: NAMESPACE,
                compose_sha256: SHA,
                enrollment_compatible: true,
                services: { web: { active: true } },
              },
            }
          : {
              plan: {
                namespace: NAMESPACE,
                compose_sha256: SHA,
                source: opts.root,
              },
            };
      }
      case "project source-size":
        return nativeSourceSizeReceipt();
      case "runtime check-project-share":
        return { source_admitted: true, pool_initialized: true };
      case "runtime status":
        return {
          phase: "running",
          process_alive: true,
          guest_boot_id: "12345678-1234-1234-1234-123456789abc",
        };
      case "graph inspect":
        return graph();
      case "graph status":
        return graph();
      case "graph owner-status":
        return {
          ok: true,
          run: opts.state.run,
          plan: PLAN,
          phase: "ready-observed",
          foreground_alive: true,
          runtime_verified: true,
        };
      case "graph refresh-dependencies":
        return {
          ok: true,
          run: opts.state.run,
          plan: PLAN,
          owner: OWNER,
          namespace: NAMESPACE,
          generation: GENERATION,
          changed_slots: [],
        };
      case "graph exec-selection":
        return {
          run: opts.state.run,
          owner: OWNER,
          namespace: NAMESPACE,
          plan: PLAN,
          service: "web",
          container: CONTAINER,
          generation: GENERATION,
        };
      case "graph dependency-plan":
        return { dependency_plan_id: "d".repeat(64) };
      case "graph exec":
        return {
          exit_code: 0,
          stdout_base64: "",
          stderr_base64: "",
          truncated: false,
        };
      default:
        return {};
    }
  };
  return { calls, invoke };
}

test("a fresh native up makes exactly these runtime requests", async () => {
  const p = await project();
  const state = { run: "", ready: false };
  const runtime = fakeRuntime({ root: p.root, state });
  const code = await startNativeProject({
    runtime: p.runtime,
    scope: p.scope,
    composeFile: p.composeFile,
    sharedSource: true,
    before: async () => ({ cleanup: async () => {} }),
    dependencies: {
      invoke: runtime.invoke,
      prepareStorage: async () => {},
      prepare: async () => ({
        originalSha256: SHA,
        normalizedComposeJson: COMPOSE,
        managedEnvironment: {},
        lifecycleHostEnvironment: {},
        environmentFiles: [],
        effectiveEnvName: null,
        serviceNames: ["web"],
      }),
      serve: async (request) => {
        state.run = request.run;
        state.ready = true;
        try {
          await request.onReady();
          return 0;
        } finally {
          state.ready = false;
        }
      },
    },
  });
  expect(code).toBe(0);
  expect(runtime.calls).toEqual([
    // Static review before hooks: original identity, then normalized input.
    "project plan",
    "project plan",
    "runtime check-project-share",
    "runtime up",
    // Final review after image pinning reuses the static review's original
    // identity; the normalized plan re-reads and checks the original file.
    "project plan",
    // The run mapping at started, read lease-free (the owner holds the provider
    // lease until ready), then the final leased inspection after the stop.
    "graph status",
    "graph inspect",
  ]);
});

async function savedRun(p: Awaited<ReturnType<typeof project>>) {
  const run: NativeProjectRun = {
    run: "1".repeat(32),
    owner: OWNER,
    namespace: NAMESPACE,
    planId: PLAN,
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  await saveNativeProjectRun({ ...p.scope, run });
  return run;
}

test("native ps of a ready run makes exactly these runtime requests", async () => {
  const p = await project();
  const run = await savedRun(p);
  const runtime = fakeRuntime({
    root: p.root,
    state: { run: run.run, ready: true },
  });
  const result = await nativeProjectPs({
    runtime: p.runtime,
    scope: p.scope,
    invoke: runtime.invoke,
  });
  expect(result.status).toBe("observed");
  expect(runtime.calls).toEqual(["graph status", "graph owner-status"]);
});

test("native exec makes exactly these runtime requests", async () => {
  const p = await project();
  const run = await savedRun(p);
  const runtime = fakeRuntime({
    root: p.root,
    state: { run: run.run, ready: true },
  });
  const result = await nativeProjectExec({
    runtime: p.runtime,
    scope: p.scope,
    service: "web",
    argv: ["true"],
    composeFile: p.composeFile,
    invoke: runtime.invoke,
  });
  expect(result.exitCode).toBe(0);
  expect(runtime.calls).toEqual([
    // `up` may have returned at started: one look whether the run is warming
    // (it is ready here, so nothing waits).
    "graph status",
    "graph owner-status",
    "graph refresh-dependencies",
    // Before: container status and the foreground owner's liveness.
    "graph status",
    "graph owner-status",
    "graph exec-selection",
    "graph exec",
    // After: the same run and container still serve the service, and the
    // owner still verifies its runtime (publishers, host dependencies).
    "graph status",
    "graph owner-status",
  ]);
});

test("the detached owner trusts its launcher's setup inspection", async () => {
  const p = await project();
  let inspected = 0;
  const inspect = async () => {
    inspected += 1;
    return { state: "ready" } as Awaited<
      ReturnType<
        NonNullable<Parameters<typeof requireNativeSetup>[0]["inspect"]>
      >
    >;
  };
  const opts = { runtime: p.runtime, cwd: p.root, json: true, inspect };
  expect(await requireNativeSetup({ ...opts, detachedOwner: false })).toBe(0);
  expect(inspected).toBe(1);
  expect(await requireNativeSetup({ ...opts, detachedOwner: true })).toBe(0);
  expect(inspected).toBe(1);
});

test("exec refuses when the owner stops verifying its runtime during the command", async () => {
  const p = await project();
  const run = await savedRun(p);
  const runtime = fakeRuntime({
    root: p.root,
    state: { run: run.run, ready: true },
  });
  let executed = false;
  const invoke: typeof invokeNativeRuntime = async (request) => {
    const reply = await runtime.invoke(request);
    if (request.args[1] === "exec") {
      executed = true;
    }
    // A host dependency listener went away after the command ran: the owner
    // is alive but no longer verifies its runtime.
    return executed && request.args[1] === "owner-status"
      ? { ...(reply as Record<string, unknown>), runtime_verified: false }
      : reply;
  };
  await expect(
    nativeProjectExec({
      runtime: p.runtime,
      scope: p.scope,
      service: "web",
      argv: ["true"],
      composeFile: p.composeFile,
      invoke,
    })
  ).rejects.toThrow("Native exec identity or response is unconfirmed");
});
