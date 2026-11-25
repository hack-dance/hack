import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_ENDED_BOOT_OWNER_NOTICE } from "../src/backends/native-ended-boot-owner.ts";
import { renderNativeHotReloadNotice } from "../src/backends/native-hot-reload-notice.ts";
import {
  type acquireNativeHttpsLease,
  NativeHttpsLeaseAcquisitionError,
} from "../src/backends/native-https-owner.ts";
import { NativeHttpsStartupError } from "../src/backends/native-https-startup-failure.ts";
import { NATIVE_IMAGE_ENSURE_TIMEOUT_MS } from "../src/backends/native-image-policy.ts";
import { selectNativeProfiles } from "../src/backends/native-profile-selection.ts";
import {
  admitNativeProjectBuilds,
  NativeBuildRegistryError,
  nativeBuildIdentity,
} from "../src/backends/native-project-builds.ts";
import { nativeProjectDown } from "../src/backends/native-project-down.ts";
import { discardUnpublishedNativeStart } from "../src/backends/native-project-failed-start.ts";
import {
  admitNativeProjectFinalization,
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import { nativeProjectPs } from "../src/backends/native-project-observe.ts";
import { verifyNativeFrontendRecovery } from "../src/backends/native-project-recovery.ts";
import { restartNativeProject } from "../src/backends/native-project-restart.ts";
import {
  nativeRestartSelection,
  preflightNativeRestart,
} from "../src/backends/native-project-restart-preflight.ts";
import { selectNativeRetainedImages } from "../src/backends/native-project-retained-images.ts";
import {
  inspectNativeProjectRunMapping,
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunForeignHomeInspection,
  releaseNativeProjectRunForeignHome,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import {
  NATIVE_CONFIGURATION_REFUSAL,
  NATIVE_SHARED_SOURCE_REFUSAL,
  NativeStartupCanceledError,
  type NativeStartupProgress,
  nativeReadinessArgs,
  nativeReadySummary,
  nativeStoppedNotice,
  parseNativeHttpsSelection,
  prepareNativeProjectServices,
  reviewedNativeHttpsRoutes,
  startedServiceSummary,
  startNativeProject,
  verifyHttpsRoutes,
} from "../src/backends/native-project-start.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  nativeRuntimeFailure,
} from "../src/backends/native-runtime-client.ts";
import { NATIVE_EXITED_RUNTIME_NOTICE } from "../src/backends/native-runtime-preflight.ts";
import { watchNativeStartPool } from "../src/backends/native-start-pool-watch.ts";
import { ClosedCliError, HackCliError } from "../src/lib/cli-result.ts";
import {
  type ComposeEnvFingerprintRecord,
  evaluateComposeServiceEnvFreshness,
} from "../src/lib/compose-env-fingerprint.ts";
import { isRecord } from "../src/lib/guards.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";
import { mkdirOwnedFixture } from "./helpers/owned-fixture.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
/** Commands the runtime answers without the provider lease. */
const LEASE_FREE = new Set([
  "graph status",
  "graph observe",
  "graph owner-status",
  "runtime status",
]);
async function fixture(withEnvironment = true) {
  const root = await mkdtemp(join(tmpdir(), "native-start-test-"));
  roots.push(root);
  await mkdirOwnedFixture(join(root, ".hack"));
  await writeFile(
    join(root, "hack-relay-guest"),
    "synthetic public test artifact"
  );
  const events: string[] = [];
  // Set once a serve request starts: later inspections describe that run.
  // `leaseHeld` models the owner holding the provider lease from its started
  // line until its ready line: every leased command is refused meanwhile.
  const state = {
    serving: false,
    leaseHeld: false,
    refused: [] as string[],
  };
  let run = "";
  let ready = false;
  // A retained-data removal request makes later inspections report removal.
  let dataRemoved = false;
  const planId = "a".repeat(64),
    namespace = "b".repeat(64),
    owner = "c".repeat(32);
  const managedEnvironment: Record<
    string,
    Record<string, string>
  > = withEnvironment ? { web: { TOKEN: "synthetic-secret" } } : {};
  const dependencies: NonNullable<
    Parameters<typeof startNativeProject>[0]["dependencies"]
  > = {
    staticReview: async () => undefined,
    prepareStorage: async () => {},
    retainedImages: async () => new Map(),
    load: async () => null,
    loadRestart: async () => null,
    save: async () => {
      events.push("save");
    },
    remove: async () => {
      events.push("remove");
    },
    prepare: async () => ({
      originalSha256: "d".repeat(64),
      normalizedComposeJson: JSON.stringify({
        services: { web: { image: `sha256:${"e".repeat(64)}` } },
      }),
      managedEnvironment,
      lifecycleHostEnvironment: {},
      environmentFiles: [],
      effectiveEnvName: null,
      serviceNames: ["web"],
    }),
    review: async (opts) =>
      opts.run({
        planId,
        namespace,
        projectArgs: ["--project", root],
        report: {
          plan: {
            enrollment_compatible: true,
            services: { web: { active: true } },
          },
        },
      }),
    invoke: async (opts) => {
      if (state.leaseHeld && !LEASE_FREE.has(opts.args.slice(0, 2).join(" "))) {
        state.refused.push(opts.args.slice(0, 2).join(" "));
        throw new NativeRuntimeRequestError({
          message:
            "Native runtime request failed (provider_busy); inspect owned state before retrying.",
          nativeCode: "provider_busy",
        });
      }
      if (opts.args[1] === "ensure-images") {
        const jobs = JSON.parse(
          new TextDecoder().decode(opts.privateInput)
        ) as [string, string][];
        return await Promise.all(
          jobs.map(async ([reference, policy], index) => {
            try {
              const args = [
                "runtime",
                "ensure-image",
                "--reference",
                reference,
                ...(policy === "native" ? [] : ["--emulation", policy]),
                "--json",
              ];
              return [
                index,
                {
                  Ok: await dependencies.invoke!({
                    ...opts,
                    args,
                    privateInput: undefined,
                  }),
                },
                1,
              ];
            } catch (error) {
              return [
                index,
                {
                  Err: {
                    code:
                      error instanceof NativeRuntimeRequestError
                        ? error.nativeCode
                        : "fixture",
                  },
                },
                1,
              ];
            }
          })
        );
      }
      if (opts.args[1] === "source-size") {
        return nativeSourceSizeReceipt();
      }
      if (opts.args[1] === "check-project-share") {
        return { source_admitted: true, pool_initialized: false };
      }
      if (opts.args[1] === "admit-image") {
        return { reference: opts.args[3], kind: "docker_hub" };
      }
      events.push(opts.args.slice(0, 2).join(" "));
      if (opts.args[1] === "dependency-check") {
        return { listener_confirmed: true };
      }
      if (opts.args[0] === "runtime" && opts.args[1] === "status") {
        return {
          phase: "running",
          process_alive: true,
          guest_boot_id: "12345678-1234-1234-1234-123456789abc",
        };
      }
      if (opts.args[1] === "dependency-plan") {
        return { dependency_plan_id: "f".repeat(64) };
      }
      if (opts.args[1] === "cleanup" && opts.args.includes("--remove-data")) {
        dataRemoved = true;
        return {};
      }
      if (opts.args[1] === "inspect" || opts.args[1] === "status") {
        let phase = "stopped-data-retained";
        if (ready) {
          phase = "ready-observed";
        } else if (dataRemoved) {
          phase = "removed";
        }
        return {
          journal_incomplete: false,
          receipt: {
            run,
            owner,
            namespace,
            plan_id: planId,
            phase,
            resources: {
              "container:web": {
                kind: "container",
                key: "web",
                id: "f".repeat(64),
                phase: "started",
              },
            },
          },
          observations: {
            "container:web": { state: ready ? "running" : "absent" },
          },
        };
      }
      return {};
    },
    serve: async (opts) => {
      state.serving = true;
      run = opts.run;
      ready = true;
      if (withEnvironment) {
        expect(new TextDecoder().decode(opts.privateInput)).toContain(
          "synthetic-secret"
        );
      } else {
        expect(opts.privateInput).toBeUndefined();
        expect(opts.args).not.toContain("--environment-stdin");
      }
      expect(opts.args.join(" ")).not.toContain("synthetic-secret");
      try {
        // As the owner does: started first, holding the provider lease, then
        // ready once the lease is released (see returnAtStarted).
        state.leaseHeld = true;
        if (opts.returnAtStarted) {
          await opts.onReady();
          state.leaseHeld = false;
          opts.onAllReady?.();
        } else {
          await opts.onStarted?.();
          state.leaseHeld = false;
          await opts.onReady();
        }
        return 0;
      } finally {
        state.leaseHeld = false;
        ready = false;
      }
    },
  };
  const opts = {
    runtime: { binary: join(root, "hack-local"), home: root },
    scope: {
      projectRoot: root,
      projectDir: join(root, ".hack"),
      nativeHome: root,
      branch: null,
    },
    composeFile: join(root, ".hack/docker-compose.yml"),
    sharedSource: true,
    // These tests cover the ready-time path (`up --wait`); started returns
    // are tested on their own below.
    waitForReady: true,
    before: async () => {
      events.push("before");
      return {
        cleanup: async () => {
          events.push("cleanup");
        },
        ready: async () => {
          events.push("ready");
        },
      };
    },
    dependencies,
  };
  return { opts, events, state };
}
function stoppedGraph(run: NativeProjectRun) {
  return {
    journal_incomplete: false,
    receipt: {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      phase: "stopped-data-retained",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id: "f".repeat(64),
          phase: "started",
        },
      },
    },
    observations: { "container:web": { state: "absent" } },
  };
}
function retainedPreflight(run: NativeProjectRun, phase = "running") {
  return {
    version: 1,
    run: run.run,
    owner: run.owner,
    namespace: run.namespace,
    plan: run.planId,
    runtime_phase: phase,
    selection: "7".repeat(64),
    live_resources_verified: false,
  };
}
async function acknowledgeRetainedFrontend(
  scope: Awaited<ReturnType<typeof fixture>>["opts"]["scope"],
  run: NativeProjectRun
) {
  const lifetime = await beginNativeProjectFinalization({ scope, run });
  await lifetime.complete();
  return lifetime;
}
async function retainedFinalizationFixture() {
  const { opts, events, state } = await fixture(false);
  const saved: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  opts.dependencies.load = async () => saved;
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "retained-preflight") {
      events.push("graph retained-preflight");
      return retainedPreflight(saved);
    }
    if (request.args[1] === "inspect" && !state.serving) {
      events.push("graph inspect");
      return stoppedGraph(saved);
    }
    return request.args[1] === "restore-selection"
      ? { ...saved, plan: saved.planId, generation: "2".repeat(64) }
      : await invoke(request);
  };
  opts.dependencies.prepareStorage = async () => {
    events.push("storage");
  };
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    events.push("prepare");
    return await prepare(request);
  };
  return { opts, events, saved, state };
}
test("source pool mismatch refuses before hooks and storage preparation", async () => {
  const { opts, events } = await fixture();
  opts.dependencies.prepareStorage = async () => {
    events.push("storage");
  };
  const invoke = opts.dependencies.invoke;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "check-project-share") {
      throw new Error("source pool mismatch");
    }
    return await invoke?.(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "source pool mismatch"
  );
  expect(events).toEqual([]);
});

const OVERSIZED = 140 * 1024 * 1024;

test("oversized captured source refuses before hooks, image and runtime work", async () => {
  // A bind mount (shared source) and a dependency cache (published revision) are
  // the two ways startup captures source; both keep the limit.
  for (const web of [
    { image: `sha256:${"e".repeat(64)}`, volumes: ["./src:/app:ro"] },
    {
      image: `sha256:${"e".repeat(64)}`,
      volumes: ["modules:/app/node_modules"],
      labels: { "hack.dependencies.cache-volume": "modules" },
    },
  ]) {
    const { opts, events } = await fixture();
    const prepare = opts.dependencies.prepare!;
    opts.dependencies.prepare = async (request) => ({
      ...(await prepare(request)),
      normalizedComposeJson: JSON.stringify({ services: { web } }),
    });
    const requests: string[] = [];
    const invoke = opts.dependencies.invoke;
    opts.dependencies.invoke = async (request) => {
      requests.push(request.args.slice(0, 2).join(" "));
      if (request.args[1] === "source-size") {
        expect(request.args).toEqual([
          "project",
          "source-size",
          "--project",
          opts.scope.projectRoot,
          "--json",
        ]);
        return nativeSourceSizeReceipt({ totalBytes: OVERSIZED });
      }
      return await invoke?.(request);
    };
    const refusal = await startNativeProject(opts).catch(
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(HackCliError);
    expect((refusal as HackCliError).code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
    expect((refusal as HackCliError).message).toContain(
      "Native up refuses source over the limit; no runtime, image or build work was started. Largest directories: assets"
    );
    expect(requests).toEqual([
      "runtime check-project-share",
      "project source-size",
    ]);
    expect(events).toEqual([]);
  }
});

test("an image-only graph starts above the source limit without measuring source", async () => {
  // No bind mount and no dependency cache: the runtime never reads source content,
  // so unrelated checkout files over the limit do not block startup.
  const { opts, events } = await fixture();
  const requests: string[] = [];
  const invoke = opts.dependencies.invoke;
  opts.dependencies.invoke = async (request) => {
    requests.push(request.args.slice(0, 2).join(" "));
    if (request.args[1] === "source-size") {
      return nativeSourceSizeReceipt({ totalBytes: OVERSIZED });
    }
    return await invoke?.(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(requests).not.toContain("project source-size");
  expect(events).toContain("before");
  expect(events).toContain("save");
});

test("foreground saves after readiness and retains mapping after confirmed stop", async () => {
  const { opts, events } = await fixture();
  expect(await startNativeProject(opts)).toBe(0);
  // No host dependency: the plan ID is computed without a runtime call.
  expect(events).toEqual([
    "before",
    "runtime up",
    "graph status",
    "save",
    "ready",
    "graph inspect",
    "cleanup",
  ]);
});

test("a pool bridge boot failure reaches foreground up with recovery guidance before any project mapping", async () => {
  const { opts, events } = await fixture(false);
  const message =
    "Native bridge sockets did not become private and owned before the startup deadline. Run the same selected executor with the identical --candidate-root argument used for the failed start, followed by runtime recover --json before retrying.";
  await writeFile(
    opts.runtime.binary,
    `#!/usr/bin/env bun
console.error(JSON.stringify({ code: "bridge_socket_timeout", message: ${JSON.stringify(message)}, message_fixed: true, private_detail: "synthetic-secret" }));
process.exit(2);
`
  );
  await chmod(opts.runtime.binary, 0o755);
  const invoke = opts.dependencies.invoke;
  opts.dependencies.invoke = async (request) => {
    if (request.args[0] === "runtime" && request.args[1] === "up") {
      return await invokeNativeRuntime(request);
    }
    return await invoke?.(request);
  };
  const failure: unknown = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(ClosedCliError);
  expect(String(failure)).toContain("runtime recover --json");
  expect(String(failure)).toContain("--candidate-root");
  expect(String(failure)).not.toContain("synthetic-secret");
  expect(nativeRuntimeFailure(failure)?.code).toBe("bridge_socket_timeout");
  expect(events).not.toContain("save");
  expect(events).not.toContain("ready");
  expect(events).toContain("cleanup");
});
test("foreground reports value-free digests of the selected env after publishing the mapping", async () => {
  const { opts, events } = await fixture();
  const seen: { run: string; fingerprint: ComposeEnvFingerprintRecord }[] = [];
  expect(
    await startNativeProject({
      ...opts,
      onEnvironmentReady: async (selection) => {
        events.push("environment");
        seen.push(selection);
      },
    })
  ).toBe(0);
  expect(events.indexOf("environment")).toBe(events.indexOf("save") + 1);
  expect(events.indexOf("environment")).toBeLessThan(events.indexOf("ready"));
  expect(seen).toHaveLength(1);
  const [selection] = seen;
  expect(selection?.run).toMatch(/^[a-f0-9]{32}$/);
  expect(JSON.stringify(selection)).not.toContain("synthetic-secret");
  expect(JSON.stringify(selection)).not.toContain("TOKEN");
  expect(
    evaluateComposeServiceEnvFreshness({
      record: selection?.fingerprint,
      service: "web",
      currentEnv: { TOKEN: "synthetic-secret" },
    })
  ).toBe("unchanged");
  expect(
    evaluateComposeServiceEnvFreshness({
      record: selection?.fingerprint,
      service: "web",
      currentEnv: { TOKEN: "synthetic-edited" },
    })
  ).toBe("changed");
});
test("a failing env digest observer never fails foreground startup", async () => {
  const { opts, events } = await fixture(false);
  expect(
    await startNativeProject({
      ...opts,
      onEnvironmentReady: () => Promise.reject(new Error("unwritable")),
    })
  ).toBe(0);
  expect(events).toContain("ready");
});
test("uncertain foreground failure retains published mapping and cleans lifecycle listeners", async () => {
  const { opts, events } = await fixture();
  const original = opts.dependencies.serve;
  const inspect = opts.dependencies.invoke;
  let failed = false;
  opts.dependencies.invoke = async (args) => {
    if (failed) {
      throw new Error("uncertain");
    }
    return await inspect?.(args);
  };
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    failed = true;
    throw new Error("uncertain");
  };
  const int = process.listenerCount("SIGINT"),
    term = process.listenerCount("SIGTERM");
  await expect(startNativeProject(opts)).rejects.toThrow(
    "cleanup is unconfirmed"
  );
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
  expect(process.listenerCount("SIGINT")).toBe(int);
  expect(process.listenerCount("SIGTERM")).toBe(term);
});

test("failed startup recovers exact pending cleanup and still reports the startup failure", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let selectedRun = "";
  let recovered = false;
  let removed = false;
  const requests: string[] = [];
  opts.dependencies.serve = async (request) => {
    selectedRun = request.run;
    throw new Error(
      "Native graph startup failed (engine_rejected); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "cleanup") {
      requests.push(request.args.join(" "));
      removed = true;
      return {};
    }
    if (request.args[1] === "inspect-interrupted-start-cleanup") {
      requests.push(request.args[1]);
      return {
        run: selectedRun,
        phase: "cleanup-intent",
        eligible: true,
        same_boot: true,
        data_retained: true,
        selection_sha256: "1".repeat(64),
      };
    }
    if (request.args[1] === "recover-interrupted-start-cleanup") {
      requests.push(request.args[1]);
      recovered = true;
      return {
        run: selectedRun,
        phase: "stopped-data-retained",
        recovered: true,
        data_retained: true,
        same_boot: true,
        publisher_retired: true,
        reservation_released: true,
      };
    }
    if (request.args[1] === "inspect") {
      requests.push(request.args[1]);
      const value = stoppedGraph({
        run: selectedRun,
        owner: "c".repeat(32),
        namespace: "b".repeat(64),
        planId: "a".repeat(64),
      });
      if (!recovered) {
        value.receipt.phase = "cleanup-intent";
        value.observations["container:web"].state = "present";
        return {
          ...value,
          receipt: { ...value.receipt, relay_cleanup: { phase: "pending" } },
        };
      }
      if (removed) {
        value.receipt.phase = "removed";
      }
      return value;
    }
    return invoke(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "Native graph startup failed (engine_rejected)"
  );
  // The unpublished fresh graph's data is removed only after recovery
  // confirmed compute cleanup; the startup failure is still reported.
  expect(requests).toEqual([
    "inspect",
    "inspect-interrupted-start-cleanup",
    "recover-interrupted-start-cleanup",
    "inspect",
    `graph cleanup --run-id ${selectedRun} --remove-data --json`,
    "inspect",
  ]);
  expect(events).not.toContain("ready");
  expect(events).not.toContain("save");
  expect(events.at(-1)).toBe("cleanup");
});
/** A started graph whose foreground failed before Ready and could not clean up. */
function failedStartupFixture(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  receipt: { readonly journalIncomplete?: boolean } = {}
) {
  const { opts, events } = fixtureValue;
  const invoke = opts.dependencies.invoke!;
  const selected = { run: "" };
  opts.dependencies.serve = async (request) => {
    selected.run = request.run;
    throw new Error(
      "Native graph startup was interrupted or failed (unaudited_provider_config); inspect owned state before retrying."
    );
  };
  opts.dependencies.save = async (request) => {
    events.push("save");
    await saveNativeProjectRun(request);
  };
  opts.dependencies.finalization = async (request) => {
    events.push("finalization");
    const lifetime = await beginNativeProjectFinalization(request);
    return {
      ...lifetime,
      complete: async () => {
        events.push("finalization-complete");
        await lifetime.complete();
      },
    };
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect" || request.args[1] === "status") {
      events.push(`graph ${request.args[1]}`);
      return {
        journal_incomplete: receipt.journalIncomplete === true,
        receipt: {
          run: selected.run,
          owner: "c".repeat(32),
          namespace: "b".repeat(64),
          plan_id: "a".repeat(64),
          phase: "ready-observed",
          relay_startup: { control_only: true },
          resources: {
            "container:web": {
              kind: "container",
              key: "web",
              id: "f".repeat(64),
              phase: "started",
            },
          },
        },
        observations: { "container:web": { state: "running" } },
      };
    }
    if (request.args[1] === "owner-status") {
      throw new Error("synthetic dead foreground owner");
    }
    return await invoke(request);
  };
  return selected;
}

test("a post-start failure whose cleanup is unconfirmed records the run for ps and down", async () => {
  const value = await fixture(false);
  const { opts, events } = value;
  const selected = failedStartupFixture(value);
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(ClosedCliError);
  const message = (failure as Error).message;
  expect(message).toContain("cleanup is unconfirmed");
  expect(message).toContain("(unaudited_provider_config)");
  expect(message).toContain(
    `The failed run ${selected.run} is recorded as this project's run mapping`
  );
  // Readiness never happened: no hooks ran, and nothing claims finalization.
  expect(events).not.toContain("ready");
  expect(events).not.toContain("remove");
  expect(events).not.toContain("finalization-complete");
  expect(events.indexOf("finalization")).toBeGreaterThan(-1);
  expect(events.indexOf("finalization")).toBeLessThan(events.indexOf("save"));
  expect(events.at(-1)).toBe("cleanup");
  const mapping = {
    run: selected.run,
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  expect(await loadNativeProjectRun(opts.scope)).toEqual(mapping);
  // ps selects the recorded run and reports its stale owner instead of "not started".
  const ps = await nativeProjectPs({
    runtime: opts.runtime,
    scope: opts.scope,
    invoke: opts.dependencies.invoke,
  });
  expect(ps).toMatchObject({
    status: "owner_unconfirmed",
    run: selected.run,
    phase: "ready-observed",
  });
  expect(ps.items).toEqual([
    expect.objectContaining({ service: "web", state: "running" }),
  ]);
});

test("a failed gcloud start's recorded owner keeps the ADC mode for restart", async () => {
  const value = await fixture(false);
  const { opts } = value;
  opts.dependencies.adaptGcloud = async ({ input, mode }) => ({
    input,
    receipt: { mode, types: ["authorized_user"], services: ["web"] },
  });
  const selected = failedStartupFixture(value);
  const failure = await startNativeProject({
    ...opts,
    gcloud: { mode: "file" },
  }).catch((error: unknown) => error);
  expect((failure as Error).message).toContain(
    `The failed run ${selected.run} is recorded as this project's run mapping`
  );
  const recorded = await loadNativeProjectRun(opts.scope);
  expect(recorded?.gcloud).toEqual({ mode: "file" });
  // Restart re-applies the recorded ADC adapter instead of dropping it.
  expect(nativeRestartSelection({ run: recorded! }).gcloud).toEqual({
    mode: "file",
  });
});

test("a post-start failure with an unauthenticated receipt records no owner", async () => {
  const value = await fixture(false);
  const { opts, events } = value;
  failedStartupFixture(value, { journalIncomplete: true });
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain("is recorded");
  expect(events).not.toContain("finalization");
  expect(events).not.toContain("save");
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});

test("a retained run's post-start failure keeps its existing mapping unchanged", async () => {
  const { opts, events, saved, state } = await retainedFinalizationFixture();
  await acknowledgeRetainedFrontend(opts.scope, saved);
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.serve = async () => {
    state.serving = true;
    throw new Error(
      "Native graph startup failed (engine_rejected); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect" && state.serving) {
      return {
        ...stoppedGraph(saved),
        observations: { "container:web": { state: "running" } },
      };
    }
    return await invoke(request);
  };
  opts.dependencies.save = async () => {
    events.push("save");
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "cleanup is unconfirmed"
  );
  expect(events).not.toContain("save");
});

function failingFreshServe(
  opts: Awaited<ReturnType<typeof fixture>>["opts"],
  requests: string[]
) {
  const invoke = opts.dependencies.invoke!;
  let selectedRun = "";
  let removed = false;
  opts.dependencies.serve = async (request) => {
    selectedRun = request.run;
    throw new Error(
      "Native graph startup failed (graph_startup_application_failed); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "cleanup") {
      requests.push(request.args.join(" "));
      removed = true;
      return {};
    }
    if (request.args[1] === "inspect") {
      requests.push("inspect");
      const value = stoppedGraph({
        run: selectedRun,
        owner: "c".repeat(32),
        namespace: "b".repeat(64),
        planId: "a".repeat(64),
      });
      value.receipt.phase = removed ? "removed" : "stopped-data-retained";
      return value;
    }
    return await invoke(request);
  };
  return () => selectedRun;
}

test("a failed fresh start removes its unpublished graph data and keeps the startup failure", async () => {
  const { opts, events } = await fixture();
  const requests: string[] = [];
  const selectedRun = failingFreshServe(opts, requests);
  await expect(startNativeProject(opts)).rejects.toThrow(
    "graph_startup_application_failed"
  );
  expect(requests).toEqual([
    "inspect",
    `graph cleanup --run-id ${selectedRun()} --remove-data --json`,
    "inspect",
  ]);
  expect(events).not.toContain("save");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("a failed fresh start whose data removal is unconfirmed still reports the startup failure", async () => {
  const { opts } = await fixture();
  const requests: string[] = [];
  failingFreshServe(opts, requests);
  const notices: string[] = [];
  opts.dependencies.discardFailedStart = async (request) =>
    await discardUnpublishedNativeStart({
      ...request,
      warn: (line) => notices.push(line),
    });
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "cleanup") {
      throw new NativeRuntimeRequestError({
        message: "synthetic-do-not-print",
        nativeCode: "graph_cleanup_uncertain",
      });
    }
    return await invoke(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "graph_startup_application_failed"
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("(graph_cleanup_uncertain)");
  expect(notices[0]).toContain("--remove-data");
  expect(notices[0]).not.toContain("synthetic-do-not-print");
});

test("a restart policy the runtime does not apply is reported once per service and the start continues", async () => {
  const { opts } = await fixture();
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) =>
    await review({
      ...request,
      run: (reviewed) =>
        request.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true, restart: "unless-stopped" },
                worker: { active: true, restart: "always" },
              },
              diagnostics: [
                {
                  severity: "warning",
                  code: "restart_policy_not_applied",
                  field: "services.web.restart",
                  message: "fixed",
                },
              ],
            },
          },
        }),
    });
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  expect(await startNativeProject(opts)).toBe(0);
  const restart = notices.filter((line) => line.includes("HACK-1935"));
  // Only the warned service is named; `worker` keeps its policy silently.
  expect(restart).toEqual([
    "Service web: restart: unless-stopped is not applied. Restart policies are not applied yet to services with published ports or routes (HACK-1935); the service starts without automatic restarts.",
  ]);
});

test("HACK-2324: a privately delivered service starts without its restart policy and is named once", async () => {
  // The fixture delivers a managed value to web only.
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: { image: `sha256:${"e".repeat(64)}`, restart: "unless-stopped" },
        worker: { image: `sha256:${"e".repeat(64)}`, restart: "always" },
      },
    }),
  });
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) =>
    await review({
      ...request,
      run: (reviewed) =>
        request.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true, restart: "unless-stopped" },
                worker: { active: true, restart: "always" },
              },
              diagnostics: [],
            },
          },
        }),
    });
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  expect(await startNativeProject(opts)).toBe(0);
  expect(notices.filter((line) => line.includes("private values"))).toEqual([
    "Service web: restart: unless-stopped is not applied, because the service receives private values that native delivers once per container start. If it crashes it stays stopped until you run hack restart, which restarts the whole project with a fresh delivery.",
  ]);
  expect(notices.join("\n")).not.toContain("synthetic-secret");
});

test("HACK-2324: a service that receives only a private file keeps its restart policy and is not named", async () => {
  // The fixture delivers a managed value to web; worker gets only a file.
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: { image: `sha256:${"e".repeat(64)}` },
        worker: { image: `sha256:${"e".repeat(64)}`, restart: "always" },
      },
    }),
    managedFiles: {
      worker: [
        {
          name: "gcloud-adc.json",
          target: "/config/adc.json",
          content: Buffer.from("synthetic-adc-bytes"),
        },
      ],
    },
  });
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) =>
    await review({
      ...request,
      run: (reviewed) =>
        request.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true },
                worker: { active: true, restart: "always" },
              },
              diagnostics: [],
            },
          },
        }),
    });
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  expect(await startNativeProject(opts)).toBe(0);
  expect(notices.filter((line) => line.includes("private values"))).toEqual([]);
});

test("published, attempted or retained runs never have their data removed", async () => {
  // A successful start publishes its mapping before the graph stops.
  const published = await fixture();
  const seen: string[] = [];
  const invoke = published.opts.dependencies.invoke!;
  published.opts.dependencies.invoke = async (request) => {
    seen.push(request.args.join(" "));
    return await invoke(request);
  };
  expect(await startNativeProject(published.opts)).toBe(0);
  // A mapping write with a lost reply may still have published the run.
  const attempted = await fixture();
  attempted.opts.dependencies.save = async () => {
    throw new Error("synthetic lost mapping reply");
  };
  const attemptedInvoke = attempted.opts.dependencies.invoke!;
  attempted.opts.dependencies.invoke = async (request) => {
    seen.push(request.args.join(" "));
    return await attemptedInvoke(request);
  };
  await expect(startNativeProject(attempted.opts)).rejects.toThrow(
    "synthetic lost mapping reply"
  );
  expect(seen.some((args) => args.includes("--remove-data"))).toBe(false);
});

test("foreground partial shutdown is reported without selecting failed-start recovery", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let selectedRun = "";
  let partial = false;
  const requests: string[] = [];
  opts.dependencies.serve = async (request) => {
    selectedRun = request.run;
    await request.onReady();
    partial = true;
    throw new Error("synthetic-private-canary");
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] !== "inspect" && request.args[1] !== "status") {
      return invoke(request);
    }
    requests.push(request.args[1]);
    const value = stoppedGraph({
      run: selectedRun,
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
    });
    value.receipt.phase = partial ? "cleanup-intent" : "ready-observed";
    value.observations["container:web"].state = "running";
    if (!partial) {
      return value;
    }
    return {
      ...value,
      receipt: { ...value.receipt, relay_cleanup: { phase: "pending" } },
      pending_cleanup: { version: 1, kind: "partial_shutdown" },
      interrupted_start_cleanup_incomplete: false,
    };
  };
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(String(failure)).toContain("Native retaining shutdown is incomplete");
  expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
  // The mapping is read lease-free at started; the final inspection is leased.
  expect(requests).toEqual(["status", "inspect"]);
  expect(events).toContain("ready");
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
});

test("published ports pass frontend preparation; the runtime admits them", () => {
  const services = prepareNativeProjectServices({
    normalizedComposeJson: JSON.stringify({
      services: { web: { image: "busybox", ports: ["127.0.0.1:8080:80"] } },
    }),
  } as NativeProjectInput);
  expect(services.web?.ports).toEqual(["127.0.0.1:8080:80"]);
});

test.each([
  { build: "." },
  { restart: 1 },
])("an unsupported service setting %j is a coded configuration refusal", (setting) => {
  const refusal = (() => {
    try {
      prepareNativeProjectServices({
        normalizedComposeJson: JSON.stringify({
          services: { web: { image: "busybox", ...setting } },
        }),
      } as NativeProjectInput);
    } catch (error: unknown) {
      return error;
    }
  })();
  expect(refusal).toBeInstanceOf(HackCliError);
  expect(refusal).toMatchObject({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_CONFIGURATION_REFUSAL,
  });
});

test.each([
  { labels: { "hack.service.one-shot": "true" } },
  { labels: ["hack.service.one-shot=true"] },
])("native admission accepts Hack's exact one-shot marker %j", ({ labels }) => {
  const specs = prepareNativeProjectServices({
    normalizedComposeJson: JSON.stringify({
      services: { init: { image: "busybox", command: ["true"], labels } },
    }),
  } as NativeProjectInput);
  // The label is preserved for the native review; it is not rewritten here.
  expect(specs.init?.labels).toEqual(labels);
});

test.each([
  { labels: { "hack.service.one-shot": "false" } },
  { labels: { "hack.service.one-shot": true } },
  { labels: { "hack.service.one-shot.extra": "true" } },
  { labels: { "hack.service.other": "true" } },
  { labels: ["hack.service.one-shot"] },
  { labels: ["hack.service.one-shot=yes"] },
])("a near-miss one-shot label %j is a coded configuration refusal", ({
  labels,
}) => {
  const refusal = (() => {
    try {
      prepareNativeProjectServices({
        normalizedComposeJson: JSON.stringify({
          services: { init: { image: "busybox", labels } },
        }),
      } as NativeProjectInput);
    } catch (error: unknown) {
      return error;
    }
  })();
  expect(refusal).toBeInstanceOf(HackCliError);
  expect(refusal).toMatchObject({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_CONFIGURATION_REFUSAL,
  });
});

test.each([
  "no",
  "always",
  "unless-stopped",
  "on-failure",
  "on-failure:3",
])("restart policy %s is left to runtime graph admission", (restart) => {
  const services = prepareNativeProjectServices({
    normalizedComposeJson: JSON.stringify({
      services: { worker: { image: "busybox", restart } },
    }),
  } as NativeProjectInput);
  expect(services.worker?.restart).toBe(restart);
});

test("a canceled start reports cancellation, not the configuration refusal", async () => {
  const { opts, events } = await fixture();
  const refusal = await startNativeProject({
    ...opts,
    signal: AbortSignal.abort(),
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ClosedCliError);
  expect(refusal).not.toBeInstanceOf(HackCliError);
  expect(String(refusal)).toContain("Native foreground up was canceled");
  expect(String(refusal)).not.toContain(NATIVE_CONFIGURATION_REFUSAL);
  expect(events).toEqual([]);
});

/** An integrity or ownership refusal: closed, and never the configuration refusal. */
function expectIntegrityRefusal(refusal: unknown, text: string): void {
  expect(refusal).toBeInstanceOf(ClosedCliError);
  expect(refusal).not.toBeInstanceOf(HackCliError);
  expect(refusal).toHaveProperty("message", expect.stringContaining(text));
  expect(String(refusal)).not.toContain(NATIVE_CONFIGURATION_REFUSAL);
  expect(String(refusal)).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
}

test("an unconfirmed image selection reply is an integrity refusal, not a configuration refusal", async () => {
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: { web: { image: "redis:latest" } },
    }),
  });
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "ensure-image"
      ? { image_id: "not-a-content-id" }
      : await invoke(request);
  expectIntegrityRefusal(
    await startNativeProject(opts).catch((error: unknown) => error),
    "Native foreground up could not confirm the runtime image selection; inspect owned state before retrying."
  );
});

/** One pinned host listener binding for `web`, selected after hooks. */
function withHostDependency(
  opts: Awaited<ReturnType<typeof fixture>>["opts"]
): Awaited<ReturnType<typeof fixture>>["opts"] &
  Pick<Parameters<typeof startNativeProject>[0], "dependencyFile"> {
  const path = join(opts.scope.projectRoot, "host-selection.json");
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.extra_hosts = ["search.example.com:host-gateway"];
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const before = opts.before;
  opts.before = async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dependencies: [
          {
            service: "web",
            binding: "search",
            guest_port: 443,
            host_pid: 999,
            host_port: 8443,
            aliases: ["search.example.com"],
          },
        ],
      })
    );
    return await before();
  };
  return { ...opts, dependencyFile: path };
}

test("a graph with a host dependency asks the runtime for its dependency plan", async () => {
  const { opts, events } = await fixture();
  expect(await startNativeProject(withHostDependency(opts))).toBe(0);
  expect(events).toContain("graph dependency-plan");
});

test("an invalid host dependency plan reply is an integrity refusal", async () => {
  const fixed = await fixture();
  const events = fixed.events;
  const opts = withHostDependency(fixed.opts);
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "dependency-plan"
      ? { dependency_plan_id: "not-a-digest" }
      : await invoke(request);
  expectIntegrityRefusal(
    await startNativeProject(opts).catch((error: unknown) => error),
    "Native foreground up could not confirm the host dependency plan; inspect owned state before retrying."
  );
  expect(events).not.toContain("save");
});

test("a ready receipt for another namespace is an integrity refusal", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let serving = false;
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    serving = true;
    try {
      return await serve(request);
    } finally {
      serving = false;
    }
  };
  opts.dependencies.invoke = async (request) => {
    const reply = await invoke(request);
    if (request.args[1] === "status" && serving) {
      const graph = reply as { receipt: Record<string, unknown> };
      return {
        ...graph,
        receipt: { ...graph.receipt, namespace: "0".repeat(64) },
      };
    }
    return reply;
  };
  expectIntegrityRefusal(
    await startNativeProject(opts).catch((error: unknown) => error),
    "Native foreground up could not confirm the startup receipt; inspect owned state before retrying."
  );
  expect(events).not.toContain("save");
});

test("a run mapping owned by another run is an ownership refusal and is not removed", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let ready = false;
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    try {
      return await serve(request);
    } finally {
      ready = true;
    }
  };
  opts.dependencies.invoke = async (request) => {
    const reply = await invoke(request);
    if (request.args[1] === "inspect" && ready) {
      // After serve, the final receipt names a different owner than the one
      // the published mapping recorded at readiness.
      const graph = reply as { receipt: Record<string, unknown> };
      return {
        ...graph,
        receipt: { ...graph.receipt, owner: "9".repeat(32), phase: "removed" },
      };
    }
    return reply;
  };
  expectIntegrityRefusal(
    await startNativeProject(opts).catch((error: unknown) => error),
    "Native run mapping is owned by another run; it was not removed. Inspect owned state before retrying."
  );
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
});

test("a missing or unparseable HTTPS verification response is a verification failure", async () => {
  const plan = {
    services: {
      web: {
        routing: { hostnames: ["web.hack"] },
        healthcheck: { native_http: { path: "/health" } },
      },
    },
  };
  const frontend = (response: { statusCode?: number; location?: string }) => ({
    caPath: "/public",
    httpsPort: 18_443,
    exited: new Promise<{ component: string; code: number }>(() => {}),
    releaseAfterCleanup: async () => {},
    verifyHostname: async () => response as { statusCode: number },
  });
  expectIntegrityRefusal(
    await verifyHttpsRoutes(frontend({}), plan, new Set(["web"])).catch(
      (error: unknown) => error
    ),
    "Native HTTPS verification failed (NO_RESPONSE); peer values omitted."
  );
  expectIntegrityRefusal(
    await verifyHttpsRoutes(
      frontend({ statusCode: 307, location: "https://[" }),
      plan,
      new Set(["web"])
    ).catch((error: unknown) => error),
    "Native HTTPS verification failed (REDIRECT_TARGET_REFUSED); peer values omitted."
  );
});

test("source opt-in and occupied mapping refuse before lifecycle or runtime effects", async () => {
  const { opts, events } = await fixture();
  const refusal = await startNativeProject({
    ...opts,
    sharedSource: false,
  }).catch((error: unknown) => error);
  // A known refusal: stable code, closed message, printed without a stack.
  expect(refusal).toBeInstanceOf(HackCliError);
  expect(refusal).toMatchObject({
    code: "E_PERMISSION",
    message: NATIVE_SHARED_SOURCE_REFUSAL,
  });
  opts.dependencies.load = async () => ({
    run: "a".repeat(32),
    owner: "b".repeat(32),
    namespace: "c".repeat(64),
    planId: "d".repeat(64),
  });
  const retained = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(retained).toBeInstanceOf(ClosedCliError);
  expect(String(retained)).toContain("cannot change the retained run");
  expect(events).toEqual([]);
});
test("caller cancellation is forwarded and lifecycle cleanup remains owned", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  opts.dependencies.serve = async (args) => {
    controller.abort();
    expect(args.signal?.aborted).toBe(true);
    throw new Error("cancelled");
  };
  await expect(
    startNativeProject({ ...opts, signal: controller.signal })
  ).rejects.toThrow();
  expect(events.at(-1)).toBe("cleanup");
  expect(events).not.toContain("save");
});

test("cancellation while runtime up waits on a held lease issues no later runtime request", async () => {
  const { opts, events } = await fixture(false);
  const invoke = opts.dependencies.invoke!;
  const controller = new AbortController();
  const after: string[] = [];
  let up: AbortSignal | undefined;
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      up = call.signal;
      // The runtime is still waiting for a provider lease that another operation holds.
      queueMicrotask(() => controller.abort());
      await new Promise((_, reject) =>
        call.signal?.addEventListener(
          "abort",
          () => reject(new Error("runtime killed while waiting")),
          { once: true }
        )
      );
    }
    if (up) {
      after.push(call.args.slice(0, 2).join(" "));
    }
    return await invoke(call);
  };
  await expect(
    startNativeProject({ ...opts, signal: controller.signal })
  ).rejects.toThrow();
  expect(up?.aborted).toBe(true);
  expect(after).toEqual([]);
  expect(events.at(-1)).toBe("cleanup");
  expect(events).not.toContain("save");
});

function heldRuntimeUp(
  invoke: NonNullable<
    Parameters<typeof startNativeProject>[0]["dependencies"]
  >["invoke"],
  controller: AbortController
) {
  return async (call: Parameters<NonNullable<typeof invoke>>[0]) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      queueMicrotask(() => controller.abort());
      await new Promise((_, reject) =>
        call.signal?.addEventListener(
          "abort",
          () => reject(new Error("runtime killed while waiting")),
          { once: true }
        )
      );
    }
    return await invoke!(call);
  };
}

test("a stop request before any service is a confirmed cancellation once cleanup completes", async () => {
  const { opts, events } = await fixture(false);
  const controller = new AbortController();
  opts.dependencies.invoke = heldRuntimeUp(
    opts.dependencies.invoke,
    controller
  );
  const error = await startNativeProject({
    ...opts,
    signal: controller.signal,
  }).then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(NativeStartupCanceledError);
  expect(error).toMatchObject({ beforeServices: true, interruptedExit: 130 });
  expect(events.at(-1)).toBe("cleanup");
});

test("a stop request whose cleanup fails is not reported as a confirmed cancellation", async () => {
  const { opts } = await fixture(false);
  const controller = new AbortController();
  opts.dependencies.invoke = heldRuntimeUp(
    opts.dependencies.invoke,
    controller
  );
  const error = await startNativeProject({
    ...opts,
    signal: controller.signal,
    before: async () => ({
      cleanup: async () => {
        throw new Error("lifecycle cleanup failed");
      },
      ready: async () => undefined,
    }),
  }).then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeDefined();
  expect(
    error instanceof NativeStartupCanceledError && error.beforeServices
  ).toBe(false);
});

test("cancellation after readiness retains mapping when data is preserved", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  const original = opts.dependencies.serve;
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    controller.abort();
    throw new Error("cancelled after ready");
  };
  expect(await startNativeProject({ ...opts, signal: controller.signal })).toBe(
    130
  );
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("without --wait, up returns at started: mapping, hooks and release first, then all-ready", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  const original = opts.dependencies.serve;
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    // Let the all-ready step (route checks, then its line) finish.
    await Bun.sleep(20);
    controller.abort();
    throw new Error("cancelled after all-ready");
  };
  const progress: string[] = [];
  let reported: unknown;
  expect(
    await startNativeProject({
      ...opts,
      waitForReady: false,
      signal: controller.signal,
      onReady: (services) => {
        events.push("release");
        reported = services;
      },
      onProgress: (event) => {
        events.push(`progress:${event.phase}`);
        progress.push(event.phase);
      },
    })
  ).toBe(130);
  expect(progress).toContain("started");
  expect(progress).not.toContain("ready");
  expect(progress.indexOf("started")).toBeLessThan(
    progress.indexOf("all-ready")
  );
  // The launcher is released at started, after the mapping and up.after.
  expect(events.indexOf("save")).toBeLessThan(events.indexOf("ready"));
  expect(events.indexOf("ready")).toBeLessThan(events.indexOf("release"));
  expect(events.indexOf("release")).toBeLessThan(
    events.indexOf("progress:all-ready")
  );
  expect(reported).toMatchObject({ started: ["web"], readiness: "warming" });
});

test("foreground reports progress, one ready line after publication, and the stop sequence", async () => {
  const { opts, events } = await fixture();
  const controller = new AbortController();
  const original = opts.dependencies.serve;
  opts.dependencies.serve = async (args) => {
    await original?.(args);
    controller.abort();
    throw new Error("cancelled after ready");
  };
  const progress: string[] = [];
  expect(
    await startNativeProject({
      ...opts,
      signal: controller.signal,
      onProgress: (event) => {
        events.push(`progress:${event.phase}`);
        progress.push(
          "services" in event
            ? `${event.phase}:${event.services.join(",")}`
            : event.phase
        );
      },
    })
  ).toBe(130);
  expect(progress).toEqual([
    "input",
    "runtime",
    "images",
    // HACK-2351: image work ends here; a detached launcher counts again.
    "plan",
    "services:web",
    "ready:web",
    "stopping",
    "stopped",
  ]);
  // The ready line follows mapping publication and the lifecycle ready hook.
  expect(events.indexOf("progress:ready")).toBeGreaterThan(
    events.indexOf("save")
  );
  expect(events.indexOf("progress:ready")).toBeGreaterThan(
    events.indexOf("ready")
  );
});
test("a throwing progress observer never changes foreground startup", async () => {
  const { opts } = await fixture();
  expect(
    await startNativeProject({
      ...opts,
      onProgress: () => {
        throw new Error("observer failure");
      },
    })
  ).toBe(0);
});
test("a startup failure before readiness prints no ready or stopped line", async () => {
  const { opts } = await fixture();
  opts.dependencies.serve = async () => {
    throw new Error("startup failed");
  };
  const progress: string[] = [];
  await expect(
    startNativeProject({
      ...opts,
      onProgress: (event) => progress.push(event.phase),
    })
  ).rejects.toThrow();
  expect(progress).not.toContain("ready");
  expect(progress).not.toContain("stopped");
});

test("projects without managed values omit the private environment envelope", async () => {
  const { opts, events } = await fixture(false);
  expect(await startNativeProject(opts)).toBe(0);
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
});

test("managed values are delivered only to reviewed profile-active services", async () => {
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    return {
      ...input,
      normalizedComposeJson: JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            environment: { GREETING: null },
          },
          extra: {
            image: `sha256:${"e".repeat(64)}`,
            profiles: ["extra"],
            environment: { GREETING: null },
          },
        },
      }),
      managedEnvironment: {
        web: { GREETING: "synthetic-secret" },
        extra: { GREETING: "synthetic-inactive" },
      },
      serviceNames: ["web", "extra"],
    };
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) =>
    await review({
      ...request,
      run: (reviewed) =>
        request.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: { web: { active: true }, extra: { active: false } },
            },
          },
        }),
    });
  let delivered: unknown;
  let reported: unknown;
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    delivered = JSON.parse(new TextDecoder().decode(request.privateInput));
    return await serve(request);
  };
  expect(
    await startNativeProject({
      ...opts,
      onReady: (services) => {
        reported = services;
      },
    })
  ).toBe(0);
  expect(reported).toEqual({
    started: ["web"],
    completed: [],
    readiness: "ready",
    warming: [],
  });
  expect(delivered).toMatchObject({
    version: 1,
    services: { web: { GREETING: "synthetic-secret" } },
  });
  expect(JSON.stringify(delivered)).not.toContain("extra");
  expect(JSON.stringify(delivered)).not.toContain("synthetic-inactive");
});

test("AWS profile export follows native login hooks and precedes runtime effects", async () => {
  const { opts, events } = await fixture();
  opts.dependencies.adaptAws = async ({ input, profile }) => {
    expect(profile).toBe("qa-test");
    events.push("aws");
    return {
      input,
      receipt: { profile, expiry: "2099-01-01T00:00:00Z", services: ["web"] },
    };
  };
  expect(
    await startNativeProject({ ...opts, aws: { profile: "qa-test" } })
  ).toBe(0);
  expect(events.indexOf("aws")).toBeGreaterThan(events.indexOf("before"));
  expect(events.indexOf("aws")).toBeLessThan(events.indexOf("runtime up"));
  events.length = 0;
  opts.dependencies.adaptAws = async () => {
    throw new Error("expired profile");
  };
  await expect(
    startNativeProject({ ...opts, aws: { profile: "qa-test" } })
  ).rejects.toThrow("expired profile");
  expect(events).toEqual(["before", "cleanup"]);
});

test("gcloud ADC delivery follows hooks, sends file members privately and persists only the mode", async () => {
  const { opts, events } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: {
          image: `sha256:${"e".repeat(64)}`,
          volumes: [
            "~/.config/gcloud/application_default_credentials.json:/config/adc.json:ro",
          ],
        },
      },
    }),
  });
  const reviewed = { normalizedComposeJson: "" };
  opts.dependencies.adaptGcloud = async ({ input, mode, deliver }) => {
    expect(mode).toBe("file");
    if (deliver === false) {
      // HACK-2324: the pre-hook static review sees the input the adapter will
      // deliver (the host mount removed), and nothing is read for it.
      events.push("gcloud review");
      const stripped = JSON.stringify({ services: { web: { image: "x" } } });
      return {
        input: { ...input, normalizedComposeJson: stripped },
        receipt: { mode, types: [], services: ["web"] },
      };
    }
    events.push("gcloud");
    return {
      input: {
        ...input,
        managedFiles: {
          web: [
            {
              name: "gcloud-adc.json",
              target: "/config/adc.json",
              content: Buffer.from("synthetic-adc-bytes"),
            },
          ],
        },
      },
      receipt: { mode, types: ["authorized_user"], services: ["web"] },
    };
  };
  const serve = opts.dependencies.serve;
  let envelope: Record<string, unknown> | undefined;
  opts.dependencies.serve = async (call) => {
    envelope = JSON.parse(new TextDecoder().decode(call.privateInput));
    expect(call.args.join(" ")).not.toContain("synthetic-adc-bytes");
    return await serve!(call);
  };
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async ({ run }) => {
    saved = run;
  };
  opts.dependencies.remove = async ({ expected }) => {
    expect(saved).toBe(expected);
  };
  opts.dependencies.staticReview = async ({ input }) => {
    events.push("static review");
    reviewed.normalizedComposeJson = input.normalizedComposeJson;
    return undefined;
  };
  // The only bind is the ADC file, which delivery replaces: no project source
  // is captured, so the source-size check never runs.
  opts.dependencies.sourceSize = async () => {
    events.push("source size");
    return undefined as never;
  };
  expect(await startNativeProject({ ...opts, gcloud: { mode: "file" } })).toBe(
    0
  );
  expect(reviewed.normalizedComposeJson).toBe(
    JSON.stringify({ services: { web: { image: "x" } } })
  );
  expect(events.indexOf("gcloud review")).toBeLessThan(
    events.indexOf("static review")
  );
  expect(events.indexOf("static review")).toBeLessThan(
    events.indexOf("before")
  );
  expect(events).not.toContain("source size");
  expect(events.indexOf("gcloud")).toBeGreaterThan(events.indexOf("before"));
  expect(events.indexOf("gcloud")).toBeLessThan(events.indexOf("runtime up"));
  expect(envelope?.version).toBe(2);
  expect(envelope?.files).toEqual({
    web: [
      {
        name: "gcloud-adc.json",
        target: "/config/adc.json",
        mode: "0400",
        content_b64: Buffer.from("synthetic-adc-bytes").toString("base64"),
      },
    ],
  });
  expect(saved?.gcloud).toEqual({ mode: "file" });
  expect(JSON.stringify(saved)).not.toContain("synthetic");
  // A retained graph without a gcloud selection cannot gain one.
  events.length = 0;
  opts.dependencies.load = async () => ({
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  });
  await expect(
    startNativeProject({ ...opts, gcloud: { mode: "file" } })
  ).rejects.toThrow("cannot change the retained run");
  expect(events).toEqual([]);
  // A retained graph with a gcloud selection is not restored when the consent
  // is explicitly withheld for this command; nothing is read or delivered.
  opts.dependencies.load = async () => ({
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
    gcloud: { mode: "file" },
  });
  await expect(
    startNativeProject({ ...opts, gcloudWithheld: true })
  ).rejects.toThrow("cannot change the retained run");
  expect(events).toEqual([]);
});

test("AWS delivery warns value-free before expiry and clears its timers on exit", async () => {
  const { opts } = await fixture();
  const lines: string[] = [];
  opts.dependencies.warn = (line) => lines.push(line);
  opts.dependencies.adaptAws = async ({ input, profile }) => ({
    input,
    receipt: {
      profile,
      // Already inside the warning window, so the notice is immediate.
      expiry: new Date(Date.now() + 5 * 60_000).toISOString(),
      services: ["web", "worker"],
    },
  });
  expect(
    await startNativeProject({ ...opts, aws: { profile: "qa-test" } })
  ).toBe(0);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(
    /^AWS credentials delivered to 2 services expire at \d\d:\d\d; run hack restart to renew\.$/
  );
  expect(lines[0]).not.toContain("qa-test");
  expect(lines[1]).toBe("Forwarding shell variables: (none).");
});

test("reviewed dependency caches bind published source and successful completion readiness", async () => {
  const { opts } = await fixture(false);
  const review = opts.dependencies.review,
    invoke = opts.dependencies.invoke,
    serve = opts.dependencies.serve;
  opts.dependencies.review = async (input) => {
    if (!review) {
      throw new Error("missing fixture review");
    }
    return await review({
      ...input,
      run: async (reviewed) =>
        input.run({
          ...reviewed,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true, dependency_cache: { volume: "modules" } },
              },
            },
          },
        }),
    });
  };
  opts.dependencies.invoke = async (input) =>
    input.args[1] === "publish-source"
      ? {
          revision: "e".repeat(64),
          namespace: "b".repeat(64),
          state: "guest-content-verified-no-job-started",
        }
      : await invoke?.(input);
  let reported: unknown;
  opts.dependencies.serve = async (input) => {
    expect(input.args).toContain("--source-revision");
    expect(input.args).toContain("e".repeat(64));
    expect(input.args).toContain("web=completed");
    if (!serve) {
      throw new Error("missing fixture serve");
    }
    return await serve(input);
  };
  expect(
    await startNativeProject({
      ...opts,
      onReady: (services) => {
        reported = services;
      },
    })
  ).toBe(0);
  expect(reported).toEqual({
    started: [],
    completed: ["web"],
    readiness: "ready",
    warming: [],
  });
});

test("approved outbound hosts are forwarded exactly and sorted before runtime admission", async () => {
  const { opts } = await fixture(false);
  const invoke = opts.dependencies.invoke!;
  let up: readonly string[] = [];
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      up = call.args;
    }
    return await invoke(call);
  };
  expect(
    await startNativeProject({
      ...opts,
      allowedHosts: ["registry.npmjs.org", "example.com"],
    })
  ).toBe(0);
  expect(up).toEqual([
    "runtime",
    "up",
    "--profile",
    "development",
    "--project-share",
    opts.scope.projectRoot,
    "--unfiltered-source",
    "--allow-host",
    "example.com",
    "--allow-host",
    "registry.npmjs.org",
    "--json",
  ]);
});
test("a prepared-base selection is forwarded to runtime up after network intent", async () => {
  const { opts } = await fixture(false);
  const invoke = opts.dependencies.invoke!;
  let up: readonly string[] = [];
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      up = call.args;
    }
    return await invoke(call);
  };
  expect(
    await startNativeProject({
      ...opts,
      preparedBase: { mode: "require", store: "/private/prepared-bases" },
    })
  ).toBe(0);
  expect(up).toEqual([
    "runtime",
    "up",
    "--profile",
    "development",
    "--project-share",
    opts.scope.projectRoot,
    "--unfiltered-source",
    "--internet",
    "--prepared-base",
    "require",
    "--prepared-base-store",
    "/private/prepared-bases",
    "--json",
  ]);
  up = [];
  expect(await startNativeProject(opts)).toBe(0);
  expect(up).not.toContain("--prepared-base");
});
test("invalid outbound selection refuses before lifecycle or preparation effects", async () => {
  const { opts, events } = await fixture();
  opts.dependencies.load = async () => {
    throw new Error("load must not run");
  };
  opts.dependencies.prepare = async () => {
    throw new Error("prepare must not run");
  };
  for (const allowedHosts of [
    [""],
    ["*.example.com"],
    ["127.0.0.1"],
    ["host.local"],
    ["host.localhost"],
    ["EXAMPLE.com"],
    ["example.com."],
    ["example.com", "example.com"],
    Array.from({ length: 33 }, (_, i) => `h${i}.example.com`),
  ]) {
    await expect(startNativeProject({ ...opts, allowedHosts })).rejects.toThrow(
      "HACK_NATIVE_ALLOW_HOSTS"
    );
  }
  expect(events).toEqual([]);
});

test("host listener selections replace stale pre-hook state and bind to the reviewed plan", async () => {
  const { opts } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.extra_hosts = ["search.example.com:host-gateway"];
    compose.services.worker = { ...compose.services.web };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const binding = {
    service: "web",
    binding: "search",
    guest_port: 443,
    host_pid: 123,
    host_port: 8443,
    aliases: ["search.example.com"],
  };
  const before = opts.before;
  opts.before = async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dependencies: [binding, { ...binding, service: "worker" }],
      })
    );
    return await before();
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "up") {
      expect(request.args).toContain("--minimum-dependency-sockets");
      expect(
        request.args[request.args.indexOf("--minimum-dependency-sockets") + 1]
      ).toBe("1");
    }
    if (request.args[1] === "dependency-plan") {
      const selected = JSON.parse(
        await readFile(String(request.args[3]), "utf8")
      );
      expect(selected.plan).toBe("a".repeat(64));
      expect(selected.dependencies).toEqual([
        { ...binding, slot: 0 },
        { ...binding, service: "worker", slot: 0 },
      ]);
    }
    return await invoke(request);
  };
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    expect(request.args).toContain("--auto-dependency-slots");
    return await serve(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow("cannot admit");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        { ...binding, host_pid: 999 },
        { ...binding, service: "worker", host_pid: 999 },
      ],
    })
  );
  expect(await startNativeProject({ ...opts, dependencyFile: path })).toBe(0);
});

test("host listener discovery after hooks binds the current executable-pinned PID", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  const before = opts.before;
  opts.before = async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dependencies: [
          {
            service: "web",
            binding: "search",
            guest_port: 443,
            host_port: 8443,
            host_executable: "/usr/local/bin/synthetic-tunnel",
            aliases: ["search.example.com"],
          },
        ],
      })
    );
    return await before();
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "dependency-discover") {
      expect(events).toContain("before");
      return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
    }
    if (request.args[1] === "dependency-plan") {
      const selection = JSON.parse(
        await readFile(String(request.args[3]), "utf8")
      );
      expect(selection.dependencies[0].host_pid).toBe(456);
      expect(selection.dependencies[0].host_executable).toBe(
        "/usr/local/bin/synthetic-tunnel"
      );
    }
    return await invoke(request);
  };
  expect(await startNativeProject({ ...opts, dependencyFile: path })).toBe(0);
});

test("an owner-scoped selection resolves its owner after hooks and pins it for review", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        {
          service: "web",
          binding: "search",
          guest_port: 443,
          host_port: 8443,
          host_lifecycle: "tunnel",
          aliases: ["search.example.com"],
        },
      ],
    })
  );
  const owners: string[] = [];
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "dependency-discover") {
      expect(events).toContain("before");
      expect(request.args.slice(2)).toEqual([
        "--host-port",
        "8443",
        "--ancestor-pid",
        "4100",
        "--json",
      ]);
      return {
        host_pid: 4321,
        endpoint_fingerprint: "e".repeat(64),
        executable: "/usr/local/bin/synthetic-tunnel",
        supervisor_depth: 2,
        ancestor_pid: 4100,
        ancestor_start_micros: 1_700_000_000_000_001,
      };
    }
    if (request.args[1] === "dependency-plan") {
      const selection = JSON.parse(
        await readFile(String(request.args[3]), "utf8")
      );
      expect(selection.dependencies[0]).toMatchObject({
        host_pid: 4321,
        host_executable: "/usr/local/bin/synthetic-tunnel",
        host_supervisor_depth: 2,
        host_ancestor_pid: 4100,
        host_ancestor_start_micros: 1_700_000_000_000_001,
      });
      expect(selection.dependencies[0].host_lifecycle).toBeUndefined();
    }
    return await invoke(request);
  };
  expect(
    await startNativeProject({
      ...opts,
      dependencyFile: path,
      dependencyOwners: async (owner) => {
        owners.push(`${owner.kind}:${owner.name}`);
        expect(events).toContain("before");
        return {
          pid: 4100,
          confirm: async () => {
            owners.push("confirm");
          },
        };
      },
    })
  ).toBe(0);
  expect(owners).toEqual(["lifecycle:tunnel", "confirm"]);
});

test("a delayed hook listener gates runtime effects and cancellation cleans hooks", async () => {
  for (const cancel of [false, true]) {
    const { opts, events } = await fixture(false);
    const path = join(opts.scope.projectRoot, "host-selection.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        dependencies: [
          {
            service: "web",
            binding: "search",
            guest_port: 443,
            host_port: 8443,
            host_executable: "/usr/local/bin/synthetic-tunnel",
            aliases: ["search.example.com"],
          },
        ],
      })
    );
    const controller = new AbortController();
    const invoke = opts.dependencies.invoke!;
    let discoveries = 0;
    let verified = false;
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "dependency-discover") {
        expect(events).toContain("before");
        discoveries++;
        if (discoveries === 1) {
          if (cancel) {
            queueMicrotask(() => controller.abort());
          }
          throw new NativeRuntimeRequestError({
            message: "listener is not ready yet",
            nativeCode: "host_endpoint_identity",
          });
        }
        verified = true;
        return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
      }
      if (request.args[1] === "up") {
        expect(verified).toBe(true);
      }
      return await invoke(request);
    };
    const startup = startNativeProject({
      ...opts,
      dependencyFile: path,
      signal: controller.signal,
    });
    if (cancel) {
      await expect(startup).rejects.toThrow("values omitted");
      expect(events).toEqual(["before", "cleanup"]);
      expect(discoveries).toBe(1);
    } else {
      expect(await startup).toBe(0);
      expect(discoveries).toBe(2);
      expect(events).toContain("runtime up");
      expect(events.at(-1)).toBe("cleanup");
    }
  }
});

test("invalid listener selection cleans lifecycle hooks before runtime effects", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [{ password: "synthetic-private" }],
    })
  );
  await expect(
    startNativeProject({ ...opts, dependencyFile: path })
  ).rejects.toThrow("values omitted");
  expect(events).toEqual(["before", "cleanup"]);
});

test("cancellation after successful listener discovery still prevents runtime admission", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "host-selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        {
          service: "web",
          binding: "search",
          guest_port: 443,
          host_port: 8443,
          host_executable: "/usr/local/bin/synthetic-tunnel",
          aliases: ["search.example.com"],
        },
      ],
    })
  );
  const controller = new AbortController();
  const invoke = opts.dependencies.invoke!;
  let runtimeAdmissions = 0;
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] !== "graph" || call.args[1] !== "dependency-discover") {
      if (call.args[0] === "runtime" && call.args[1] === "up") {
        runtimeAdmissions++;
      }
      return await invoke(call);
    }
    queueMicrotask(() =>
      queueMicrotask(() => queueMicrotask(() => controller.abort()))
    );
    return { host_pid: 456, endpoint_fingerprint: "e".repeat(64) };
  };
  await expect(
    startNativeProject({
      ...opts,
      dependencyFile: path,
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(runtimeAdmissions).toBe(0);
  expect(events).toEqual(["before", "cleanup"]);
});

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("a foreground started return whose owner fails later prints the log tails and fails", async () => {
  const { opts } = await fixture();
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    // The owner later reports a service failure and exits nonzero.
    request.onStartupLogs?.([
      { service: "web", stdout: "", stderr: "crashed", truncated: false },
    ]);
    request.onExitDiagnostic?.({
      exitCode: 1,
      nativeCode: "graph_service_failed",
    });
    return 1;
  };
  const failure = await startNativeProject({
    ...opts,
    waitForReady: false,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain("(graph_service_failed)");
  expect(message).toContain("--- web stderr ---");
  expect(message).toContain("crashed");
});

test("failed services' output is printed with managed values redacted and never saved", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let selectedRun = "";
  const saved: unknown[] = [];
  opts.dependencies.save = async (request) => {
    saved.push(request);
  };
  opts.dependencies.serve = async (request) => {
    selectedRun = request.run;
    request.onStartupLogs?.([
      {
        service: "web",
        stdout: "listening",
        stderr: "boot failed: rejected TOKEN=synthetic-secret",
        truncated: false,
      },
    ]);
    throw new ClosedCliError(
      "Native graph startup was interrupted or failed (graph_startup_application_failed); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "inspect"
      ? stoppedGraph({
          run: selectedRun,
          owner: "c".repeat(32),
          namespace: "b".repeat(64),
          planId: "a".repeat(64),
          effectiveEnvName: null,
          profiles: [],
          aws: null,
        })
      : invoke(request);
  let message = "";
  try {
    await startNativeProject(opts);
  } catch (error) {
    expect(error).toBeInstanceOf(ClosedCliError);
    message = (error as Error).message;
  }
  expect(message).toBe(
    [
      "Native graph startup was interrupted or failed (graph_startup_application_failed); inspect owned state before retrying.",
      "Last output of failed services (at most 64 lines each; managed values redacted; not saved):",
      "--- web stdout ---",
      "listening",
      "--- web stderr ---",
      "boot failed: rejected TOKEN=[REDACTED]",
    ].join("\n")
  );
  expect(events.at(-1)).toBe("cleanup");
  expect(JSON.stringify(saved)).not.toContain("boot failed");
  for (const file of await filesUnder(opts.scope.projectRoot)) {
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("boot failed");
    expect(text).not.toContain("synthetic-secret");
  }
});

// Built at runtime so the synthetic PEM framing is not a key-shaped literal.
const PEM_BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE", "KEY-----"].join(" ");
test("a failed gcloud start redacts echoed ADC credentials and saves none of them", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  // Synthetic dummy credential material only.
  const refreshToken = "1//synthetic-adc-refresh-token";
  const keyLine = "U1lOVEhFVElDLURVTU1ZLVBSSVZBVEUtS0VZ";
  const adc = {
    type: "authorized_user",
    client_secret: "synthetic-adc-client-secret",
    refresh_token: refreshToken,
    private_key: `${PEM_BEGIN}\n${keyLine}\n${PEM_END}\n`,
  };
  opts.dependencies.adaptGcloud = async ({ input, mode }) => ({
    input: {
      ...input,
      managedFiles: {
        web: [
          {
            name: "gcloud-adc.json",
            target: "/config/adc.json",
            content: Buffer.from(JSON.stringify(adc)),
          },
        ],
      },
    },
    receipt: { mode, types: ["authorized_user"], services: ["web"] },
  });
  let selectedRun = "";
  const saved: unknown[] = [];
  opts.dependencies.save = async (request) => {
    saved.push(request);
  };
  opts.dependencies.serve = async (request) => {
    selectedRun = request.run;
    request.onStartupLogs?.([
      {
        service: "web",
        stdout: `token ${refreshToken}`,
        stderr: `${keyLine}\nsecret=${adc.client_secret}`,
        truncated: false,
      },
    ]);
    throw new ClosedCliError(
      "Native graph startup was interrupted or failed (graph_startup_application_failed); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "inspect"
      ? stoppedGraph({
          run: selectedRun,
          owner: "c".repeat(32),
          namespace: "b".repeat(64),
          planId: "a".repeat(64),
          effectiveEnvName: null,
          profiles: [],
          aws: null,
        })
      : invoke(request);
  const failure = await startNativeProject({
    ...opts,
    gcloud: { mode: "file" },
  }).catch((error: unknown) => error);
  const message = (failure as Error).message;
  expect(message).toContain("token [REDACTED]");
  expect(message).toContain("secret=[REDACTED]");
  for (const secret of [refreshToken, keyLine, adc.client_secret]) {
    expect(message).not.toContain(secret);
    expect(JSON.stringify(saved)).not.toContain(secret);
  }
  expect(events.at(-1)).toBe("cleanup");
  for (const file of await filesUnder(opts.scope.projectRoot)) {
    const text = await readFile(file, "utf8");
    for (const secret of [refreshToken, keyLine, adc.client_secret]) {
      expect(text).not.toContain(secret);
    }
  }
});

test("retained startup failure preserves its diagnostic and never removes the run mapping", async () => {
  const { opts, events } = await fixture(false);
  const serve = opts.dependencies.serve!;
  const invoke = opts.dependencies.invoke!;
  let failed = false;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    failed = true;
    throw new Error(
      "Native graph startup failed (graph_network_intent); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    const result = await invoke(request);
    if (failed && request.args[1] === "inspect") {
      return {
        ...(result as Record<string, unknown>),
        receipt: {
          ...(result as { receipt: Record<string, unknown> }).receipt,
          phase: "failed-retained",
        },
      };
    }
    return result;
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "graph_network_intent"
  );
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("routed startup reserves bridges and enrolls reviewed healthy services without dropping labels", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const invoke = opts.dependencies.invoke!;
  const serve = opts.dependencies.serve!;
  const labels = {
    caddy: "web.example.com",
    "caddy.reverse_proxy": "{{upstreams 3000}}",
    "caddy.tls": "internal",
  };
  const probe = {
    port: 3000,
    path: "/health",
    interval_ms: 100,
    timeout_ms: 500,
    retries: 3,
    start_period_ms: 0,
  };
  opts.dependencies.prepare = async (call) => {
    const input = await prepare(call);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.labels = labels;
    compose.services.web.healthcheck = { "x-hack-http": probe };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  opts.dependencies.review = async (call) => {
    expect(
      JSON.parse(call.input.normalizedComposeJson).services.web.labels
    ).toEqual(labels);
    return await review({
      ...call,
      run: async (checked) =>
        call.run({
          ...checked,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: {
                  active: true,
                  routing: { port: 3000, hostnames: ["web.example.com"] },
                  healthcheck: { native_http: probe, disabled: false },
                },
              },
            },
          },
        }),
    });
  };
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      expect(call.args).toContain("--minimum-bridge-sockets");
      expect(call.args[call.args.indexOf("--minimum-bridge-sockets") + 1]).toBe(
        "1"
      );
      expect(call.args).not.toContain("--bridge-sockets");
    }
    return await invoke(call);
  };
  opts.dependencies.serve = async (call) => {
    expect(call.args).toContain("web=auto");
    expect(call.args).toContain("web=healthy");
    return await serve(call);
  };
  expect(await startNativeProject(opts)).toBe(0);
});

const profileProbe = {
  port: 3000,
  path: "/health",
  interval_ms: 100,
  timeout_ms: 500,
  retries: 3,
  start_period_ms: 0,
};
/** One active service plus a routed and an unrouted service in the `debug` profile. */
function profileSpecs(): Record<string, Record<string, unknown>> {
  return {
    web: { image: `sha256:${"e".repeat(64)}` },
    admin: {
      image: `sha256:${"e".repeat(64)}`,
      profiles: ["debug"],
      labels: {
        caddy: "admin.example.com",
        "caddy.reverse_proxy": "{{upstreams 3000}}",
        "caddy.tls": "internal",
      },
      healthcheck: { "x-hack-http": profileProbe },
    },
    worker: {
      image: `sha256:${"e".repeat(64)}`,
      profiles: ["debug"],
      depends_on: { web: { condition: "service_healthy" } },
    },
  };
}
function profilePlan(debug: boolean) {
  return {
    enrollment_compatible: true,
    services: {
      web: { active: true },
      admin: {
        active: debug,
        routing: { port: 3000, hostnames: ["admin.example.com"] },
        healthcheck: { native_http: profileProbe, disabled: false },
      },
      worker: { active: debug },
    },
  };
}
function readyGoals(args: readonly string[]): string[] {
  return args.flatMap((arg, index) =>
    args[index - 1] === "--ready" ? [arg] : []
  );
}

test("readiness goals cover only services the reviewed plan marks active", () => {
  expect(
    nativeReadinessArgs({
      specs: profileSpecs(),
      plan: profilePlan(false),
      initializers: new Set(),
      routed: new Set(),
    })
  ).toEqual(["--ready", "web=started"]);
  expect(
    readyGoals(
      nativeReadinessArgs({
        specs: profileSpecs(),
        plan: profilePlan(true),
        initializers: new Set(),
        routed: new Set(["admin"]),
      })
    ).sort()
  ).toEqual(["admin=healthy", "web=healthy", "worker=started"]);
  // Services absent from the plan are unknown, and a missing plan admits nothing.
  expect(
    nativeReadinessArgs({
      specs: profileSpecs(),
      plan: {
        enrollment_compatible: true,
        services: { web: { active: true } },
      },
      initializers: new Set(["worker"]),
      routed: new Set(["admin"]),
    })
  ).toEqual(["--ready", "web=started"]);
  expect(
    nativeReadinessArgs({
      specs: profileSpecs(),
      plan: undefined,
      initializers: new Set(),
      routed: new Set(),
    })
  ).toEqual([]);
});

test("a reviewed one-shot service waits for successful completion", () => {
  const image = `sha256:${"e".repeat(64)}`;
  const specs = {
    init: { image, healthcheck: { test: ["CMD", "true"] } },
    seed: { image, profiles: ["debug"] },
    web: { image },
  };
  const plan = (oneShot: unknown) => ({
    enrollment_compatible: true,
    services: {
      init: { active: true, one_shot: oneShot },
      // An inactive one-shot gets no goal: the runtime refuses inactive goals.
      seed: { active: false, one_shot: true },
      web: { active: true },
    },
  });
  // The review's typed `one_shot`, not the label text, selects completion;
  // it overrides the healthcheck default a long-running service would get.
  expect(
    readyGoals(
      nativeReadinessArgs({
        specs,
        plan: plan(true),
        initializers: new Set(),
        routed: new Set(),
      })
    ).sort()
  ).toEqual(["init=completed", "web=started"]);
  for (const value of [false, "true", undefined]) {
    expect(
      readyGoals(
        nativeReadinessArgs({
          specs,
          plan: plan(value),
          initializers: new Set(),
          routed: new Set(),
        })
      ).sort()
    ).toEqual(["init=healthy", "web=started"]);
  }
});

test("an optional dependency on an inactive service adds no readiness goal", () => {
  const image = `sha256:${"e".repeat(64)}`;
  const specs = {
    app: {
      image,
      depends_on: { db: { condition: "service_healthy", required: false } },
    },
    db: {
      image,
      profiles: ["database"],
      healthcheck: { test: ["CMD", "true"] },
    },
  };
  const plan = (database: boolean) => ({
    enrollment_compatible: true,
    services: { app: { active: true }, db: { active: database } },
  });
  expect(
    nativeReadinessArgs({
      specs,
      plan: plan(false),
      initializers: new Set(),
      routed: new Set(),
    })
  ).toEqual(["--ready", "app=started"]);
  // An active optional target is waited for like a required one.
  expect(
    readyGoals(
      nativeReadinessArgs({
        specs,
        plan: plan(true),
        initializers: new Set(),
        routed: new Set(),
      })
    ).sort()
  ).toEqual(["app=started", "db=healthy"]);
});

async function profileStartup(profiles: readonly string[] | undefined) {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const invoke = opts.dependencies.invoke!;
  const serve = opts.dependencies.serve!;
  const seen: { reviewed?: readonly string[]; serve?: readonly string[] } = {};
  let bridges: string | undefined;
  opts.dependencies.prepare = async (call) => ({
    ...(await prepare(call)),
    normalizedComposeJson: JSON.stringify({ services: profileSpecs() }),
    serviceNames: ["web", "admin", "worker"],
  });
  opts.dependencies.review = async (call) => {
    seen.reviewed = call.profiles;
    return await review({
      ...call,
      run: async (checked) =>
        call.run({
          ...checked,
          report: {
            plan: profilePlan(call.profiles?.includes("debug") === true),
          },
        }),
    });
  };
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      const index = call.args.indexOf("--minimum-bridge-sockets");
      bridges = index < 0 ? undefined : call.args[index + 1];
    }
    return await invoke(call);
  };
  opts.dependencies.serve = async (call) => {
    seen.serve = call.args;
    return await serve(call);
  };
  expect(
    await startNativeProject(profiles ? { ...opts, profiles } : opts)
  ).toBe(0);
  return {
    reviewed: seen.reviewed,
    goals: readyGoals(seen.serve ?? []).sort(),
    serveArgs: seen.serve ?? [],
    bridges,
  };
}

test.each([
  { labels: { "hack.service.one-shot": "true" } },
  { labels: ["hack.service.one-shot=true"] },
])("native up admits a labeled one-shot and waits for its completion %j", async ({
  labels,
}) => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const serve = opts.dependencies.serve!;
  const image = `sha256:${"e".repeat(64)}`;
  let serveArgs: readonly string[] = [];
  opts.dependencies.prepare = async (call) => ({
    ...(await prepare(call)),
    normalizedComposeJson: JSON.stringify({
      services: {
        init: { image, command: ["true"], labels },
        web: { image },
      },
    }),
    serviceNames: ["init", "web"],
  });
  opts.dependencies.review = async (call) =>
    await review({
      ...call,
      run: async (checked) =>
        call.run({
          ...checked,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                init: { active: true, one_shot: true },
                web: { active: true },
              },
            },
          },
        }),
    });
  opts.dependencies.serve = async (call) => {
    serveArgs = call.args;
    return await serve(call);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(readyGoals(serveArgs).sort()).toEqual([
    "init=completed",
    "web=started",
  ]);
});

test("native up omits routed and unrouted inactive-profile services from readiness", async () => {
  const started = await profileStartup(undefined);
  expect(started.reviewed).not.toContain("debug");
  // An inactive worker's healthy edge must not raise the active web goal.
  expect(started.goals).toEqual(["web=started"]);
  expect(started.serveArgs).not.toContain("admin=auto");
  // Pool capacity still counts the inactive routed service on purpose.
  expect(started.bridges).toBe("1");
});

test("an explicit profile activates its services' readiness and routes", async () => {
  const started = await profileStartup(["debug"]);
  expect(started.reviewed).toContain("debug");
  expect(started.goals).toEqual([
    "admin=healthy",
    "web=healthy",
    "worker=started",
  ]);
  expect(started.serveArgs).toContain("admin=auto");
  expect(started.bridges).toBe("1");
});

function leaseIdentity(
  selection: Parameters<typeof acquireNativeHttpsLease>[0]
) {
  return {
    version: 1 as const,
    ownerGeneration: "1".repeat(32),
    leaseId: "2".repeat(32),
    owner: selection.pool.owner,
    ...selection.lease,
  };
}
const httpsSelection = {
  caddyBinary: "/synthetic/caddy",
  caddySha256: "a".repeat(64),
  httpsPort: 8443,
};
async function httpsFixture() {
  const result = await fixture(false);
  configureHttpsFixture(result.opts);
  return result;
}
function configureHttpsFixture(
  opts: Awaited<ReturnType<typeof fixture>>["opts"]
) {
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const probe = {
    port: 3000,
    path: "/health",
    interval_ms: 100,
    timeout_ms: 500,
    retries: 3,
    start_period_ms: 0,
  };
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    return {
      ...input,
      normalizedComposeJson: JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            labels: {
              caddy: "web.example.com",
              "caddy.reverse_proxy": "{{upstreams 3000}}",
              "caddy.tls": "internal",
            },
            healthcheck: { "x-hack-http": probe },
          },
        },
      }),
    };
  };
  opts.dependencies.review = async (request) =>
    review({
      ...request,
      run: async (checked) =>
        request.run({
          ...checked,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: {
                  active: true,
                  routing: { port: 3000, hostnames: ["web.example.com"] },
                  healthcheck: { native_http: probe, disabled: false },
                },
              },
            },
          },
        }),
    });
}
test("HTTPS selection requires all explicit canonical fields before effects", async () => {
  expect(parseNativeHttpsSelection({})).toBeUndefined();
  expect(
    parseNativeHttpsSelection({
      HACK_NATIVE_CADDY_BINARY: httpsSelection.caddyBinary,
      HACK_NATIVE_CADDY_SHA256: httpsSelection.caddySha256,
      HACK_NATIVE_HTTPS_PORT: "8443",
    })
  ).toEqual(httpsSelection);
  for (const env of [
    { HACK_NATIVE_CADDY_BINARY: "/caddy" },
    {
      HACK_NATIVE_CADDY_BINARY: "/caddy",
      HACK_NATIVE_CADDY_SHA256: "a".repeat(64),
      HACK_NATIVE_HTTPS_PORT: "08443",
    },
  ]) {
    expect(() => parseNativeHttpsSelection(env)).toThrow();
  }
  const { opts, events } = await fixture(false);
  await expect(
    startNativeProject({ ...opts, https: { ...httpsSelection, httpsPort: 0 } })
  ).rejects.toThrow();
  expect(events).toEqual([]);
});
test("unrouted graphs do not start the selected HTTPS frontend", async () => {
  const { opts } = await fixture(false);
  opts.dependencies.https = async () => {
    throw new Error("unexpected frontend");
  };
  expect(await startNativeProject({ ...opts, https: httpsSelection })).toBe(0);
});
test("routed HTTPS verification precedes readiness and closes after graph cleanup", async () => {
  const { opts, events } = await httpsFixture();
  opts.dependencies.https = async (selection) => {
    expect(selection).toMatchObject({
      runtime: opts.runtime,
      ...httpsSelection,
      pool: {
        owner: "c".repeat(32),
        bootId: "12345678-1234-1234-1234-123456789abc",
      },
      lease: { namespace: "b".repeat(64), planId: "a".repeat(64) },
    });
    expect(selection.lease.run).toMatch(/^[a-f0-9]{32}$/);
    expect(selection.lease.attempt).toMatch(/^[a-f0-9]{32}$/);
    events.push("https-start");
    return {
      identity: leaseIdentity(selection),
      caPath: "/synthetic/root.crt",
      httpsPort: 8443,
      exited: new Promise(() => {}),
      verifyHostname: async (hostname, path) => {
        expect(path).toBe("/health");
        expect(hostname).toBe("web.example.com");
        events.push("https-verify");
        return { statusCode: 200 };
      },
      releaseAfterCleanup: async () => {
        events.push("https-close");
      },
    };
  };
  expect(await startNativeProject({ ...opts, https: httpsSelection })).toBe(0);
  expect(events.indexOf("graph status")).toBeLessThan(
    events.indexOf("https-start")
  );
  expect(events.indexOf("https-start")).toBeLessThan(
    events.indexOf("https-verify")
  );
  // The run mapping is saved at started, before the HTTPS lease (PR B).
  expect(events.indexOf("save")).toBeLessThan(events.indexOf("https-start"));
  expect(events).not.toContain("remove");
  expect(events.indexOf("save")).toBeLessThan(events.indexOf("https-close"));
  expect(events.indexOf("https-close")).toBeLessThan(events.indexOf("cleanup"));
});
test.each([
  { waitForReady: true },
  { waitForReady: false },
])("the started chain runs while the owner holds the provider lease (--wait $waitForReady)", async ({
  waitForReady,
}) => {
  // The owner holds the provider lease from its started line to its ready
  // line; the fixture refuses every leased command meanwhile, and so does the
  // HTTPS owner (its acquire check is a leased inspection of a ready graph).
  const { opts, events, state } = await httpsFixture();
  opts.dependencies.https = async (selection) => {
    if (state.leaseHeld) {
      state.refused.push("https acquire");
      throw new Error("provider lease held by the start");
    }
    events.push("https-start");
    return {
      identity: leaseIdentity(selection),
      caPath: "/synthetic/root.crt",
      httpsPort: 8443,
      exited: new Promise(() => {}),
      verifyHostname: async () => {
        events.push("https-verify");
        return { statusCode: 200 };
      },
      releaseAfterCleanup: async () => {
        events.push("https-close");
      },
    };
  };
  const controller = new AbortController();
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    // A started return finishes its ready step after the owner's ready line.
    await Bun.sleep(20);
    controller.abort();
    throw new Error("cancelled after ready");
  };
  const progress: string[] = [];
  await startNativeProject({
    ...opts,
    https: httpsSelection,
    waitForReady,
    signal: controller.signal,
    onReady: () => {
      events.push("release");
    },
    onProgress: (event) => {
      progress.push(event.phase);
    },
  });
  expect(state.refused).toEqual([]);
  expect(events).toContain("save");
  expect(events).toContain("https-verify");
  expect(progress).not.toContain("routes-not-answering");
  if (waitForReady) {
    expect(events.indexOf("https-start")).toBeLessThan(
      events.indexOf("release")
    );
  } else {
    // Released at started; HTTPS is taken once the owner is ready.
    expect(events.indexOf("release")).toBeLessThan(
      events.indexOf("https-start")
    );
    expect(progress).toContain("all-ready");
  }
});
test("shared HTTPS lease is never acquired before graph readiness or without a live pool", async () => {
  const beforeReady = await httpsFixture();
  beforeReady.opts.dependencies.https = async () => {
    throw new Error("unexpected lease acquisition");
  };
  beforeReady.opts.dependencies.serve = async () => {
    beforeReady.events.push("serve-failed-before-ready");
    throw new Error("graph never admitted");
  };
  await expect(
    startNativeProject({ ...beforeReady.opts, https: httpsSelection })
  ).rejects.toThrow();
  expect(beforeReady.events).not.toContain("runtime status");
  expect(beforeReady.events).not.toContain("save");
  for (const status of [
    {
      phase: "running",
      process_alive: false,
      guest_boot_id: "12345678-1234-1234-1234-123456789abc",
    },
    {
      phase: "stopped",
      process_alive: true,
      guest_boot_id: "12345678-1234-1234-1234-123456789abc",
    },
    { phase: "running", process_alive: true, guest_boot_id: "invalid" },
  ]) {
    const { opts, events } = await httpsFixture();
    const invoke = opts.dependencies.invoke!;
    let acquired = false;
    opts.dependencies.invoke = async (request) =>
      request.args[0] === "runtime" && request.args[1] === "status"
        ? status
        : invoke(request);
    opts.dependencies.https = async () => {
      acquired = true;
      throw new Error("unexpected lease acquisition");
    };
    await expect(
      startNativeProject({ ...opts, https: httpsSelection })
    ).rejects.toThrow("verified running pool");
    expect(acquired).toBe(false);
    // Saved at started, before the lease check refuses (PR B).
    expect(events.filter((event) => event === "save")).toHaveLength(1);
    expect(events.at(-1)).toBe("cleanup");
  }
});

test("cancellation after lease acquisition releases only the acquired lease and never publishes readiness", async () => {
  const { opts, events } = await httpsFixture();
  const controller = new AbortController();
  let released = 0;
  let verified = false;
  opts.dependencies.https = async (selection) => {
    controller.abort();
    return {
      identity: leaseIdentity(selection),
      caPath: "/synthetic/root.crt",
      httpsPort: 8443,
      exited: new Promise(() => {}),
      verifyHostname: async () => {
        verified = true;
        return { statusCode: 200 };
      },
      releaseAfterCleanup: async () => {
        released++;
      },
    };
  };
  expect(
    await startNativeProject({
      ...opts,
      https: httpsSelection,
      signal: controller.signal,
    })
  ).toBe(130);
  expect(released).toBe(1);
  expect(verified).toBe(false);
  // Saved at started, before the lease (PR B); a later failure keeps it.
  expect(events.filter((event) => event === "save")).toHaveLength(1);
  expect(events).not.toContain("ready");
  expect(events.at(-1)).toBe("cleanup");
});

test("unexpected HTTPS owner exit aborts the graph and fails instead of returning interrupt status", async () => {
  const { opts, events } = await httpsFixture();
  let exit!: (value: { component: string; code: number }) => void;
  const exited = new Promise<{ component: string; code: number }>((resolve) => {
    exit = resolve;
  });
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited,
    verifyHostname: async () => ({ statusCode: 200 }),
    releaseAfterCleanup: async () => {
      events.push("https-close");
    },
  });
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    await serve(request);
    exit({ component: "caddy", code: 1 });
    await Promise.resolve();
    expect(request.signal?.aborted).toBe(true);
    return 0;
  };
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toThrow("HTTPS owner exited unexpectedly");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("HTTPS readiness failure preserves its cause without removing an unpublished mapping", async () => {
  const { opts, events } = await httpsFixture();
  const failure = new Error("synthetic HTTPS verification failure");
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => {
      throw failure;
    },
    releaseAfterCleanup: async () => {
      events.push("https-close");
    },
  });
  opts.dependencies.remove = async () => {
    events.push("remove");
    throw new Error("mapping was never saved");
  };
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toBe(failure);
  // Saved at started, before the lease (PR B); a later failure keeps it.
  expect(events.filter((event) => event === "save")).toHaveLength(1);
  expect(events).not.toContain("remove");
  expect(events).not.toContain("ready");
  expect(events.slice(-2)).toEqual(["https-close", "cleanup"]);
});

test("mapping save failure preserves its cause without removing an unconfirmed mapping", async () => {
  const { opts, events } = await fixture();
  const failure = new Error("synthetic mapping publication failure");
  opts.dependencies.save = async () => {
    events.push("save-attempt");
    throw failure;
  };
  opts.dependencies.remove = async () => {
    events.push("remove");
    throw new Error("mapping was never saved");
  };
  await expect(startNativeProject(opts)).rejects.toBe(failure);
  expect(events).toContain("save-attempt");
  expect(events).not.toContain("remove");
  expect(events).not.toContain("ready");
  expect(events.at(-1)).toBe("cleanup");
});

test("failed cleanup reports sanitized TLS failure and retained state without removing mapping", async () => {
  const { opts, events } = await httpsFixture();
  const failure = new Error(
    "Native HTTPS verification failed (VERIFICATION_TIMEOUT_RESPONSE); peer values omitted."
  );
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => {
      throw failure;
    },
    releaseAfterCleanup: async () => {},
  });
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    try {
      return await serve(request);
    } finally {
      request.onExitDiagnostic?.({
        exitCode: 2,
        nativeCode: "graph_owner_recovery",
      });
    }
  };
  const invoke = opts.dependencies.invoke!;
  let inspections = 0;
  opts.dependencies.invoke = async (request) => {
    const value = await invoke(request);
    // The first leased inspection is the final one; the mapping read is lease-free.
    if (request.args[1] === "inspect" && ++inspections === 1) {
      return {
        ...(value as object),
        observations: { "container:web": { state: "running" } },
      };
    }
    return value;
  };
  let caught: unknown;
  try {
    await startNativeProject({ ...opts, https: httpsSelection });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("cleanup is unconfirmed");
  expect((caught as Error).message).toContain(
    "runtime and bridge state may be retained"
  );
  expect((caught as Error).message).toContain("VERIFICATION_TIMEOUT_RESPONSE");
  expect((caught as Error).message).toContain(
    "Native exit diagnostic: graph_owner_recovery"
  );
  expect((caught as Error).cause).toBeUndefined();
  expect(events).not.toContain("remove");
});

test("HACK-2351: the configured graph start budget reaches the runtime, and its timeout names the services that were not ready", async () => {
  const { opts } = await fixture();
  let timeoutArgument: string | undefined;
  let startupTimeoutMs: number | undefined;
  let served: string | undefined;
  let statusReads = 0;
  opts.dependencies.startupStatusIntervalMs = 5;
  opts.dependencies.serve = async (request) => {
    served = request.run;
    const index = request.args.indexOf("--timeout-seconds");
    timeoutArgument = request.args[index + 1];
    startupTimeoutMs = request.startupTimeoutMs;
    // The start waits; its status reads run meanwhile.
    await Bun.sleep(100);
    request.onExitDiagnostic?.({ exitCode: 1, nativeCode: "graph_timeout" });
    throw new NativeRuntimeRequestError({
      message:
        "Native graph startup was interrupted or failed (graph_timeout); inspect owned state before retrying.",
      nativeCode: "graph_timeout",
      nativeMessage:
        "Graph readiness deadline exceeded; owned state is retained.",
    });
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[0] === "graph" && request.args[1] === "status") {
      statusReads += 1;
      // While the start waits web never starts; the later reads see the
      // runtime's cleanup, which must not replace that view (review finding).
      return statusReads <= 3
        ? {
            receipt: { phase: "preparing" },
            observations: { "container:web": { state: "created" } },
          }
        : {
            receipt: { phase: "cleanup-intent" },
            observations: { "container:web": { state: "absent" } },
          };
    }
    const value = await invoke(request);
    if (request.args[1] === "inspect" && served && isRecord(value)) {
      // After the runtime's own cleanup the container is gone: this view
      // must not be the one the error describes (review finding).
      return {
        ...value,
        receipt: {
          ...(value.receipt as object),
          run: served,
          phase: "stopped-data-retained",
        },
        observations: { "container:web": { state: "absent" } },
      };
    }
    return value;
  };
  let caught: unknown;
  try {
    await startNativeProject({ ...opts, startTimeoutSeconds: 600 });
  } catch (error) {
    caught = error;
  }
  expect(timeoutArgument).toBe("600");
  // The frontend outlasts the runtime's own deadline, so the runtime reports it.
  expect(startupTimeoutMs).toBe(615_000);
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).toContain("graph_timeout");
  expect(message).toContain("of the 600 s graph start budget");
  // From the status read before the deadline, not the post-cleanup inspection.
  expect(message).toContain("web (wanted started; created)");
  expect(message).not.toContain("absent");
  expect(statusReads).toBeGreaterThan(3);
  expect(message).toContain("native.startTimeoutSeconds");
});

test("HACK-2351: without a startup-phase graph status, a graph timeout keeps the runtime's own message", async () => {
  const { opts } = await fixture();
  opts.dependencies.startupStatusIntervalMs = 5;
  let served: string | undefined;
  opts.dependencies.serve = async (request) => {
    served = request.run;
    await Bun.sleep(50);
    request.onExitDiagnostic?.({ exitCode: 1, nativeCode: "graph_timeout" });
    throw new NativeRuntimeRequestError({
      message:
        "Native graph startup was interrupted or failed (graph_timeout); inspect owned state before retrying.",
      nativeCode: "graph_timeout",
      nativeMessage:
        "Graph readiness deadline exceeded; owned state is retained.",
    });
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[0] === "graph" && request.args[1] === "status") {
      // Only cleanup views: nothing describes the graph at its deadline.
      return {
        receipt: { phase: "removed" },
        observations: { "container:web": { state: "absent" } },
      };
    }
    const value = await invoke(request);
    return request.args[1] === "inspect" && served && isRecord(value)
      ? {
          ...value,
          receipt: {
            ...(value.receipt as object),
            run: served,
            phase: "stopped-data-retained",
          },
        }
      : value;
  };
  let caught: unknown;
  try {
    await startNativeProject(opts);
  } catch (error) {
    caught = error;
  }
  expect((caught as Error).message).toContain("graph_timeout");
  expect((caught as Error).message).not.toContain("Not ready after");
});

test("HACK-2351: a ready start stops reading its startup status", async () => {
  const { opts } = await fixture();
  opts.dependencies.startupStatusIntervalMs = 5;
  let statusReads = 0;
  let readsAtReady = 0;
  // The started and ready steps' mapping read is not a startup status read.
  let inReady = false;
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (
      request.args[0] === "graph" &&
      request.args[1] === "status" &&
      !inReady
    ) {
      statusReads += 1;
      return { receipt: { phase: "preparing" }, observations: {} };
    }
    return await invoke(request);
  };
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) =>
    await serve({
      ...request,
      onStarted: async () => {
        inReady = true;
        await request.onStarted?.();
        inReady = false;
      },
      onReady: async (...args) => {
        await Bun.sleep(40);
        inReady = true;
        await request.onReady(...args);
        inReady = false;
        readsAtReady = statusReads;
        // The ready graph keeps running; no startup reads continue.
        await Bun.sleep(60);
      },
    });
  await startNativeProject(opts).catch(() => undefined);
  expect(readsAtReady).toBeGreaterThan(0);
  expect(statusReads).toBe(readsAtReady);
});

test("final inspection failure reports uncertainty without echoing arbitrary failure values", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let inspections = 0;
  opts.dependencies.invoke = async (request) => {
    // The first leased inspection is the final one; the mapping read is lease-free.
    if (request.args[1] === "inspect" && ++inspections === 1) {
      throw new Error("synthetic-private-canary");
    }
    return invoke(request);
  };
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("cleanup is unconfirmed");
  expect((failure as Error).message).not.toContain("synthetic-private-canary");
  expect((failure as Error).cause).toBeUndefined();
  expect(Bun.inspect(failure)).not.toContain("synthetic-private-canary");
  expect(JSON.stringify(failure)).not.toContain("synthetic-private-canary");
  expect(events).not.toContain("remove");
});

test("a refusal before admission reports that nothing was created, with the runtime reason", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  const refusal = new NativeRuntimeRequestError({
    message:
      "Native graph startup was interrupted or failed (graph_image); inspect owned state before retrying. Service web: Pinned image architecture or implicit volumes are incompatible.",
    nativeCode: "graph_image",
    nativeMessage:
      "Pinned image architecture or implicit volumes are incompatible.",
    nativeService: "web",
  });
  opts.dependencies.serve = async () => {
    throw refusal;
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect") {
      throw new NativeRuntimeRequestError({
        message:
          "Native runtime request failed (graph_unreserved); inspect owned state before retrying.",
        nativeCode: "graph_unreserved",
      });
    }
    return invoke(request);
  };
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(ClosedCliError);
  expect((failure as Error).message).toBe(
    "Native graph startup failed before any runtime state was reserved; nothing was created and no cleanup is needed. Startup diagnostic: Native graph startup was interrupted or failed (graph_image). Service web: Pinned image architecture or implicit volumes are incompatible. The native VM pool may still be running; when no other native project uses it, stop it with runtime down --json on this native home."
  );
  expect((failure as Error).cause).toBeUndefined();
  expect(nativeRuntimeFailure(failure)).toEqual({
    code: "graph_image",
    message: "Pinned image architecture or implicit volumes are incompatible.",
    service: "web",
  });
  expect(events).not.toContain("save");
  expect(events).not.toContain("remove");
  expect(events.at(-1)).toBe("cleanup");
});

test("an unreserved inspection without a settled startup failure stays uncertain", async () => {
  const { opts } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let inspections = 0;
  opts.dependencies.invoke = async (request) => {
    // The first leased inspection is the final one; the mapping read is lease-free.
    if (request.args[1] === "inspect" && ++inspections === 1) {
      throw new NativeRuntimeRequestError({
        message: "unreserved",
        nativeCode: "graph_unreserved",
      });
    }
    return invoke(request);
  };
  const failure = await startNativeProject(opts).catch(
    (error: unknown) => error
  );
  expect((failure as Error).message).toContain("cleanup is unconfirmed");
});

test("foreground up reports a stopped service and ends like Compose once all services stopped", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  let run = "";
  opts.dependencies.exitMonitorIntervalMs = 1;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "observe") {
      events.push("graph observe");
      return {
        run,
        phase: "ready-observed",
        services: { web: { state: "exited", code: 2 } },
      };
    }
    return invoke(request);
  };
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (args) => {
    run = args.run;
    return await serve({
      ...args,
      onReady: async () => {
        await args.onReady();
        await new Promise((resolve) =>
          args.signal?.addEventListener("abort", resolve, { once: true })
        );
      },
    });
  };
  const progress: string[] = [];
  expect(
    await startNativeProject({
      ...opts,
      onProgress: (event) =>
        progress.push(
          event.phase === "service-exited"
            ? `${event.service}:${event.state}:${"code" in event ? event.code : ""}`
            : event.phase
        ),
    })
  ).toBe(0);
  expect(progress.slice(progress.indexOf("ready"))).toEqual([
    "ready",
    "web:exited:2",
    "all-stopped",
    "stopping",
    "stopped",
  ]);
  expect(events).toContain("graph observe");
  expect(events.at(-1)).toBe("cleanup");
});

test("HTTPS route paths come only from reviewed native probes and conflicts refuse", () => {
  const service = (path: string) => ({
    routing: { hostnames: ["web.example.com"] },
    healthcheck: { native_http: { path } },
  });
  expect(
    reviewedNativeHttpsRoutes(
      { services: { web: service("/api/health") } },
      new Set(["web"])
    )
  ).toEqual([
    { hostname: "web.example.com", path: "/api/health", service: "web" },
  ]);
  expect(() =>
    reviewedNativeHttpsRoutes(
      { services: { web: service("/health"), other: service("/other") } },
      new Set(["web", "other"])
    )
  ).toThrow();
  expect(() =>
    reviewedNativeHttpsRoutes(
      { services: { web: { routing: { hostnames: ["web.example.com"] } } } },
      new Set(["web"])
    )
  ).toThrow(NATIVE_CONFIGURATION_REFUSAL);
});

test("malformed reviewed runtime plans refuse as unconfirmed, not as configuration", () => {
  const routed = {
    routing: { hostnames: ["web.example.com"] },
    healthcheck: { native_http: { path: "/health" } },
  };
  for (const plan of [
    null,
    {},
    { services: [] },
    { services: {} },
    { services: { web: { ...routed, routing: {} } } },
    { services: { web: { ...routed, routing: { hostnames: [7] } } } },
  ]) {
    let refusal: unknown;
    try {
      reviewedNativeHttpsRoutes(plan, new Set(["web"]));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ClosedCliError);
    expect(refusal).not.toBeInstanceOf(HackCliError);
    expect(String(refusal)).toContain(
      "Native foreground up could not confirm the reviewed runtime plan"
    );
  }
});

test("HTTPS startup refuses a non-2xx reviewed health response", async () => {
  const { opts, events } = await httpsFixture();
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => ({ statusCode: 403 }),
    releaseAfterCleanup: async () => {
      events.push("https-close");
    },
  });
  await expect(
    startNativeProject({ ...opts, https: httpsSelection })
  ).rejects.toThrow("HTTP_STATUS_403");
  // Saved at started, before the lease (PR B); a later failure keeps it.
  expect(events.filter((event) => event === "save")).toHaveLength(1);
  expect(events).toContain("https-close");
});

test("inferred HTTPS readiness accepts 2xx-4xx without following redirects and rejects 5xx", async () => {
  const probe = {
    policy: "route",
    port: 3000,
    path: "/",
    interval_ms: 30_000,
    timeout_ms: 1000,
    retries: 3,
    start_period_ms: 240_000,
  };
  const plan = {
    services: {
      web: {
        routing: { port: 3000, hostnames: ["web.example.hack"] },
        healthcheck: { disabled: false, native_http: probe },
      },
    },
  };
  for (const statusCode of [200, 204, 299, 301, 399, 400, 404, 499]) {
    const calls: string[] = [];
    await verifyHttpsRoutes(
      {
        httpsPort: 18_443,
        verifyHostname: async (hostname, path) => {
          calls.push(hostname);
          expect(path).toBe("/");
          return {
            statusCode,
            location: "https://foreign.invalid/",
            upstreamVerified: true,
          };
        },
      },
      plan,
      new Set(["web"])
    );
    expect(calls).toEqual(["web.example.hack"]);
  }
  for (const statusCode of [199, 500, 503, 599, 600]) {
    await expect(
      verifyHttpsRoutes(
        {
          httpsPort: 18_443,
          verifyHostname: async () => ({ statusCode, upstreamVerified: true }),
        },
        plan,
        new Set(["web"])
      )
    ).rejects.toThrow();
  }
  for (const statusCode of [200, 403, 404, 421, 502]) {
    await expect(
      verifyHttpsRoutes(
        { httpsPort: 18_443, verifyHostname: async () => ({ statusCode }) },
        plan,
        new Set(["web"])
      )
    ).rejects.toThrow("UPSTREAM_RESPONSE_UNCONFIRMED");
  }
  const explicit = {
    services: {
      web: {
        ...plan.services.web,
        healthcheck: { native_http: { ...probe, policy: undefined } },
      },
    },
  };
  await expect(
    verifyHttpsRoutes(
      { httpsPort: 18_443, verifyHostname: async () => ({ statusCode: 404 }) },
      explicit,
      new Set(["web"])
    )
  ).rejects.toThrow();
});

test("HTTPS redirects terminate only at verified same-service reviewed aliases", async () => {
  const plan = {
    services: {
      web: {
        routing: {
          hostnames: ["legacy.hack", "canonical.hack.gy", "third.hack.local"],
        },
        healthcheck: { native_http: { path: "/health" } },
      },
      other: {
        routing: { hostnames: ["other.hack"] },
        healthcheck: { native_http: { path: "/health" } },
      },
    },
  };
  const responses = new Map<string, { statusCode: number; location?: string }>([
    [
      "legacy.hack",
      { statusCode: 307, location: "https://canonical.hack.gy/health" },
    ],
    [
      "canonical.hack.gy",
      { statusCode: 308, location: "https://third.hack.local:18443/health" },
    ],
    ["third.hack.local", { statusCode: 200 }],
    ["other.hack", { statusCode: 204 }],
  ]);
  const calls: string[] = [];
  const frontend = {
    caPath: "/public",
    httpsPort: 18_443,
    exited: new Promise<{ component: string; code: number }>(() => {}),
    releaseAfterCleanup: async () => {},
    verifyHostname: async (hostname: string, path: string) => {
      expect(path).toBe("/health");
      calls.push(hostname);
      const response = responses.get(hostname);
      if (!response) {
        throw new Error("Unexpected network target");
      }
      return response;
    },
  };
  await verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]));
  expect(calls.length).toBe(4);
  for (const location of [
    "http://canonical.hack.gy/health",
    "https://external.invalid/health",
    "https://other.hack/health",
    "https://user:pass@canonical.hack.gy/health",
    "https://canonical.hack.gy:1234/health",
    "https://canonical.hack.gy/wrong",
    "https://canonical.hack.gy/health?q=1",
    "https://canonical.hack.gy/health#fragment",
    "https://legacy.hack/health",
  ]) {
    responses.set("legacy.hack", { statusCode: 307, location });
    await expect(
      verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]))
    ).rejects.toThrow();
  }
  responses.set("legacy.hack", {
    statusCode: 307,
    location: "https://canonical.hack.gy/health",
  });
  responses.set("third.hack.local", { statusCode: 503 });
  await expect(
    verifyHttpsRoutes(frontend, plan, new Set(["web", "other"]))
  ).rejects.toThrow();
});

test("startup persists resolved environment selection only after readiness", async () => {
  const { opts } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    effectiveEnvName: "qa",
  });
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async (request) => {
    saved = request.run;
  };
  opts.dependencies.remove = async (request) => {
    expect(saved).toBe(request.expected);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(saved).toMatchObject({ effectiveEnvName: "qa" });
});

test("startup persists only explicit public AWS profile selection for later commands", async () => {
  const { opts } = await fixture();
  opts.dependencies.adaptAws = async ({ input, profile }) => ({
    input,
    receipt: { profile, expiry: "2099-01-01T00:00:00Z", services: ["web"] },
  });
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async ({ run }) => {
    saved = run;
  };
  opts.dependencies.remove = async ({ expected }) => {
    expect(saved).toBe(expected);
  };
  await startNativeProject({
    ...opts,
    aws: { profile: "qa", region: "us-east-1" },
  });
  expect(saved?.aws).toEqual({ profile: "qa", region: "us-east-1" });
  expect(JSON.stringify(saved)).not.toContain("2099-");
});

test("normal startup defaults to public internet without per-host declarations", async () => {
  const { opts } = await fixture(false);
  const invoke = opts.dependencies.invoke!;
  let up: readonly string[] = [];
  opts.dependencies.invoke = async (call) => {
    if (call.args[0] === "runtime" && call.args[1] === "up") {
      up = call.args;
    }
    return await invoke(call);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(up).toContain("--internet");
  expect(up).not.toContain("--allow-host");
});

test("startup persists exact normalized profiles for later restart", async () => {
  const { opts } = await fixture();
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async ({ run }) => {
    saved = run;
  };
  opts.dependencies.remove = async ({ expected }) => {
    expect(saved).toBe(expected);
  };
  await startNativeProject({ ...opts, profiles: ["worker", "qa", "worker"] });
  expect(saved?.profiles).toEqual(["qa", "worker"]);
});
test("invalid profile selection refuses before lifecycle or runtime effects", async () => {
  const { opts } = await fixture();
  opts.dependencies.load = async () => {
    throw new Error("unexpected access");
  };
  await expect(
    startNativeProject({ ...opts, profiles: ["bad\nprofile"] })
  ).rejects.toThrow("profiles");
});

test("retained startup refuses missing, unacknowledged or changed finalization before effects", async () => {
  for (const fault of [
    "missing",
    "unacknowledged",
    "stale-completion",
    "changed",
  ] as const) {
    const { opts, events, saved } = await retainedFinalizationFixture();
    if (fault === "unacknowledged") {
      await beginNativeProjectFinalization({ scope: opts.scope, run: saved });
    } else if (fault !== "missing") {
      await acknowledgeRetainedFrontend(opts.scope, saved);
      if (fault === "stale-completion") {
        await beginNativeProjectFinalization({ scope: opts.scope, run: saved });
      } else {
        opts.dependencies.captureFinalization = async (selection) => {
          const original = await captureNativeProjectFinalization(selection);
          await acknowledgeRetainedFrontend(opts.scope, saved);
          return original;
        };
      }
    }
    opts.dependencies.https = async () => {
      throw new Error("unexpected HTTPS owner effect");
    };
    const attempt = startNativeProject({
      ...opts,
      https: httpsSelection,
      adaptationFile: join(opts.scope.projectRoot, "unread-adaptation.json"),
    });
    await expect(attempt).rejects.toMatchObject({
      code: "E_RECOVERY_REQUIRED",
      message: expect.stringContaining("Run hack down --recover"),
    });
    try {
      await attempt;
    } catch (error) {
      expect(String(error)).not.toContain(opts.scope.nativeHome);
    }
    expect(events).toEqual(["graph retained-preflight", "graph inspect"]);
  }
});

test("retained startup admits only the acknowledged original frontend before effects", async () => {
  const { opts, events, saved } = await retainedFinalizationFixture();
  const lifetime = await acknowledgeRetainedFrontend(opts.scope, saved);
  opts.dependencies.waitFinalization = async (selection) => {
    expect(selection.token).toEqual(lifetime.token);
    expect(selection.run).toEqual(saved);
    expect(selection.timeoutMs).toBe(1);
    await waitNativeProjectFinalization(selection);
    events.push("frontend-acknowledged");
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(events.indexOf("frontend-acknowledged")).toBeLessThan(
    events.indexOf("storage")
  );
  expect(events.indexOf("frontend-acknowledged")).toBeLessThan(
    events.indexOf("prepare")
  );
  expect(events.indexOf("frontend-acknowledged")).toBeLessThan(
    events.indexOf("before")
  );
  expect(events.indexOf("frontend-acknowledged")).toBeLessThan(
    events.indexOf("runtime up")
  );
  expect(events).toContain("save");
});

test("an undeclared COMPOSE_PROFILES value never reaches the runtime review (HACK-2338 item 8)", async () => {
  const token = "synthetic-secret-token-value";
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: { image: `sha256:${"e".repeat(64)}` },
        jobs: { image: `sha256:${"e".repeat(64)}`, profiles: ["jobs"] },
      },
    }),
    serviceNames: ["web", "jobs"],
  });
  const reviewed: unknown[] = [];
  opts.dependencies.review = async (request) => {
    reviewed.push(request.profiles);
    return await request.run({
      planId: "a".repeat(64),
      namespace: "b".repeat(64),
      projectArgs: ["--project", request.projectRoot],
      report: {
        plan: {
          enrollment_compatible: true,
          services: { web: { active: true }, jobs: { active: true } },
        },
      },
    });
  };
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  expect(
    await startNativeProject({
      ...opts,
      profiles: undefined,
      resolveProfiles: () =>
        Promise.resolve(
          selectNativeProfiles({
            cliProfiles: undefined,
            managedEnv: { COMPOSE_PROFILES: `jobs,${token}` },
            shellEnv: {},
            declaredProfiles: ["jobs"],
          })
        ),
    })
  ).toBe(0);
  expect(reviewed).toEqual([["jobs"]]);
  expect(JSON.stringify(reviewed)).not.toContain(token);
  expect(notices.join("\n")).not.toContain(token);
});

test("a retained run keeps its profiles when the managed env now selects others, and says so (HACK-2338 item 8)", async () => {
  const { opts, saved } = await retainedFinalizationFixture();
  await acknowledgeRetainedFrontend(opts.scope, saved);
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  const asked: unknown[] = [];
  expect(
    await startNativeProject({
      ...opts,
      profiles: undefined,
      resolveProfiles: (envName) => {
        asked.push(envName);
        return Promise.resolve({
          profiles: ["jobs"],
          source: "managed-env" as const,
          declaredProfiles: ["jobs"],
        });
      },
    })
  ).toBe(0);
  // Resolved for the retained run's own env, not the configured default.
  expect(asked).toEqual([saved.effectiveEnvName]);
  // Names from the env or the retained run are counted, never printed.
  const retained = (saved.profiles ?? []).length;
  const retainedText =
    retained === 0
      ? "none"
      : `${retained} profile${retained === 1 ? "" : "s"} (names not shown)`;
  expect(notices).toContain(
    `COMPOSE_PROFILES in the managed env selects profiles 1 profile (names not shown), but this instance's retained run uses ${retainedText}; it keeps those. To start it with the new profiles, stop it with hack down --remove-data (this deletes its data volumes) and run hack up again.`
  );
  expect(notices.join("\n")).not.toContain("jobs");
});

/**
 * HACK-1952: a retained startup in the owning home and a release of its mapping from
 * another native home must not interleave. The startup is admitted under the owning
 * home's finalization lock before its last mapping check and any runtime effect.
 */
async function retainedStartWithAnotherHome() {
  const fixture = await retainedFinalizationFixture();
  const { opts, saved } = fixture;
  await saveNativeProjectRun({ ...opts.scope, run: saved });
  await acknowledgeRetainedFrontend(opts.scope, saved);
  opts.dependencies.load = loadNativeProjectRun;
  const otherHome = await mkdtemp(join(tmpdir(), "native-start-home-b-"));
  roots.push(otherHome);
  const other = { ...opts.scope, nativeHome: otherHome };
  const inspect = async () =>
    (await inspectNativeProjectRunMapping({
      scope: other,
      runtime: { binary: join(otherHome, "absent-runtime"), home: otherHome },
    })) as NativeProjectRunForeignHomeInspection;
  const stopped = await inspect();
  expect(stopped.owner).toBe("stopped");
  const release = () =>
    releaseNativeProjectRunForeignHome({
      scope: other,
      expectSelection: stopped.selectionSha256 ?? "",
    });
  const admissions = async () =>
    (
      await readdir(join(opts.scope.nativeHome, ".hack-local"), {
        recursive: true,
      })
    ).filter((name) => name.endsWith("admission.json"));
  return { ...fixture, inspect, release, admissions };
}

test("a release from another home refuses while the owning home admits a retained startup", async () => {
  const { opts, events, saved, inspect, release, admissions } =
    await retainedStartWithAnotherHome();
  opts.dependencies.admitFinalization = async (selection) => {
    const admitted = await admitNativeProjectFinalization(selection);
    // Interleave: the other home tries to release right after admission.
    expect((await inspect()).owner).toBe("live");
    await expectClosedRefusal(release(), "is owned by live run");
    events.push("release refused");
    return admitted;
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[0] === "runtime" && request.args[1] === "up") {
      // Runtime effects begin only while the admission still excludes release.
      expect(await admissions()).toHaveLength(1);
      await expectClosedRefusal(release(), "is owned by live run");
    }
    return await invoke(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(events.indexOf("release refused")).toBeLessThan(
    events.indexOf("runtime up")
  );
  // Readiness registered the new lifetime and retired the admission.
  expect(await admissions()).toEqual([]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(saved);
});

test("a release that wins before admission makes the retained startup refuse before runtime effects", async () => {
  const { opts, events, release, admissions } =
    await retainedStartWithAnotherHome();
  opts.dependencies.admitFinalization = async (selection) => {
    // Interleave: the other home releases just before this startup is admitted.
    expect((await release()).released).toBe(true);
    events.push("released");
    return await admitNativeProjectFinalization(selection);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "Native retained run mapping changed before runtime start; no start was requested."
  );
  expect(events).toContain("released");
  expect(events).not.toContain("runtime up");
  // A startup that ends before any runtime effect leaves no admission behind.
  expect(await admissions()).toEqual([]);
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});

test("retained acknowledgement cannot authorize a newer or concurrently changed mapping", async () => {
  for (const fault of ["newer-run", "changed-mapping"] as const) {
    const { opts, events, saved } = await retainedFinalizationFixture();
    await acknowledgeRetainedFrontend(opts.scope, saved);
    const newer = { ...saved, run: "2".repeat(32) };
    let loaded = 0;
    opts.dependencies.load = async () => {
      loaded++;
      return fault === "newer-run" || loaded > 1 ? newer : saved;
    };
    if (fault === "newer-run") {
      opts.dependencies.invoke = async (request) => {
        events.push(request.args.slice(0, 2).join(" "));
        return request.args[1] === "retained-preflight"
          ? retainedPreflight(newer)
          : stoppedGraph(newer);
      };
    }
    await expect(startNativeProject(opts)).rejects.toThrow(
      fault === "newer-run" ? "has no confirmed shutdown" : "mapping changed"
    );
    expect(events).toEqual(["graph retained-preflight", "graph inspect"]);
  }
});

test("ordinary up reuses a stopped owned run and publishes its mapping by comparison", async () => {
  const { opts, events, state } = await fixture();
  const saved: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  await acknowledgeRetainedFrontend(opts.scope, saved);
  opts.dependencies.load = async () => saved;
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "retained-preflight") {
      events.push("graph retained-preflight");
      return retainedPreflight(saved);
    }
    if (request.args[1] === "inspect" && !state.serving) {
      events.push("graph inspect");
      return stoppedGraph(saved);
    }
    return request.args[1] === "restore-selection"
      ? { ...saved, plan: saved.planId, generation: "2".repeat(64) }
      : await invoke(request);
  };
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    expect(request.run).toBe(saved.run);
    expect(request.restore).toBe(true);
    expect(request.args).toContain("--expect-generation");
    return await serve(request);
  };
  opts.dependencies.save = async ({ expected, run }) => {
    expect(expected).toEqual(saved);
    expect(run.run).toBe(saved.run);
    events.push("save");
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(events).toContain("save");
  expect(events).not.toContain("remove");
});
test("retained startup selection mismatch refuses before lifecycle effects", async () => {
  const { opts, events } = await fixture();
  const saved: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  opts.dependencies.load = async () => saved;
  opts.dependencies.invoke = async () => {
    events.push("graph inspect");
    return stoppedGraph(saved);
  };
  await expect(startNativeProject({ ...opts, envName: "qa" })).rejects.toThrow(
    "cannot change the retained run"
  );
  expect(events).toEqual([]);
});
test("restore startup passes the retained run and selected generation to its owner", async () => {
  const { opts } = await fixture();
  const saved = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) => {
    expect(request.retained).toEqual(saved);
    return await review(request);
  };
  const invoke = opts.dependencies.invoke!;
  const serve = opts.dependencies.serve!;
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "restore-selection"
      ? { ...saved, plan: saved.planId, generation: "2".repeat(64) }
      : await invoke(request);
  opts.dependencies.serve = async (request) => {
    expect(request.run).toBe(saved.run);
    expect(request.restore).toBe(true);
    expect(request.args).toContain("--expect-generation");
    expect(request.args).toContain("2".repeat(64));
    return await serve(request);
  };
  expect(await startNativeProject({ ...opts, restore: saved })).toBe(0);
});

test("ordinary up resumes a stopped owned VM once and requires live proof before restore", async () => {
  for (const failed of [
    "none",
    // HACK-2376: a home whose later boot failed and was recovered (`recovered-unclean`)
    // starts its retained run exactly as a clean stop does.
    "none-recovered-unclean",
    "resume-timeout",
    "live-proof",
    "changed-mapping",
    "cancel-preflight",
    "cancel-before-up",
  ]) {
    const { opts, events } = await fixture(false);
    const saved: NativeProjectRun = {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
      effectiveEnvName: null,
      profiles: [],
      aws: null,
    };
    await acknowledgeRetainedFrontend(opts.scope, saved);
    const controller = new AbortController();
    let up = 0,
      served = 0,
      loaded = 0;
    opts.dependencies.load = async () => {
      loaded++;
      return failed === "changed-mapping" && loaded > 1
        ? { ...saved, owner: "9".repeat(32) }
        : saved;
    };
    const invoke = opts.dependencies.invoke!;
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "retained-preflight") {
        expect(request.signal).toBe(controller.signal);
        events.push("offline-preflight");
        if (failed === "cancel-preflight") {
          controller.abort();
        }
        return retainedPreflight(
          saved,
          failed === "none-recovered-unclean" ? "recovered-unclean" : "stopped"
        );
      }
      if (request.args[0] === "runtime" && request.args[1] === "up") {
        up++;
        events.push("resume");
        expect(request.args).toContain("--expect-retained-run");
        expect(request.args).toContain(saved.run);
        expect(request.args).toContain("--expect-retained-selection");
        expect(request.args).toContain("7".repeat(64));
        expect(request.signal).toBeDefined();
        if (failed === "resume-timeout") {
          throw new Error(
            "Native runtime request timed out; outcome uncertain"
          );
        }
        return {};
      }
      if (request.args[1] === "inspect" && served === 0) {
        // This is the bug control: live inspection is impossible before the VM resumes.
        if (up === 0) {
          throw new Error("runtime_not_running");
        }
        events.push("live-retained-proof");
        return failed === "live-proof"
          ? { ...stoppedGraph(saved), journal_incomplete: true }
          : stoppedGraph(saved);
      }
      if (request.args[1] === "restore-selection") {
        events.push("restore-selection");
        return { ...saved, plan: saved.planId, generation: "2".repeat(64) };
      }
      return await invoke(request);
    };
    const before = opts.before;
    opts.before = async () => {
      if (failed === "cancel-before-up") {
        controller.abort();
      }
      return await before();
    };
    const serve = opts.dependencies.serve!;
    opts.dependencies.serve = async (request) => {
      served++;
      expect(events.indexOf("resume")).toBeLessThan(
        events.indexOf("live-retained-proof")
      );
      expect(events.indexOf("live-retained-proof")).toBeLessThan(
        events.indexOf("restore-selection")
      );
      expect(request.restore).toBe(true);
      expect(request.run).toBe(saved.run);
      return await serve(request);
    };
    const attempt = startNativeProject({ ...opts, signal: controller.signal });
    if (failed === "none" || failed === "none-recovered-unclean") {
      expect(await attempt).toBe(0);
      expect(served).toBe(1);
    } else {
      await expect(attempt).rejects.toThrow();
      expect(served).toBe(0);
    }
    expect(up).toBe(
      [
        "none",
        "none-recovered-unclean",
        "resume-timeout",
        "live-proof",
      ].includes(failed)
        ? 1
        : 0
    );
    if (failed === "cancel-preflight") {
      expect(events).toEqual(["offline-preflight"]);
    }
  }
});

test("retained selectors, foreign eligibility and pre-cancellation refuse before hooks or resume", async () => {
  for (const failed of [
    "env",
    "profiles",
    "aws",
    "foreign",
    "legacy",
    "canceled",
  ]) {
    const { opts, events } = await fixture(false);
    const saved: NativeProjectRun = {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
      effectiveEnvName: null,
      profiles: [],
      aws: null,
    };
    opts.dependencies.load = async () =>
      failed === "legacy"
        ? {
            run: saved.run,
            owner: saved.owner,
            namespace: saved.namespace,
            planId: saved.planId,
          }
        : saved;
    opts.dependencies.invoke = async () => {
      events.push("offline-preflight");
      return { ...retainedPreflight(saved, "stopped"), owner: "9".repeat(32) };
    };
    const controller = new AbortController();
    if (failed === "canceled") {
      controller.abort();
    }
    await expect(
      startNativeProject({
        ...opts,
        signal: controller.signal,
        ...(failed === "env" ? { envName: "qa" } : {}),
        ...(failed === "profiles" ? { profiles: ["qa"] } : {}),
        ...(failed === "aws" ? { aws: { profile: "qa" } } : {}),
      })
    ).rejects.toThrow();
    expect(events).toEqual(failed === "foreign" ? ["offline-preflight"] : []);
  }
});

test("changed shared source restores with old owner and cache publication", async () => {
  const { opts, events } = await fixture();
  const saved = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const currentPlan = "3".repeat(64);
  const baseline = "4".repeat(64);
  opts.dependencies.review = async (request) =>
    await request.run({
      planId: currentPlan,
      namespace: saved.namespace,
      projectArgs: ["--project", opts.scope.projectRoot],
      report: {
        plan: {
          enrollment_compatible: true,
          services: {
            web: { active: true, dependency_cache: { volume: "deps" } },
          },
        },
      },
    });
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "restore-selection") {
      return { ...saved, plan: saved.planId, generation: "2".repeat(64) };
    }
    if (request.args[1] === "source-compatibility") {
      return {
        run: saved.run,
        owner: saved.owner,
        namespace: saved.namespace,
        plan: saved.planId,
        reviewed_plan: currentPlan,
        source_revision: baseline,
      };
    }
    return await invoke(request);
  };
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    expect(request.restore).toBe(true);
    expect(request.args).toContain(baseline);
    expect(request.args).toContain(`${"web"}=completed`);
    return await serve(request);
  };
  expect(await startNativeProject({ ...opts, restore: saved })).toBe(0);
  expect(events).not.toContain("project publish-source");
});

test("restore selection mismatch never starts a replacement graph", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) =>
    request.args[1] === "restore-selection"
      ? { run: "changed" }
      : await invoke(request);
  let served = false;
  opts.dependencies.serve = async () => {
    served = true;
    return 0;
  };
  await expect(
    startNativeProject({
      ...opts,
      restore: {
        run: "1".repeat(32),
        owner: "c".repeat(32),
        namespace: "b".repeat(64),
        planId: "a".repeat(64),
      },
    })
  ).rejects.toThrow("selection changed");
  expect(served).toBe(false);
  expect(events.at(-1)).toBe("cleanup");
});

test("lost shared HTTPS acquire reply retains intent and recovers only after graph cleanup", async () => {
  for (const uncertainRecovery of [false, true]) {
    const { opts, events } = await httpsFixture();
    let intent: ReturnType<typeof leaseIdentity> | undefined;
    opts.dependencies.finalization = async (request) => {
      const lifetime = await beginNativeProjectFinalization(request);
      // The lifetime is registered before the mapping (no lease yet); the lease
      // intent then adds the lease to it (PR B review, item 1).
      events.push(request.httpsLease ? "intent" : "lifetime");
      return {
        ...lifetime,
        complete: async () => {
          await lifetime.complete();
          events.push("finalized");
        },
      };
    };
    opts.dependencies.https = async (selection) => {
      intent = leaseIdentity(selection);
      await selection.onIntent?.(intent);
      // The mapping was saved at started, before the lease intent (PR B).
      expect(events.at(-1)).toBe("intent");
      expect(events.indexOf("save")).toBeLessThan(events.indexOf("intent"));
      events.push("acquire-sent");
      throw new Error("acquire reply lost");
    };
    opts.dependencies.recoverHttps = async ({ identity }) => {
      if (!intent) {
        throw new Error("missing acquire intent");
      }
      expect(identity).toEqual(intent);
      expect(events.at(-1)).toBe("graph inspect");
      events.push("recover-lease");
      if (uncertainRecovery) {
        throw new Error("lease recovery uncertain");
      }
    };
    await expect(
      startNativeProject({ ...opts, https: httpsSelection })
    ).rejects.toThrow(
      uncertainRecovery ? "lease recovery uncertain" : "acquire reply lost"
    );
    expect(events.filter((event) => event === "save")).toHaveLength(1);
    expect(events).not.toContain("ready");
    expect(events.includes("finalized")).toBe(!uncertainRecovery);
    expect(events.indexOf("intent")).toBeLessThan(
      events.indexOf("acquire-sent")
    );
  }
});

test("restart callback follows ready and acknowledgement follows all finalizers", async () => {
  const { opts, events } = await httpsFixture();
  opts.dependencies.finalization = async (request) => {
    const lifetime = await beginNativeProjectFinalization(request);
    if (!request.httpsLease) {
      // Registered before the mapping; the lease is added to it below.
      expect(events).not.toContain("save");
      events.push("lifetime");
      return lifetime;
    }
    expect(lifetime.token).toMatchObject({
      version: 3,
      httpsLease: request.httpsLease,
    });
    expect(lifetime.token.attempt).toBe(request.httpsLease.attempt);
    return {
      ...lifetime,
      complete: async () => {
        await lifetime.complete();
        events.push("finalized");
      },
    };
  };
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => ({ statusCode: 200 }),
    releaseAfterCleanup: async () => {
      events.push("https-close");
    },
  });
  await startNativeProject({
    ...opts,
    https: httpsSelection,
    onReady: async () => {
      expect(events.at(-1)).toBe("ready");
      expect(events).toContain("save");
      events.push("restart-ready");
    },
  });
  expect(events.indexOf("restart-ready")).toBeLessThan(
    events.indexOf("https-close")
  );
  expect(events.slice(-3)).toEqual(["https-close", "cleanup", "finalized"]);
});

test("failed HTTPS or lifecycle finalization never acknowledges cleanup", async () => {
  for (const failed of ["https", "lifecycle"]) {
    const { opts } = await httpsFixture();
    let acknowledged = false;
    opts.dependencies.finalization = async (request) => {
      const lifetime = await beginNativeProjectFinalization(request);
      return {
        ...lifetime,
        complete: async () => {
          acknowledged = true;
        },
      };
    };
    opts.dependencies.https = async (selection) => ({
      identity: leaseIdentity(selection),
      caPath: "/synthetic/root.crt",
      httpsPort: 8443,
      exited: new Promise(() => {}),
      verifyHostname: async () => ({ statusCode: 200 }),
      releaseAfterCleanup: async () => {
        if (failed === "https") {
          throw new Error("close failed");
        }
      },
    });
    if (failed === "lifecycle") {
      opts.before = async () => ({
        ready: async () => {},
        cleanup: async () => {
          throw new Error("close failed");
        },
      });
    }
    await expect(
      startNativeProject({ ...opts, https: httpsSelection })
    ).rejects.toThrow("close failed");
    expect(acknowledged).toBe(false);
  }
});

test("pending retained restart refuses fresh startup before effects", async () => {
  const { opts, events } = await fixture(false);
  const run = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const lifetime = await beginNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  opts.dependencies.loadRestart = async () => ({
    phase: "prepared",
    run,
    finalization: lifetime.token,
  });
  await expect(startNativeProject(opts)).rejects.toThrow("pending restart");
  expect(events).toEqual([]);
});

test("startup admits private input before storage and prepares storage before plan effects", async () => {
  const { opts, events } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  opts.dependencies.prepareStorage = async (scope) => {
    expect(scope).toEqual(opts.scope);
    expect(events).toContain("input");
    events.push("storage");
  };
  opts.dependencies.prepare = async (request) => {
    expect(events).not.toContain("storage");
    events.push("input");
    return await prepare(request);
  };
  opts.dependencies.review = async (request) => {
    expect(events.indexOf("input")).toBeLessThan(events.indexOf("storage"));
    return await review(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
});

/** Read-only native answers for a branch restart preflight of the run 1…1. */
async function restartPreflightInvoke({
  args,
}: {
  readonly args: readonly string[];
}): Promise<unknown> {
  if (args[0] === "project") {
    expect(args).toContain("--branch");
    return {
      plan: { namespace: "b".repeat(64), compose_sha256: "d".repeat(64) },
    };
  }
  if (args[1] === "status") {
    return { network: "internet" };
  }
  if (args[1] === "probe") {
    return { admitted: true };
  }
  if (args[1] === "inspect") {
    return {
      journal_incomplete: false,
      receipt: {
        run: "1".repeat(32),
        owner: "c".repeat(32),
        namespace: "b".repeat(64),
        plan_id: "a".repeat(64),
        phase: "ready-observed",
        resources: {
          "container:web": {
            kind: "container",
            key: "web",
            id: "f".repeat(64),
          },
        },
      },
    };
  }
  if (args[1] === "run-selection") {
    expect(args[args.indexOf("--service") + 1]).toBe("web");
    return {
      ok: true,
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      plan: "a".repeat(64),
      service: "web",
      container: "f".repeat(64),
      boot: "owned-boot",
      generation: "e".repeat(64),
    };
  }
  throw new Error("unexpected preflight effect");
}

test("startup and restart review use identical branch routes after adaptation", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  const review = opts.dependencies.review!;
  const scope = { ...opts.scope, branch: "feature-a" };
  const adaptationFile = join(scope.projectRoot, "adaptation.json");
  await writeFile(opts.composeFile, "services: {}\n");
  await writeFile(
    join(scope.projectDir, "hack.config.json"),
    JSON.stringify({ dev_host: "app.hack.local" })
  );
  await writeFile(
    adaptationFile,
    JSON.stringify({
      version: 1,
      additionalHostnames: { web: ["app.hack.gy"] },
    })
  );
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.labels = {
      caddy: "app.hack.local",
      "caddy.tls": "internal",
      "caddy.reverse_proxy": "{{upstreams 3000}}",
    };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const before = async (input: NativeProjectInput) => {
    expect(
      JSON.parse(input.normalizedComposeJson).services.web.labels.caddy
    ).toBe("feature-a.app.hack.local, feature-a.app.hack.gy");
    return await opts.before();
  };
  const observed: NativeProjectInput[] = [];
  opts.dependencies.review = async (request) => {
    expect(request.branch).toBe("feature-a");
    observed.push(request.input);
    return await review(request);
  };
  expect(
    await startNativeProject({ ...opts, scope, adaptationFile, before })
  ).toBe(0);
  await preflightNativeRestart({
    runtime: opts.runtime,
    scope,
    composeFile: opts.composeFile,
    adaptationFile,
    run: {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
      effectiveEnvName: null,
      profiles: [],
      aws: null,
    },
    dependencies: {
      prepare: opts.dependencies.prepare,
      review: opts.dependencies.review,
      dependencies: async () => [],
      invoke: restartPreflightInvoke,
    },
  });
  expect(observed).toHaveLength(2);
  expect(observed[0]?.normalizedComposeJson).toBe(
    observed[1]?.normalizedComposeJson
  );
  expect(
    JSON.parse(observed[0]?.normalizedComposeJson ?? "{}").services.web.labels
      .caddy
  ).toBe("feature-a.app.hack.local, feature-a.app.hack.gy");
});

test("startup applies the per-env adaptation for the run's effective env, else the base", async () => {
  for (const [effectiveEnvName, expected] of [
    ["qa", "app.hack.local, qa.example.test"],
    [null, "app.hack.local, base.example.test"],
  ] as const) {
    const { opts } = await fixture(false);
    const prepare = opts.dependencies.prepare!;
    const base = join(opts.scope.projectRoot, "adaptation.json");
    const qa = join(opts.scope.projectRoot, "adaptation.qa.json");
    await writeFile(opts.composeFile, "services: {}\n");
    await writeFile(
      base,
      JSON.stringify({
        version: 1,
        additionalHostnames: { web: ["base.example.test"] },
      })
    );
    await writeFile(
      qa,
      JSON.stringify({
        version: 1,
        additionalHostnames: { web: ["qa.example.test"] },
      })
    );
    opts.dependencies.prepare = async (request) => {
      const input = await prepare(request);
      const compose = JSON.parse(input.normalizedComposeJson);
      compose.services.web.labels = {
        caddy: "app.hack.local",
        "caddy.tls": "internal",
        "caddy.reverse_proxy": "{{upstreams 3000}}",
      };
      return {
        ...input,
        effectiveEnvName,
        normalizedComposeJson: JSON.stringify(compose),
      };
    };
    let caddy: unknown;
    const before = async (input: NativeProjectInput) => {
      caddy = JSON.parse(input.normalizedComposeJson).services.web.labels.caddy;
      return await opts.before();
    };
    expect(
      await startNativeProject({
        ...opts,
        adaptationFile: base,
        adaptationFileByEnv: { qa },
        before,
      })
    ).toBe(0);
    expect(caddy).toBe(expected);
  }
});

test("startup records the requested or default env and marks runs without managed env files", async () => {
  for (const [envName, defaultOverlay, managed] of [
    ["qa", undefined, "none"],
    [undefined, "qa", "none"],
    ["qa", undefined, "overlay"],
    ["qa", undefined, "base"],
  ] as const) {
    const { opts } = await fixture(false);
    if (managed !== "none") {
      // Value-free managed env files: the base, and the qa overlay unless base-only.
      for (const name of managed === "base" ? ["default"] : ["default", "qa"]) {
        await writeFile(
          join(opts.scope.projectDir, `hack.env.${name}.yaml`),
          JSON.stringify({
            version: 1,
            environment: name,
            secretsprovider: "project_key",
            values: { global: {} },
          })
        );
      }
    }
    const base = join(opts.scope.projectRoot, "adaptation.json");
    const qa = join(opts.scope.projectRoot, "adaptation.qa.json");
    await writeFile(
      opts.composeFile,
      JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            labels: {
              caddy: "app.hack.local",
              "caddy.tls": "internal",
              "caddy.reverse_proxy": "{{upstreams 3000}}",
            },
          },
        },
      })
    );
    await writeFile(
      join(opts.scope.projectDir, "hack.config.json"),
      JSON.stringify({
        name: "fixture",
        ...(defaultOverlay === undefined ? {} : { env: { defaultOverlay } }),
      })
    );
    for (const [file, host] of [
      [base, "base.example.test"],
      [qa, "qa.example.test"],
    ] as const) {
      await writeFile(
        file,
        JSON.stringify({ version: 1, additionalHostnames: { web: [host] } })
      );
    }
    // The real input preparation, so the unmanaged runs have no hack.env.* file.
    opts.dependencies.prepare = prepareNativeProjectInput;
    const save = opts.dependencies.save!;
    const recorded: unknown[] = [];
    opts.dependencies.save = async (request) => {
      recorded.push({
        effectiveEnvName: request.run.effectiveEnvName,
        unmanagedEnvironment: request.run.unmanagedEnvironment,
        baseOnlyEnvironment: request.run.baseOnlyEnvironment,
      });
      return await save(request);
    };
    let caddy: unknown;
    const before = async (input: NativeProjectInput) => {
      caddy = JSON.parse(input.normalizedComposeJson).services.web.labels.caddy;
      return await opts.before();
    };
    expect(
      await startNativeProject({
        ...opts,
        ...(envName === undefined ? {} : { envName }),
        adaptationFile: base,
        adaptationFileByEnv: { qa },
        before,
      })
    ).toBe(0);
    expect(caddy).toBe("app.hack.local, qa.example.test");
    expect(recorded.length).toBeGreaterThan(0);
    for (const mapping of recorded) {
      expect(mapping).toEqual({
        effectiveEnvName: "qa",
        unmanagedEnvironment: managed === "none" ? true : undefined,
        baseOnlyEnvironment: managed === "base" ? true : undefined,
      });
    }
  }
});

test("a retained run that started with managed env files refuses before hooks once they are gone", async () => {
  const removed =
    "Native up refused: .hack/hack.env.qa.yaml or .hack/hack.env.qa.local.yaml was removed since this run started. Restore it and run hack up again, or run hack down (with it restored if the project has down hooks), then hack up, to start without it; retained data was not replaced.";
  const appeared = (file: string) =>
    `Native up refused: .hack/${file} appeared since this run started. Run hack down, then hack up, to start with it; retained data was not replaced.`;
  for (const [marker, files, expected] of [
    [undefined, [], removed],
    ["unmanagedEnvironment", [], "unmanaged"],
    [undefined, ["hack.env.qa.yaml"], "managed"],
    // A base-only start survives while the overlay stays absent.
    ["baseOnlyEnvironment", ["hack.env.default.yaml"], "baseOnly"],
    // An overlay or env file appearing after a base-only or unmanaged start is a change.
    [
      "baseOnlyEnvironment",
      ["hack.env.default.yaml", "hack.env.qa.yaml"],
      appeared("hack.env.qa.yaml"),
    ],
    [
      "unmanagedEnvironment",
      ["hack.env.qa.yaml"],
      appeared("hack.env.qa.yaml"),
    ],
    [
      "unmanagedEnvironment",
      ["hack.env.default.yaml"],
      appeared("hack.env.default.yaml"),
    ],
    // A mapping without a marker that finds only the base lost its overlay.
    [undefined, ["hack.env.default.yaml"], removed],
  ] as const) {
    const { opts, events } = await fixture(false);
    const environmentFiles = files.map((name) =>
      join(opts.scope.projectDir, name)
    );
    const restore: NativeProjectRun = {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
      effectiveEnvName: "qa",
      profiles: [],
      aws: null,
      ...(marker === undefined ? {} : { [marker]: true as const }),
    };
    const prepare = opts.dependencies.prepare!;
    opts.dependencies.prepare = async (request) => ({
      ...(await prepare(request)),
      effectiveEnvName: "qa",
      environmentFiles,
    });
    const invoke = opts.dependencies.invoke!;
    opts.dependencies.invoke = async (request) =>
      request.args[1] === "restore-selection"
        ? { ...restore, plan: restore.planId, generation: "2".repeat(64) }
        : await invoke(request);
    const saved: NativeProjectRun[] = [];
    opts.dependencies.save = async (request) => {
      saved.push(request.run);
    };
    const started = startNativeProject({ ...opts, restore });
    if (expected.startsWith("Native up refused")) {
      expect((await expectClosedRefusal(started, expected)).message).toBe(
        expected
      );
      expect(events).not.toContain("before");
      expect(saved).toEqual([]);
      continue;
    }
    expect(await started).toBe(0);
    expect(events).toContain("before");
    expect(saved.length).toBeGreaterThan(0);
    for (const mapping of saved) {
      // A managed run is never relabeled; a marked run keeps its marker.
      expect(mapping.unmanagedEnvironment).toBe(
        expected === "unmanaged" ? true : undefined
      );
      expect(mapping.baseOnlyEnvironment).toBe(
        expected === "baseOnly" ? true : undefined
      );
    }
  }
});

test("startup and restart review identical branch runtime metadata; legacy runs get none", async () => {
  const { opts } = await fixture(false);
  const review = opts.dependencies.review!;
  const scope = { ...opts.scope, branch: "feature-a" };
  await writeFile(opts.composeFile, "services: {}\n");
  await writeFile(
    join(scope.projectDir, "hack.config.json"),
    JSON.stringify({ dev_host: "app.hack.local" })
  );
  const selection = {
    devHost: "app.hack.local",
    aliasHost: null,
    projectName: "app",
  };
  const observed: string[] = [];
  opts.dependencies.review = async (request) => {
    observed.push(request.input.normalizedComposeJson);
    return await review(request);
  };
  expect(
    await startNativeProject({
      ...opts,
      scope,
      https: httpsSelection,
      runtimeMetadata: selection,
    })
  ).toBe(0);
  const run: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  for (const recorded of [{ ...run, runtimeMetadata: true as const }, run]) {
    await preflightNativeRestart({
      runtime: opts.runtime,
      scope,
      composeFile: opts.composeFile,
      runtimeMetadata: selection,
      httpsPort: httpsSelection.httpsPort,
      run: recorded,
      dependencies: {
        prepare: opts.dependencies.prepare,
        review: opts.dependencies.review,
        dependencies: async () => [],
        invoke: restartPreflightInvoke,
      },
    });
  }
  expect(observed).toHaveLength(3);
  expect(observed[1]).toBe(observed[0]);
  const web = JSON.parse(observed[0] ?? "{}").services.web.environment;
  expect(web).toMatchObject({
    HACK_BRANCH: "feature-a",
    HACK_COMPOSE_PROJECT: "app--feature-a",
    HACK_DEV_HOST: "feature-a.app.hack.local",
    HACK_DEV_URL: "https://feature-a.app.hack.local:8443",
    HACK_SERVICE_NAME: "web",
    HACK_SERVICE_URLS: "[]",
  });
  expect(observed[2]).not.toContain("HACK_");
});

test("retained startup selects legacy labels only after runtime admission and before review", async () => {
  for (const changed of [false, true]) {
    const { opts } = await fixture(false);
    const saved = {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
    };
    const prepare = opts.dependencies.prepare!;
    opts.dependencies.prepare = async (request) => {
      const input = await prepare(request);
      const compose = JSON.parse(input.normalizedComposeJson);
      compose.services.web.labels = {
        caddy: "app.hack.local",
        "caddy.tls": "internal",
        "caddy.reverse_proxy": "{{upstreams 3000}}",
      };
      return { ...input, normalizedComposeJson: JSON.stringify(compose) };
    };
    const invoke = opts.dependencies.invoke!;
    let admitted = false;
    let reviewed = false;
    opts.dependencies.invoke = async (request) => {
      if (request.args[0] === "runtime" && request.args[1] === "up") {
        admitted = true;
      }
      if (request.args[0] === "project" && request.args[1] === "plan") {
        expect(admitted).toBe(true);
        return {
          plan: {
            namespace: request.args.includes("--branch")
              ? "d".repeat(64)
              : saved.namespace,
            compose_sha256: "d".repeat(64),
            source: await realpath(opts.scope.projectRoot),
          },
        };
      }
      if (request.args[1] === "restore-selection") {
        expect(admitted).toBe(true);
        return {
          ...saved,
          owner: changed ? "0".repeat(32) : saved.owner,
          plan: saved.planId,
          generation: "2".repeat(64),
        };
      }
      return await invoke(request);
    };
    const review = opts.dependencies.review!;
    opts.dependencies.review = async (request) => {
      reviewed = true;
      expect(request.reviewIdentity?.branch).toBeNull();
      expect(
        JSON.parse(request.input.normalizedComposeJson).services.web.labels
          .caddy
      ).toBe("app.hack.local");
      return await review(request);
    };
    const running = startNativeProject({
      ...opts,
      scope: { ...opts.scope, branch: "feature-a" },
      restore: saved,
    });
    if (changed) {
      await expect(running).rejects.toThrow("restore selection changed");
      expect(reviewed).toBe(false);
    } else {
      expect(await running).toBe(0);
      expect(reviewed).toBe(true);
    }
  }
});

function withImages(
  opts: Awaited<ReturnType<typeof fixture>>["opts"],
  services: Record<string, string>
) {
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: Object.fromEntries(
        Object.entries(services).map(([name, image]) => [name, { image }])
      ),
    }),
    serviceNames: Object.keys(services),
  });
}

test("an invalid image reference is refused before hooks, VM, provider or image effects", async () => {
  const { opts, events } = await fixture(false);
  withImages(opts, { web: "Private-Canary:3.21" });
  const invoke = opts.dependencies.invoke!;
  const admissions: string[] = [];
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "admit-image") {
      admissions.push(String(request.args[3]));
      throw new NativeRuntimeRequestError({
        message: "Image repository names must be lowercase.",
        nativeCode: "registry_image",
      });
    }
    return await invoke(request);
  };
  let served = false;
  opts.dependencies.serve = async () => {
    served = true;
    return 0;
  };
  let failure: unknown;
  try {
    await startNativeProject(opts);
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain(
    "image reference refused before runtime startup"
  );
  expect(String(failure)).not.toContain("Canary");
  expect(admissions).toEqual(["Private-Canary:3.21"]);
  // No startup hook, runtime/VM start, image acquisition or graph effect occurred.
  expect(events).toEqual([]);
  expect(served).toBe(false);
});

test("startup admits each reference once and reuses validated pins for shared service images", async () => {
  const { opts, events } = await fixture(false);
  const id = `sha256:${"e".repeat(64)}`;
  const cacheId = `sha256:${"f".repeat(64)}`;
  const canonical = "docker.io/library/alpine:3.21";
  withImages(opts, {
    web: "alpine:3.21",
    worker: canonical,
    cache: "redis",
    pinned: id,
  });
  opts.dependencies.review = async (request) => {
    const { services } = JSON.parse(request.input.normalizedComposeJson);
    expect(services.web.image).toBe(id);
    expect(services.worker.image).toBe(id);
    expect(services.cache.image).toBe(cacheId);
    expect(services.pinned.image).toBe(id);
    return await request.run({
      planId: "a".repeat(64),
      namespace: "b".repeat(64),
      projectArgs: ["--project", request.projectRoot],
      report: { plan: { enrollment_compatible: true, services: {} } },
    });
  };
  const invoke = opts.dependencies.invoke!;
  const order: string[] = [];
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "admit-image") {
      order.push(`admit ${request.args[3]}`);
      expect(request.timeoutMs).toBeLessThanOrEqual(10_000);
      if (request.args[3] === "alpine:3.21") {
        return { reference: canonical, kind: "docker_hub" };
      }
    }
    if (request.args[0] === "runtime" && request.args[1] === "up") {
      order.push("runtime up");
    }
    if (request.args[1] === "ensure-image") {
      order.push(`ensure ${request.args[3]}`);
      // Acquisition plus import gets the runtime's whole bounded request budget.
      expect(request.timeoutMs).toBe(2 * NATIVE_IMAGE_ENSURE_TIMEOUT_MS);
      expect(request.args.slice(0, 5)).toEqual([
        "runtime",
        "ensure-image",
        "--reference",
        String(request.args[3]),
        "--json",
      ]);
      return { image_id: request.args[3] === "alpine:3.21" ? id : cacheId };
    }
    return await invoke(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(order).toEqual([
    "admit alpine:3.21",
    `admit ${canonical}`,
    "admit redis",
    "runtime up",
    "ensure alpine:3.21",
    "ensure redis",
  ]);
  expect(events.indexOf("before")).toBeLessThan(events.indexOf("runtime up"));
});

test("one image batch uses the combined deadline and stops before the next wave", async () => {
  const { opts } = await fixture(false);
  withImages(opts, { web: "a:1", worker: "b:1", cache: "c:1", db: "d:1" });
  const original = opts.dependencies.invoke!;
  let waves = 0;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] !== "ensure-images") {
      return await original(request);
    }
    waves += 1;
    expect(request.timeoutMs).toBe(1_800_000);
    return [
      [0, { Err: { code: "provider_busy" } }, 1],
      [1, { Err: { code: "image_disk_space" } }, 2],
      [2, { Ok: { image_id: `sha256:${"c".repeat(64)}` } }, 3],
    ];
  };
  const error = await startNativeProject(opts).catch(
    (failure: unknown) => failure
  );
  expect(waves).toBe(1);
  expect(error).toMatchObject({
    code: "E_LIFECYCLE_FAILED",
    detail: {
      images: [
        {
          reference: "a:1",
          code: "provider_busy",
          recovery: "Run hack up again after the current image work finishes.",
        },
        {
          reference: "b:1",
          code: "image_disk_space",
          recovery: "Free disk space and run hack up again.",
        },
      ],
    },
  });
});

test("an older runtime falls back to ordinary image selection", async () => {
  const { opts } = await fixture(false);
  withImages(opts, { web: "alpine:1", worker: "redis:1" });
  const original = opts.dependencies.invoke!;
  const calls: string[] = [];
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "ensure-images") {
      calls.push("batch");
      throw new NativeRuntimeRequestError({
        nativeCode: "unsupported_command",
        message: "Older runtime",
      });
    }
    if (request.args[1] === "ensure-image") {
      calls.push(String(request.args[3]));
      return { image_id: `sha256:${"c".repeat(64)}` };
    }
    return await original(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(calls).toEqual(["batch", "alpine:1", "redis:1"]);
});

test("a changed 11-service plan uses the loaded selections of two recorded references", async () => {
  const { opts } = await fixture(false);
  const image = `sha256:${"e".repeat(64)}`;
  const reference = "docker.io/fixture/app:stable";
  const alias = "docker.io/fixture/app:also-stable";
  const names = [
    "web",
    ...Array.from({ length: 10 }, (_, index) => `worker${index + 1}`),
  ];
  withImages(
    opts,
    Object.fromEntries(
      names.map((name, index) => [name, index < 8 ? reference : alias])
    )
  );
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    originalSha256: "1".repeat(64),
  });
  const ensureRequests: string[] = [];
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "ensure-image") {
      ensureRequests.push(String(request.args[3]));
      return {
        image_id: image,
        pinned_reference: `docker.io/fixture/app@${image}`,
        tag_resolution: { source: "recorded" },
      };
    }
    return await invoke(request);
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) => {
    const specs = JSON.parse(request.input.normalizedComposeJson).services;
    expect(Object.keys(specs)).toEqual(names);
    expect(
      Object.values(specs).map((spec) => (spec as { image: string }).image)
    ).toEqual(names.map(() => image));
    return await review(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(ensureRequests).toEqual([reference, alias]);
});

test("a service outside the selected profiles is not pulled, and the start says it was left out (HACK-2338)", async () => {
  const id = `sha256:${"e".repeat(64)}`;
  for (const selected of [[], ["jobs"]] as const) {
    const { opts } = await fixture(false);
    const prepare = opts.dependencies.prepare!;
    opts.dependencies.prepare = async (request) => ({
      ...(await prepare(request)),
      normalizedComposeJson: JSON.stringify({
        services: {
          web: { image: "alpine:3.21" },
          jobs: { image: "redis", profiles: ["jobs"] },
        },
      }),
      serviceNames: ["web", "jobs"],
    });
    opts.dependencies.review = async (request) =>
      request.run({
        planId: "a".repeat(64),
        namespace: "b".repeat(64),
        projectArgs: ["--project", request.projectRoot],
        report: {
          plan: {
            enrollment_compatible: true,
            services: {
              web: { active: true },
              jobs: { active: selected.length > 0 },
            },
          },
        },
      });
    const ensured: string[] = [];
    const invoke = opts.dependencies.invoke!;
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "ensure-image") {
        ensured.push(String(request.args[3]));
        return { image_id: id };
      }
      return await invoke(request);
    };
    const notices: string[] = [];
    opts.dependencies.warn = (line) => notices.push(line);
    expect(
      await startNativeProject({
        ...opts,
        // No --profile: the managed env's COMPOSE_PROFILES decides.
        profiles: undefined,
        resolveProfiles: () =>
          Promise.resolve(
            selected.length > 0
              ? { profiles: [...selected], source: "managed-env" as const }
              : { profiles: [], source: "none" as const }
          ),
      })
    ).toBe(0);
    if (selected.length === 0) {
      expect(ensured).toEqual(["alpine:3.21"]);
      expect(notices).toContain(
        "Not starting 1 service whose Compose profiles are not selected: jobs. Selected profiles: none (from no --profile or COMPOSE_PROFILES). Select others with --profile or COMPOSE_PROFILES."
      );
    } else {
      expect(ensured).toEqual(["alpine:3.21", "redis"]);
      expect(notices.some((line) => line.startsWith("Not starting"))).toBe(
        false
      );
    }
  }
});

test("a runtime failure during image admission keeps its own diagnostic and starts nothing", async () => {
  const { opts, events } = await fixture(false);
  withImages(opts, { web: "alpine:3.21" });
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "admit-image") {
      throw new NativeRuntimeRequestError({
        message: "Native runtime request timed out.",
      });
    }
    return await invoke(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "Native runtime request timed out."
  );
  expect(events).toEqual([]);
});

test("opted-in amd64 services boot a translation pool and pin with their own platform policy", async () => {
  const { opts } = await fixture(false);
  const id = `sha256:${"e".repeat(64)}`;
  const sharedTag = "example/shared-image:2";
  const immutable = `docker.io/example/shared-image@${id}`;
  withImages(opts, {
    legacy: "example/amd64-only:1",
    tool: sharedTag,
    cache: sharedTag,
  });
  const adaptationFile = join(opts.scope.projectRoot, "adaptation.json");
  await writeFile(
    adaptationFile,
    JSON.stringify({
      version: 1,
      amd64Emulation: {
        default: "prefer-native",
        services: { legacy: "amd64", cache: "native" },
      },
    })
  );
  let reviewed: Record<string, Record<string, unknown>> = {};
  opts.dependencies.review = async (request) => {
    reviewed = JSON.parse(request.input.normalizedComposeJson).services;
    return await request.run({
      planId: "a".repeat(64),
      namespace: "b".repeat(64),
      projectArgs: ["--project", request.projectRoot],
      report: { plan: { enrollment_compatible: true, services: {} } },
    });
  };
  const invoke = opts.dependencies.invoke!;
  const up: string[][] = [];
  const ensured: string[][] = [];
  opts.dependencies.invoke = async (request) => {
    if (request.args[0] === "runtime" && request.args[1] === "up") {
      up.push([...request.args]);
    }
    if (request.args[1] === "ensure-image") {
      ensured.push([...request.args]);
      return {
        image_id: id,
        pinned_reference: immutable,
        platform: request.args.includes("amd64")
          ? "linux/amd64"
          : "linux/arm64",
      };
    }
    return await invoke(request);
  };
  expect(await startNativeProject({ ...opts, adaptationFile })).toBe(0);
  expect(up).toHaveLength(1);
  expect(up[0]).toContain("--amd64-emulation");
  expect(ensured).toEqual([
    [
      "runtime",
      "ensure-image",
      "--reference",
      "example/amd64-only:1",
      "--emulation",
      "amd64",
      "--json",
    ],
    [
      "runtime",
      "ensure-image",
      "--reference",
      sharedTag,
      "--emulation",
      "prefer-native",
      "--json",
    ],
    [
      "runtime",
      "ensure-image",
      "--reference",
      sharedTag,
      "--json",
      "--command-image-pin",
      immutable,
    ],
  ]);
  // Only opted-in services carry the reviewed runtime opt-in.
  expect(reviewed.legacy?.["x-hack-amd64-emulation"]).toBe("amd64");
  expect(reviewed.tool?.["x-hack-amd64-emulation"]).toBe("prefer-native");
  expect(reviewed.cache?.["x-hack-amd64-emulation"]).toBeUndefined();
});

test("without an emulation selection the runtime pool and image pins stay arm64-only", async () => {
  const { opts } = await fixture(false);
  withImages(opts, { web: "alpine:3.21" });
  const invoke = opts.dependencies.invoke!;
  const calls: string[][] = [];
  opts.dependencies.invoke = async (request) => {
    if (
      request.args[0] === "runtime" &&
      (request.args[1] === "up" || request.args[1] === "ensure-image")
    ) {
      calls.push([...request.args]);
    }
    if (request.args[1] === "ensure-image") {
      return { image_id: `sha256:${"e".repeat(64)}` };
    }
    return await invoke(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(calls.flat()).not.toContain("--amd64-emulation");
  expect(calls.flat()).not.toContain("--emulation");
});

test("a start reports the fallback reason once for each distinct image", async () => {
  const { opts } = await fixture(false);
  const notices: string[] = [];
  opts.dependencies.warn = (notice) => notices.push(notice);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: {
        web: { image: "alpine:latest" },
        worker: { image: "redis:latest" },
        another: { image: "alpine:latest" },
      },
    }),
  });
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "ensure-image") {
      const rateLimited = request.args.includes("redis:latest");
      return {
        image_id: `sha256:${"a".repeat(64)}`,
        pinned_reference: `docker.io/library/alpine@sha256:${"b".repeat(64)}`,
        platform: "linux/arm64",
        tag_resolution: {
          source: "offline",
          fallback_reason: rateLimited
            ? "registry_http_429"
            : "registry_http_404",
          resolved_at_unix_seconds: 1,
        },
      };
    }
    return await invoke(request);
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(
    notices.filter((line) => line.includes("using the loaded image"))
  ).toEqual([
    "tag no longer exists in the registry (404), using the loaded image resolved 1970-01-01T00:00:01.000Z",
    "registry rate limit reached, using the loaded image resolved 1970-01-01T00:00:01.000Z",
  ]);
});

test("retained startup asks the runtime to confirm the tag before review", async () => {
  const { opts, events } = await fixture(false);
  const saved = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const image = `sha256:${"e".repeat(64)}`;
  const stopped = stoppedGraph(saved);
  const observed = {
    ...stopped,
    receipt: {
      ...stopped.receipt,
      normalized_input: {
        namespace: saved.namespace,
        original_compose_sha256: "d".repeat(64),
        normalized_compose_sha256: "f".repeat(64),
      },
      resources: {
        "container:web": {
          ...stopped.receipt.resources["container:web"],
          image,
        },
      },
    },
  };
  opts.dependencies.retainedImages = selectNativeRetainedImages;
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    normalizedComposeJson: JSON.stringify({
      services: { web: { image: "redis:latest" } },
    }),
  });
  const invoke = opts.dependencies.invoke!;
  let beforeReview = true;
  let confirmed = false;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "image-tag-status") {
      return [
        {
          reference: "docker.io/library/redis:latest",
          aliases: ["redis:latest"],
          registry: "docker.io",
          source_digest: image,
          resolved_at_unix_seconds: Math.floor(Date.now() / 1000),
          selections: [
            { policy: "native", platform: "linux/arm64", image_id: image },
          ],
        },
      ];
    }
    if (request.args[1] === "ensure-image") {
      confirmed = true;
      return { image_id: image, platform: "linux/arm64" };
    }
    if (request.args[1] === "inspect" && beforeReview) {
      expect(events).toContain("runtime up");
      return observed;
    }
    if (request.args[1] === "restore-selection") {
      return { ...saved, plan: saved.planId, generation: "2".repeat(64) };
    }
    return await invoke(request);
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) => {
    beforeReview = false;
    expect(confirmed).toBe(true);
    expect(
      JSON.parse(request.input.normalizedComposeJson).services.web.image
    ).toBe(image);
    return await review(request);
  };
  expect(await startNativeProject({ ...opts, restore: saved })).toBe(0);
});

test("a parallel build registry refusal keeps its blocker after the sibling settles", async () => {
  const previous = process.env.HACK_NATIVE_BUILDS;
  process.env.HACK_NATIVE_BUILDS = "1";
  try {
    const { opts } = await fixture(false);
    const base = "docker.io/library/python:3.12-alpine";
    const loaded = "docker.io/library/alpine:3.22";
    const prepare = opts.dependencies.prepare!;
    opts.dependencies.prepare = async (request) => ({
      ...(await prepare(request)),
      normalizedComposeJson: JSON.stringify({
        services: {
          web: { build: "." },
          worker: { build: { context: ".", target: "worker" } },
          other: { image: loaded },
        },
      }),
    });
    const siblingStarted = Promise.withResolvers<void>();
    const siblingAborted = Promise.withResolvers<void>();
    const allowSettlement = Promise.withResolvers<void>();
    let starts = 0;
    let siblingSettled = false;
    opts.dependencies.build = async ({ signal }) => {
      starts += 1;
      if (starts === 1) {
        await siblingStarted.promise;
        throw new NativeBuildRegistryError(base, "registry_http_429");
      }
      signal?.addEventListener("abort", () => siblingAborted.resolve(), {
        once: true,
      });
      siblingStarted.resolve();
      await allowSettlement.promise;
      siblingSettled = true;
      throw new Error("sibling canceled");
    };
    const invoke = opts.dependencies.invoke!;
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "up" && request.args[0] === "runtime") {
        await invoke(request);
        return { profile: "development" };
      }
      if (request.args[1] === "image-tag-status") {
        expect(siblingSettled).toBe(true);
        expect(request.args).toEqual([
          "runtime",
          "image-tag-status",
          "--present",
          "--json",
          base,
          loaded,
        ]);
        return [loaded];
      }
      return await invoke(request);
    };
    const result = startNativeProject(opts);
    try {
      const aborted = await Promise.race([
        siblingAborted.promise.then(() => true),
        result.then(() => false),
        Bun.sleep(2000).then(() => false),
      ]);
      expect(aborted).toBe(true);
      expect(starts).toBe(2);
      expect(siblingSettled).toBe(false);
    } finally {
      siblingStarted.resolve();
      allowSettlement.resolve();
    }
    await expect(result).rejects.toThrow(
      `Image unavailable: could not resolve build base ${base} (registry rate limit reached).\nAlready present: ${loaded}.\nRetry hack up when the registry is reachable.`
    );
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_NATIVE_BUILDS");
    } else {
      process.env.HACK_NATIVE_BUILDS = previous;
    }
  }
});

test("retained startup asks the runtime for each build, a restart's resolved images are used as they are, and a rebuild reclaims superseded images (HACK-2533)", async () => {
  const saved = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const retained = `sha256:${"e".repeat(64)}`;
  const rebuilt = `sha256:${"7".repeat(64)}`;
  const previous = process.env.HACK_NATIVE_BUILDS;
  process.env.HACK_NATIVE_BUILDS = "1";
  try {
    for (const [restart, reused] of [
      [false, false],
      [false, true],
      [true, false],
    ] as const) {
      const { opts } = await fixture(false);
      const request = admitNativeProjectBuilds({
        services: { web: { build: "." } },
        projectRoot: opts.scope.projectRoot,
        composeFile: opts.composeFile,
        enabled: true,
      }).get("web");
      if (!request) {
        throw new Error("the fixture's build service was not admitted");
      }
      const verified = restart
        ? new Map([
            [
              "web",
              { imageId: rebuilt, identity: nativeBuildIdentity(request) },
            ],
          ])
        : undefined;
      const stopped = stoppedGraph(saved);
      const observed = {
        ...stopped,
        receipt: {
          ...stopped.receipt,
          normalized_input: {
            namespace: saved.namespace,
            original_compose_sha256: "d".repeat(64),
            normalized_compose_sha256: "f".repeat(64),
          },
          resources: {
            "container:web": {
              ...stopped.receipt.resources["container:web"],
              image: retained,
            },
          },
        },
      };
      opts.dependencies.retainedImages = selectNativeRetainedImages;
      const prepare = opts.dependencies.prepare!;
      opts.dependencies.prepare = async (request) => ({
        ...(await prepare(request)),
        normalizedComposeJson: JSON.stringify({
          services: { web: { build: "." } },
        }),
      });
      let builds = 0;
      opts.dependencies.build = async () => {
        builds += 1;
        return { imageId: rebuilt, buildKey: "c".repeat(64), reused };
      };
      const invoke = opts.dependencies.invoke!;
      let beforeReview = true;
      const reclaims: string[][] = [];
      opts.dependencies.invoke = async (request) => {
        if (request.args[1] === "reclaim-build-images") {
          reclaims.push([...request.args]);
          // A failed reclamation never fails or delays the start.
          throw new Error("reclaim failed");
        }
        if (request.args[1] === "inspect" && beforeReview) {
          return observed;
        }
        if (request.args[1] === "restore-selection") {
          return { ...saved, plan: saved.planId, generation: "2".repeat(64) };
        }
        return await invoke(request);
      };
      const review = opts.dependencies.review!;
      let reviewedImage: unknown;
      opts.dependencies.review = async (request) => {
        beforeReview = false;
        reviewedImage = JSON.parse(request.input.normalizedComposeJson).services
          .web.image;
        return await review(request);
      };
      await startNativeProject({
        ...opts,
        restore: saved,
        verifiedBuildImages: verified,
      });
      // The retained image never stands in for the build: a restore asks the
      // runtime, and a restart's resolved image is pinned without asking again.
      expect(reviewedImage).toBe(rebuilt);
      expect(builds).toBe(verified ? 0 : 1);
      // Only a start that actually built an image reclaims, once it is ready.
      expect(reclaims).toEqual(
        restart || reused
          ? []
          : [["runtime", "reclaim-build-images", "--best-effort", "--json"]]
      );
    }
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_NATIVE_BUILDS");
    } else {
      process.env.HACK_NATIVE_BUILDS = previous;
    }
  }
});

test("retained startup confirms the image under the currently selected emulation policy", async () => {
  const saved = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
  };
  const retained = `sha256:${"e".repeat(64)}`;
  const selected = `sha256:${"9".repeat(64)}`;
  for (const retainedPolicy of ["prefer-native", "amd64"] as const) {
    const { opts } = await fixture(false);
    const stopped = stoppedGraph(saved);
    const observed = {
      ...stopped,
      receipt: {
        ...stopped.receipt,
        normalized_input: {
          namespace: saved.namespace,
          original_compose_sha256: "d".repeat(64),
          normalized_compose_sha256: "f".repeat(64),
        },
        resources: {
          "container:web": {
            ...stopped.receipt.resources["container:web"],
            image: retained,
            amd64_emulation: retainedPolicy,
          },
        },
      },
    };
    opts.dependencies.retainedImages = selectNativeRetainedImages;
    const prepare = opts.dependencies.prepare!;
    // The adaptation now selects `amd64` for web.
    opts.dependencies.prepare = async (request) => ({
      ...(await prepare(request)),
      normalizedComposeJson: JSON.stringify({
        services: {
          web: { image: "redis:latest", "x-hack-amd64-emulation": "amd64" },
        },
      }),
      amd64Emulation: { web: "amd64" },
    });
    const invoke = opts.dependencies.invoke!;
    const ensured: string[][] = [];
    let beforeReview = true;
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "image-tag-status") {
        return [
          {
            reference: "docker.io/library/redis:latest",
            aliases: ["redis:latest"],
            registry: "docker.io",
            source_digest: retained,
            resolved_at_unix_seconds: Math.floor(Date.now() / 1000),
            selections: [
              { policy: "amd64", platform: "linux/amd64", image_id: retained },
            ],
          },
        ];
      }
      if (request.args[1] === "ensure-image") {
        ensured.push([...request.args]);
        return {
          image_id: retainedPolicy === "amd64" ? retained : selected,
          platform: "linux/amd64",
        };
      }
      if (request.args[1] === "inspect" && beforeReview) {
        return observed;
      }
      if (request.args[1] === "restore-selection") {
        return { ...saved, plan: saved.planId, generation: "2".repeat(64) };
      }
      return await invoke(request);
    };
    const review = opts.dependencies.review!;
    let reviewedImage: unknown;
    opts.dependencies.review = async (request) => {
      beforeReview = false;
      reviewedImage = JSON.parse(request.input.normalizedComposeJson).services
        .web.image;
      return await review(request);
    };
    expect(await startNativeProject({ ...opts, restore: saved })).toBe(0);
    const changed = retainedPolicy !== "amd64";
    expect(reviewedImage).toBe(changed ? selected : retained);
    expect(ensured).toEqual([
      [
        "runtime",
        "ensure-image",
        "--reference",
        "redis:latest",
        "--emulation",
        "amd64",
        "--json",
      ],
    ]);
  }
});

test("failed HTTPS intent preserves startup classification when cleanup cannot find the endpoint", async () => {
  const { opts, events } = await httpsFixture();
  let acquireCalls = 0,
    recoveryCalls = 0,
    completed = false;
  opts.dependencies.finalization = async (request) => {
    const lifetime = await beginNativeProjectFinalization(request);
    return {
      ...lifetime,
      complete: async () => {
        completed = true;
      },
    };
  };
  opts.dependencies.https = async (selection) => {
    acquireCalls++;
    const identity = leaseIdentity(selection);
    await selection.onIntent?.(identity);
    throw new NativeHttpsLeaseAcquisitionError(identity, {
      startupFailure: new NativeHttpsStartupError(
        "authority-observation",
        new NativeRuntimeRequestError({
          message: "private startup stderr",
          nativeCode: "provider_busy",
        })
      ),
    });
  };
  opts.dependencies.recoverHttps = async () => {
    recoveryCalls++;
    expect(events.at(-1)).toBe("graph inspect");
    throw Object.assign(new Error("private endpoint path"), { code: "ENOENT" });
  };
  let failure: unknown;
  try {
    await startNativeProject({ ...opts, https: httpsSelection });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(NativeHttpsLeaseAcquisitionError);
  expect(String(failure)).toContain("authority-observation: provider_busy");
  expect(String(failure)).toContain("Native startup cleanup is unconfirmed");
  expect(String(failure)).not.toContain("private");
  expect(acquireCalls).toBe(1);
  expect(recoveryCalls).toBe(1);
  expect(completed).toBe(false);
  expect(events).not.toContain("ready");
});

test("later graph, temporary, hook and acknowledgement failures cannot mask HTTPS acquisition diagnostics", async () => {
  for (const phase of [
    "inspect",
    "graph-cleanup",
    "temporary",
    "hook",
    "recovery-and-hook",
    "acknowledge",
  ] as const) {
    const { opts, events } = await httpsFixture();
    let acquired = false,
      recovered = 0,
      acknowledged = false;
    const invoke = opts.dependencies.invoke;
    opts.dependencies.invoke = async (request) => {
      if (acquired && request.args[1] === "inspect") {
        if (phase === "inspect") {
          throw new Error("private inspect path");
        }
        if (phase === "graph-cleanup") {
          return { receipt: { phase: "cleanup-intent" } };
        }
      }
      return await invoke?.(request);
    };
    opts.dependencies.finalization = async (request) => {
      const lifetime = await beginNativeProjectFinalization(request);
      return {
        ...lifetime,
        complete: async () => {
          if (phase === "acknowledge") {
            throw new Error("private acknowledgement path");
          }
          acknowledged = true;
        },
      };
    };
    opts.dependencies.https = async (selection) => {
      const identity = leaseIdentity(selection);
      await selection.onIntent?.(identity);
      acquired = true;
      throw new NativeHttpsLeaseAcquisitionError(identity, {
        startupFailure: new NativeHttpsStartupError(
          "authority-observation",
          new NativeRuntimeRequestError({
            message: "private start error",
            nativeCode: "provider_busy",
          })
        ),
      });
    };
    opts.dependencies.recoverHttps = async () => {
      recovered++;
      if (phase === "recovery-and-hook") {
        throw new Error("private lease cleanup output");
      }
    };
    if (phase === "temporary") {
      opts.dependencies.cleanupTemporary = async (directory) => {
        await rm(directory, { recursive: true, force: true });
        throw new Error("private temporary path");
      };
    }
    if (phase === "hook" || phase === "recovery-and-hook") {
      const before = opts.before;
      opts.before = async () => {
        const hooks = await before();
        return {
          ...hooks,
          cleanup: async () => {
            await hooks.cleanup();
            throw new Error("private lifecycle output");
          },
        };
      };
    }
    let failure: unknown;
    try {
      await startNativeProject({ ...opts, https: httpsSelection });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(NativeHttpsLeaseAcquisitionError);
    expect(String(failure)).toContain("authority-observation: provider_busy");
    expect(String(failure)).toContain("Native startup cleanup is unconfirmed");
    expect(String(failure)).not.toContain("private");
    expect(recovered).toBe(1);
    // Temporary disposal never determined graph/HTTPS finalization in the original flow.
    expect(acknowledged).toBe(phase === "temporary");
    expect(events).not.toContain("ready");
  }
});

const runtimeMetadata = {
  devHost: "example.com",
  aliasHost: null,
  projectName: "demo",
};
function stubHttpsLease(
  opts: Awaited<ReturnType<typeof httpsFixture>>["opts"]
) {
  opts.dependencies.https = async (selection) => ({
    identity: leaseIdentity(selection),
    caPath: "/synthetic/root.crt",
    httpsPort: 8443,
    exited: new Promise(() => {}),
    verifyHostname: async () => ({ statusCode: 200 }),
    releaseAfterCleanup: async () => {},
  });
}
test("native up reviews runtime host metadata with the HTTPS port and records it", async () => {
  const { opts } = await httpsFixture();
  stubHttpsLease(opts);
  const review = opts.dependencies.review!;
  let reviewed: Record<string, unknown> | undefined;
  opts.dependencies.review = async (request) => {
    reviewed = JSON.parse(request.input.normalizedComposeJson).services.web
      .environment;
    return await review(request);
  };
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async ({ run }) => {
    saved = run;
  };
  expect(
    await startNativeProject({
      ...opts,
      https: httpsSelection,
      runtimeMetadata,
    })
  ).toBe(0);
  expect(reviewed).toMatchObject({
    HACK_BRANCH: "",
    HACK_COMPOSE_PROJECT: "demo",
    HACK_DEV_HOST: "example.com",
    HACK_DEV_URL: "https://example.com:8443",
    HACK_SERVICE_NAME: "web",
    HACK_SERVICE_URL: "https://web.example.com:8443",
    HACK_SERVICE_URLS: JSON.stringify(["https://web.example.com:8443"]),
  });
  expect(JSON.parse(String(reviewed?.HACK_RUNTIME_METADATA))).toEqual({
    version: 1,
    branch: null,
    composeProject: "demo",
    hosts: { dev: "example.com", alias: null },
    services: { web: { urls: ["https://web.example.com:8443"] } },
  });
  expect(saved?.runtimeMetadata).toBe(true);
});
test("runtime host metadata that differs from reviewed routes refuses before serving", async () => {
  const { opts, events } = await httpsFixture();
  stubHttpsLease(opts);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    return {
      ...input,
      normalizedComposeJson: input.normalizedComposeJson.replace(
        "web.example.com",
        "other.example.com"
      ),
    };
  };
  opts.dependencies.serve = async () => {
    events.push("serve");
    return 0;
  };
  await expect(
    startNativeProject({ ...opts, https: httpsSelection, runtimeMetadata })
  ).rejects.toThrow("Native runtime metadata");
  expect(events).not.toContain("serve");
  expect(events).toContain("cleanup");
});
test("startup without a runtime metadata selection leaves the reviewed graph unchanged", async () => {
  const { opts } = await fixture(false);
  const review = opts.dependencies.review!;
  let reviewed = "";
  opts.dependencies.review = async (request) => {
    reviewed = request.input.normalizedComposeJson;
    return await review(request);
  };
  let saved: NativeProjectRun | undefined;
  opts.dependencies.save = async ({ run }) => {
    saved = run;
  };
  expect(await startNativeProject(opts)).toBe(0);
  expect(reviewed).not.toContain("HACK_");
  expect(saved && Object.hasOwn(saved, "runtimeMetadata")).toBe(false);
});
test("restart preflight refuses runtime host metadata that differs from reviewed routes", async () => {
  const { opts } = await httpsFixture();
  const review = opts.dependencies.review!;
  const run: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "c".repeat(32),
    namespace: "b".repeat(64),
    planId: "a".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
    runtimeMetadata: true,
  };
  const preflight = (hostnames: readonly string[]) =>
    preflightNativeRestart({
      runtime: opts.runtime,
      scope: opts.scope,
      composeFile: opts.composeFile,
      runtimeMetadata,
      httpsPort: httpsSelection.httpsPort,
      run,
      dependencies: {
        prepare: opts.dependencies.prepare,
        review: async (request) =>
          await review({
            ...request,
            run: async (checked) =>
              await request.run({
                ...checked,
                report: {
                  plan: {
                    enrollment_compatible: true,
                    services: {
                      web: { active: true, routing: { port: 3000, hostnames } },
                    },
                  },
                },
              }),
          }),
        dependencies: async () => [],
        invoke: restartPreflightInvoke,
      },
    });
  await preflight(["web.example.com"]);
  await expect(preflight(["other.example.com"])).rejects.toThrow(
    "Native runtime metadata"
  );
});

async function internalHostsFixture() {
  const { opts, events } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.worker = { ...compose.services.web };
    compose.services.later = { ...compose.services.web, profiles: ["later"] };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const path = join(opts.scope.projectRoot, "host-selection.json");
  const internalExtraHosts = { "api.example.test": "host-gateway" };
  return { opts, events, path, internalExtraHosts };
}

test("project-wide host aliases are declared like Compose and bound by one declarative selection", async () => {
  const { opts, path, internalExtraHosts } = await internalHostsFixture();
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      dependencies: [
        {
          binding: "api",
          aliases: ["api.example.test"],
          guest_port: 443,
          host_port: 8443,
          host_pid: 123,
        },
      ],
    })
  );
  const reviewed: NativeProjectInput[] = [];
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) => {
    reviewed.push(request.input);
    return await review(request);
  };
  const plans: unknown[] = [];
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "dependency-plan") {
      plans.push(
        JSON.parse(await readFile(String(request.args[3]), "utf8")).dependencies
      );
    }
    return await invoke(request);
  };
  expect(
    await startNativeProject({
      ...opts,
      dependencyFile: path,
      internalExtraHosts,
    })
  ).toBe(0);
  const services = JSON.parse(reviewed[0]?.normalizedComposeJson ?? "{}")
    .services as Record<string, Record<string, unknown>>;
  for (const name of ["web", "worker", "later"]) {
    expect(services[name]?.extra_hosts).toEqual([
      "api.example.test:host-gateway",
    ]);
  }
  // The inactive profile service is declared but never bound.
  const binding = {
    binding: "api",
    slot: 0,
    guest_port: 443,
    host_port: 8443,
    host_pid: 123,
    aliases: ["api.example.test"],
  };
  expect(plans).toEqual([
    [
      { ...binding, service: "web" },
      { ...binding, service: "worker" },
    ],
  ]);
  expect(services.web?.init).toBe(true);
  expect(services.later?.init).toBeUndefined();

  reviewed.length = 0;
  await preflightNativeRestart({
    runtime: opts.runtime,
    scope: opts.scope,
    composeFile: opts.composeFile,
    dependencyFile: path,
    internalExtraHosts,
    run: {
      run: "1".repeat(32),
      owner: "c".repeat(32),
      namespace: "b".repeat(64),
      planId: "a".repeat(64),
      effectiveEnvName: null,
      profiles: [],
      aws: null,
    },
    dependencies: {
      prepare: opts.dependencies.prepare,
      review: opts.dependencies.review,
      invoke: async (request) => {
        if (request.args[1] === "dependency-plan") {
          plans.push(
            JSON.parse(await readFile(String(request.args[3]), "utf8"))
              .dependencies
          );
          return {
            plan_id: "a".repeat(64),
            dependency_plan_id: "f".repeat(64),
          };
        }
        return await restartPreflightInvoke(request);
      },
    },
  });
  expect(reviewed).toHaveLength(1);
  // Restart reviews the same declarations and bindings startup admitted.
  expect(
    JSON.parse(reviewed[0]?.normalizedComposeJson ?? "{}").services
  ).toEqual(services);
  expect(plans[1]).toEqual(plans[0]);
});

test("a project-wide alias without a binding for every active service refuses before runtime effects", async () => {
  const { opts, events, path, internalExtraHosts } =
    await internalHostsFixture();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        {
          service: "web",
          binding: "api",
          aliases: ["api.example.test"],
          guest_port: 443,
          host_port: 8443,
          host_pid: 123,
        },
      ],
    })
  );
  const error = await startNativeProject({
    ...opts,
    dependencyFile: path,
    internalExtraHosts,
    internalExtraHostSources: { "api.example.test": "inherited" },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
  expect(String((error as Error).message)).toContain(
    "Native host alias has no reviewed host dependency binding"
  );
  // HACK-1939: the refusal names the service, the alias and its source.
  expect(String((error as Error).message)).toContain(
    "Unbound: api.example.test for service worker (from the main checkout's .hack/.internal/extra-hosts.json, which this linked worktree inherits)."
  );
  expect(String((error as Error).message)).not.toContain("8443");
  expect(events).toContain("before");
  expect(events).toContain("cleanup");
  expect(events).not.toContain("runtime up");
  expect(events).not.toContain("graph dependency-plan");
});

test("project-wide aliases without a dependency selection refuse before hooks instead of being ignored", async () => {
  const { opts, events, internalExtraHosts } = await internalHostsFixture();
  const error = await startNativeProject({
    ...opts,
    internalExtraHosts,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
  expect(String((error as Error).message)).toContain(
    "configuration was not dropped"
  );
  expect(events).not.toContain("before");
  expect(events).not.toContain("runtime up");
  // Without project-wide aliases the same project still starts unchanged.
  expect(await startNativeProject({ ...opts, internalExtraHosts: {} })).toBe(0);
});

test("HACK-1939: a startup that failed before reserving any runtime state does not report unconfirmed cleanup", async () => {
  const { opts, events } = await fixture();
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.serve = async () => {
    throw new Error(
      "Native graph startup was interrupted or failed (invalid_extra_hosts); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect") {
      events.push("graph inspect");
      throw new NativeRuntimeRequestError({
        message: "Native graph run is not reserved.",
        nativeCode: "graph_unreserved",
      });
    }
    return await invoke(request);
  };
  const error = await startNativeProject(opts).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ClosedCliError);
  expect((error as Error).message).toBe(
    "Native graph startup failed before any runtime state was reserved; nothing was created and no cleanup is needed. Startup diagnostic: Native graph startup was interrupted or failed (invalid_extra_hosts). The native VM pool may still be running; when no other native project uses it, stop it with runtime down --json on this native home."
  );
  expect(events).toContain("graph inspect");
  expect(events).not.toContain("save");
  expect(events.at(-1)).toBe("cleanup");
});

test("an unreserved run after a startup that published a mapping still reports unconfirmed cleanup", async () => {
  const { opts } = await fixture();
  const invoke = opts.dependencies.invoke!;
  const serve = opts.dependencies.serve!;
  let served = false;
  opts.dependencies.serve = async (request) => {
    await serve({
      ...request,
      onReady: async () => {
        await request.onReady();
        served = true;
      },
    });
    throw new Error(
      "Native graph startup was interrupted or failed (runtime_not_running); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (served && request.args[1] === "inspect") {
      throw new NativeRuntimeRequestError({
        message: "Native graph run is not reserved.",
        nativeCode: "graph_unreserved",
      });
    }
    return await invoke(request);
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "cleanup is unconfirmed"
  );
});

test("HACK-1939: foreground up prints a ready summary and a confirmed-stop line", async () => {
  const { opts } = await fixture();
  const events: NativeStartupProgress[] = [];
  const controller = new AbortController();
  expect(
    await startNativeProject({
      ...opts,
      signal: controller.signal,
      onReady: async () => {
        controller.abort();
      },
      onProgress: (event) => {
        events.push(event);
      },
    })
  ).toBe(130);
  const ready = events.find((event) => event.phase === "ready");
  expect(ready).toMatchObject({ phase: "ready", services: ["web"] });
  expect((ready as { run: string }).run).toMatch(/^[a-f0-9]{32}$/);
  expect(events.at(-1)).toEqual({
    phase: "stopped",
    summary:
      "Native project stopped; owned cleanup confirmed. Named volumes and the stopped run mapping are kept for the next hack up.",
  });
});

test("a foreground up stopped by another shell prints confirmed cleanup without a signal", async () => {
  const { opts } = await fixture();
  const events: NativeStartupProgress[] = [];
  expect(
    await startNativeProject({
      ...opts,
      onProgress: (event) => {
        events.push(event);
      },
    })
  ).toBe(0);
  expect(events.at(-1)).toMatchObject({
    phase: "stopped",
    summary: expect.stringContaining("owned cleanup confirmed"),
  });
});

test("the ready summary lists reviewed HTTPS routes and published loopback ports only", () => {
  const plan = {
    services: {
      web: {
        active: true,
        routing: { hostnames: ["app.example.test", "www.example.test"] },
        ports: [
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: 5173 },
        ],
      },
      api: { active: true, routing: { hostnames: ["api.example.test"] } },
      odd: { active: true, routing: { hostnames: ["Not A Host"] } },
      db: {
        active: true,
        ports: [
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: 5432 },
          { protocol: "tcp", proposed_host_ip: "0.0.0.0", published: 6000 },
        ],
      },
    },
  };
  const routed = new Set(["web", "api", "odd"]);
  expect(nativeReadySummary({ plan, routed, httpsPort: 18_443 })).toEqual([
    "  api: https://api.example.test:18443",
    "  web: https://app.example.test:18443 https://www.example.test:18443",
    "  Published ports: 127.0.0.1:5173 127.0.0.1:5432",
  ]);
  expect(nativeReadySummary({ plan, routed, httpsPort: 443 })[0]).toBe(
    "  api: https://api.example.test"
  );
  expect(nativeReadySummary({ plan, routed, httpsPort: null })).toEqual([
    "  Routes are not served on this host: the native HTTPS frontend is not selected (HACK_NATIVE_CADDY_BINARY, HACK_NATIVE_CADDY_SHA256 and HACK_NATIVE_HTTPS_PORT).",
    "  Published ports: 127.0.0.1:5173 127.0.0.1:5432",
  ]);
});

test("the confirmed-stop line reflects whether data was retained", () => {
  expect(nativeStoppedNotice({ receipt: { phase: "removed" } })).toBe(
    "Native project stopped; owned cleanup confirmed and no runtime data was retained."
  );
  expect(
    nativeStoppedNotice({ receipt: { phase: "stopped-data-retained" } })
  ).toContain("Named volumes and the stopped run mapping are kept");
});

test("HACK-1939: a wrapped service whose Compose user cannot be wrapped refuses before the VM starts", async () => {
  const { opts, events } = await fixture();
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.user = "not a user";
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const error = await startNativeProject(opts).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toHaveProperty("code", "E_NATIVE_PROJECT_UNSUPPORTED");
  expect((error as Error).message).toBe(
    "Native up cannot wrap these services' processes; nothing was started. Refused: service web user (use a numeric UID or UID:GID)."
  );
  expect(events).not.toContain("runtime up");
  expect(events.at(-1)).toBe("cleanup");
});

test("HACK-1939: runtime process refusals are named in the nothing-reserved report", async () => {
  const { opts } = await fixture();
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.serve = async (request) => {
    request.onExitDiagnostic?.({
      exitCode: 2,
      nativeCode: "environment_entrypoint",
      processRefusals: [
        { service: "web", field: "entrypoint" },
        { service: "worker", field: "user" },
      ],
    });
    throw new Error(
      "Native graph startup was interrupted or failed (environment_entrypoint); inspect owned state before retrying."
    );
  };
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "inspect") {
      throw new NativeRuntimeRequestError({
        message: "Native graph run is not reserved.",
        nativeCode: "graph_unreserved",
      });
    }
    return await invoke(request);
  };
  const error = await startNativeProject(opts).catch(
    (caught: unknown) => caught
  );
  expect((error as Error).message).toBe(
    "Native graph startup failed before any runtime state was reserved; nothing was created and no cleanup is needed. Startup diagnostic: Native graph startup was interrupted or failed (environment_entrypoint). Native cannot wrap these services' processes: service web entrypoint or command (the process must name an executable); service worker user (use a numeric UID or UID:GID). The native VM pool may still be running; when no other native project uses it, stop it with runtime down --json on this native home."
  );
});

/** A fixture whose inactive-by-default `optional` service cannot be wrapped. */
async function optionalProfileFixture() {
  const fixtureResult = await fixture();
  const prepare = fixtureResult.opts.dependencies.prepare!;
  fixtureResult.opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.optional = {
      image: `sha256:${"e".repeat(64)}`,
      user: "not a user",
      profiles: ["extra"],
    };
    return {
      ...input,
      normalizedComposeJson: JSON.stringify(compose),
      managedEnvironment: {
        ...input.managedEnvironment,
        optional: { PASSWORD: "synthetic-secret" },
      },
      serviceNames: [...input.serviceNames, "optional"],
    };
  };
  return fixtureResult;
}

test("an inactive-profile service a wrapper cannot run does not block up; an active one does", async () => {
  const inactive = await optionalProfileFixture();
  expect(await startNativeProject(inactive.opts)).toBe(0);
  const active = await optionalProfileFixture();
  const error = await startNativeProject({
    ...active.opts,
    profiles: ["extra"],
  }).catch((caught: unknown) => caught);
  expect((error as Error).message).toBe(
    "Native up cannot wrap these services' processes; nothing was started. Refused: service optional user (use a numeric UID or UID:GID)."
  );
  expect(active.events).not.toContain("runtime up");
});

test("restart preflight ignores inactive-profile services a wrapper cannot run", async () => {
  const { opts } = await optionalProfileFixture();
  const preflight = (profiles: string[]) =>
    preflightNativeRestart({
      runtime: opts.runtime,
      scope: opts.scope,
      composeFile: opts.composeFile,
      run: {
        run: "1".repeat(32),
        owner: "c".repeat(32),
        namespace: "b".repeat(64),
        planId: "a".repeat(64),
        effectiveEnvName: null,
        profiles,
        aws: null,
      },
      dependencies: {
        prepare: opts.dependencies.prepare,
        review: opts.dependencies.review,
        dependencies: async () => [],
        invoke: restartPreflightInvoke,
      },
    });
  const refusal = await preflight(["extra"]).catch((caught: unknown) => caught);
  expect((refusal as Error).message).toContain(
    "Refused: service optional user (use a numeric UID or UID:GID)."
  );
  // The same preflight without the profile completes.
  await preflight([]);
});

test.each([
  "commit",
  "fail",
  "cancel",
] as const)("detached readiness waits for down-hook bookkeeping: %s", async (mode) => {
  const { opts } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const progress: string[] = [];
  let published = 0;
  const before = opts.before;
  const pending = startNativeProject({
    ...opts,
    signal: controller.signal,
    before: async () => ({
      ...(await before()),
      stop: { before: async () => 0, after: async () => 0 },
    }),
    dependencies: {
      ...opts.dependencies,
      downHooks: () => ({
        owe: async () => {
          entered.resolve();
          await release.promise;
          if (mode === "fail") {
            throw new Error("synthetic bookkeeping failure");
          }
          if (mode === "cancel") {
            controller.abort();
          }
        },
        before: async () => "skipped" as const,
        after: async () => "skipped" as const,
      }),
    },
    onReady: () => {
      published += 1;
    },
    onProgress: (event) => {
      progress.push(event.phase);
    },
  }).then(
    (code) => ({ ok: true as const, code }),
    () => ({ ok: false as const })
  );
  try {
    await entered.promise;
    // The actual startup owner is suspended at its durable journal boundary.
    // Neither IPC observation nor human readiness can escape that boundary.
    await Bun.sleep(20);
    expect(published).toBe(0);
    expect(progress).not.toContain("ready");
    release.resolve();
    const outcome = await pending;
    if (mode === "commit") {
      expect(outcome).toEqual({ ok: true, code: 0 });
      expect(published).toBe(1);
      expect(progress).toContain("ready");
    } else {
      expect(
        mode === "fail" ? !outcome.ok : outcome.ok && outcome.code === 130
      ).toBe(true);
      expect(published).toBe(0);
      expect(progress).not.toContain("ready");
    }
  } finally {
    release.resolve();
    await pending;
  }
});

test("startup and ready progress list only reviewed active services", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.extra = { ...compose.services.web, profiles: ["extra"] };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) =>
    review({
      ...request,
      run: (result) =>
        request.run({
          ...result,
          report: {
            plan: {
              enrollment_compatible: true,
              services: {
                web: { active: true },
                extra: { active: false },
              },
            },
          },
        }),
    });
  const lists: (readonly string[])[] = [];
  await startNativeProject({
    ...opts,
    onProgress: (event) => {
      if (event.phase === "services" || event.phase === "ready") {
        lists.push(event.services);
      }
    },
  });
  expect(lists).toEqual([["web"], ["web"]]);
});

test("ps reports pending during input preparation before any run mapping exists", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const result = await nativeProjectPs({
      ...opts,
      invoke: async () => {
        throw new Error("no runtime inspection before a mapping exists");
      },
    });
    expect(result.status).toBe("pending");
    expect(result.items).toEqual([]);
    return await prepare(request);
  };
  await startNativeProject(opts);
  expect((await nativeProjectPs(opts)).status).toBe("not_started");
});

test("invalid HTTP retries name the service and field before hooks or runtime effects", async () => {
  const { opts, events } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services.web.healthcheck = {
      "x-hack-http": {
        port: 3000,
        path: "/",
        interval_ms: 100,
        timeout_ms: 500,
        retries: 120,
        start_period_ms: 0,
      },
    };
    return { ...input, normalizedComposeJson: JSON.stringify(compose) };
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    "service web field healthcheck.x-hack-http.retries"
  );
  expect(events).not.toContain("before");
  expect(events).not.toContain("runtime up");
  expect(events).not.toContain("runtime ensure-image");
});

test("a missing shared tag names the requested image and every affected active service", async () => {
  const { opts } = await fixture(false);
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => {
    const input = await prepare(request);
    return {
      ...input,
      normalizedComposeJson: JSON.stringify({
        services: {
          web: { image: "synthetic:missing" },
          worker: { image: "docker.io/library/synthetic:missing" },
          inactive: { image: "synthetic:missing", profiles: ["jobs"] },
          unrelated: { image: "another:latest" },
        },
      }),
    };
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (
      request.args[1] === "admit-image" &&
      request.args[3] === "synthetic:missing"
    ) {
      return {
        reference: "docker.io/library/synthetic:missing",
        kind: "docker_hub",
      };
    }
    if (request.args[1] === "ensure-image") {
      if (request.args[3] === "another:latest") {
        return { image_id: `sha256:${"f".repeat(64)}` };
      }
      throw new NativeRuntimeRequestError({
        nativeCode: "registry_image_not_found",
        message: "private registry detail",
      });
    }
    return await invoke(request);
  };
  const error = await startNativeProject(opts).catch(
    (failure: unknown) => failure
  );
  expect((error as Error).message).toContain(
    "services web, worker field image (registry_image_not_found)"
  );
  expect((error as Error).message).not.toContain("inactive");
  expect((error as Error).message).not.toContain("unrelated");
  expect((error as Error).message).toContain("synthetic:missing");
  expect((error as Error).message).not.toContain("private registry detail");
});

test("wrong pinned host port names the binding before VM boot", async () => {
  const { opts, events } = await fixture(false);
  const path = join(opts.scope.projectRoot, "selection.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      dependencies: [
        {
          service: "web",
          binding: "api",
          guest_port: 443,
          aliases: ["api.example.test"],
          host_pid: 12_345,
          host_port: 8443,
        },
      ],
    })
  );
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "dependency-check") {
      throw new NativeRuntimeRequestError({
        nativeCode: "host_endpoint_identity",
        message: "private detail",
      });
    }
    return await invoke(request);
  };
  await expect(
    startNativeProject({ ...opts, dependencyFile: path })
  ).rejects.toThrow(
    "binding api, aliases api.example.test, guest port 443, host port 8443"
  );
  expect(events).not.toContain("runtime up");
  expect(events).not.toContain("runtime ensure-image");
});

test("an exited frontend marker does not survive a later completed start as pending", async () => {
  const { opts } = await fixture(false);
  const modulePath = new URL(
    "../src/backends/native-project-run.ts",
    import.meta.url
  ).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const { beginNativeProjectStartupObservation } = await import(${JSON.stringify(modulePath)});
    await beginNativeProjectStartupObservation(JSON.parse(process.env.HACK_TEST_SCOPE));
    // Exit without the returned finalizer, as a terminated frontend would.
  `,
    ],
    {
      env: { HACK_TEST_SCOPE: JSON.stringify(opts.scope) },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }
  );
  expect(await child.exited).toBe(0);
  expect((await nativeProjectPs(opts)).status).toBe("not_started");
  await startNativeProject(opts);
  expect((await nativeProjectPs(opts)).status).toBe("not_started");
});

test("invalid startup arguments refuse before creating advisory storage", async () => {
  const { opts } = await fixture(false);
  await expect(
    startNativeProject({ ...opts, allowedHosts: ["bad host"] })
  ).rejects.toThrow();
  expect(await readdir(opts.scope.projectDir)).toEqual([]);
});

test("restart --recover-frontend starts a fresh lifetime that plain down can stop", async () => {
  const { opts, saved } = await retainedFinalizationFixture();
  await saveNativeProjectRun({ ...opts.scope, run: saved });
  const module = join(
    import.meta.dir,
    "../src/backends/native-project-finalization.ts"
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const {beginNativeProjectFinalization} = await import(${JSON.stringify(module)});
     await beginNativeProjectFinalization(JSON.parse(process.argv[1]));`,
      JSON.stringify({ scope: opts.scope, run: saved }),
    ],
    {
      env: privateCliEnv({ root: opts.scope.projectRoot }),
      stdout: "ignore",
      stderr: "pipe",
    }
  );
  expect(await child.exited).toBe(0);
  const token = await captureNativeProjectFinalization({
    scope: opts.scope,
    run: saved,
  });
  const stop = Promise.withResolvers<void>();
  let cleaned = false;
  let down: Promise<unknown> | undefined;
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) =>
    await serve({
      ...request,
      onReady: async () => {
        await request.onReady();
        down = nativeProjectDown({
          runtime: opts.runtime,
          scope: opts.scope,
          invoke: async (input) => {
            if (input.args[1] === "cleanup") {
              cleaned = true;
              stop.resolve();
              return {};
            }
            return {
              ...stoppedGraph(saved),
              receipt: {
                ...stoppedGraph(saved).receipt,
                phase: cleaned ? "stopped-data-retained" : "ready-observed",
              },
              observations: {
                "container:web": { state: cleaned ? "absent" : "running" },
              },
            };
          },
        });
        await stop.promise;
      },
    });
  opts.dependencies.save = saveNativeProjectRun;
  const result = await restartNativeProject({
    scope: opts.scope,
    preflight: async () => {},
    down: async () =>
      await nativeProjectDown({
        runtime: opts.runtime,
        scope: opts.scope,
        deferFinalization: true,
        invoke: async () => stoppedGraph(saved),
      }),
    recovery: {
      expectAttempt: token.attempt,
      verifyEffects: async () =>
        await verifyNativeFrontendRecovery({
          runtime: opts.runtime,
          scope: opts.scope,
          run: saved,
          legacy: false,
          httpsPort: null,
          invoke: async (request) =>
            request.args[1] === "managed-hostname-authority"
              ? { authority: { present: false } }
              : stoppedGraph(saved),
        }),
      retirePublisher: async () => {},
    },
    start: async (input) =>
      await startNativeProject({
        ...opts,
        restore: input.run,
        signal: input.signal,
        onReady: input.onReady,
        onStopSignals: input.onStopSignals,
        onProgress: (event) => {
          if (event.phase === "stopping") {
            input.onStopRequested();
          }
        },
      }),
  });
  expect(result).toBe(0);
  expect(await down).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(cleaned).toBe(true);
});

test("shell values reach private stdin but never startup observations, saved receipts or native-home files", async () => {
  const { opts } = await fixture();
  const privateValue = "synthetic-secret-shell-delivery-canary";
  const prepare = opts.dependencies.prepare!;
  opts.dependencies.prepare = async (request) => ({
    ...(await prepare(request)),
    shellEnvironment: { web: { API_KEY: privateValue } },
    forwardedShellVariables: {
      web: ["FIXTURE_API_KEY", "FIXTURE_API_KEY"],
      inactive: ["INACTIVE_SOURCE"],
    },
  });
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  const save = opts.dependencies.save!;
  opts.dependencies.save = async (request) => {
    expect(JSON.stringify(request)).not.toContain(privateValue);
    return await save(request);
  };
  const review = opts.dependencies.review!;
  opts.dependencies.review = async (request) => {
    expect(request.input.normalizedComposeJson).not.toContain(privateValue);
    return await review(request);
  };
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    expect(JSON.stringify(request)).not.toContain(privateValue);
    return await invoke(request);
  };
  let received = false;
  const serve = opts.dependencies.serve!;
  opts.dependencies.serve = async (request) => {
    expect(request.args.join(" ")).not.toContain(privateValue);
    expect(
      JSON.parse(new TextDecoder().decode(request.privateInput))
    ).toMatchObject({ services: { web: { API_KEY: privateValue } } });
    received = true;
    return await serve(request);
  };
  expect(
    await startNativeProject({
      ...opts,
      onEnvironmentReady: async (request) => {
        expect(JSON.stringify(request)).not.toContain(privateValue);
      },
      onProgress: (event) => {
        expect(JSON.stringify(event)).not.toContain(privateValue);
      },
    })
  ).toBe(0);
  expect(received).toBe(true);
  expect(notices).toContain("Forwarding shell variables: FIXTURE_API_KEY.");
  expect(
    notices.filter((line) => line.startsWith("Forwarding shell variables:"))
  ).toHaveLength(1);
  expect(notices.join("\n")).not.toContain(privateValue);
  expect(notices.join("\n")).not.toContain("INACTIVE_SOURCE");
  const pending = [opts.scope.nativeHome];
  for (const directory of pending) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        expect(await readFile(path, "utf8")).not.toContain(privateValue);
      }
    }
  }
});

test("startup cleanup retains only safe runtime detail, never original errors or inspection text", async () => {
  for (const unreserved of [true, false]) {
    const { opts } = await fixture();
    const invoke = opts.dependencies.invoke!;
    opts.dependencies.serve = async () => {
      throw new NativeRuntimeRequestError({
        message: "synthetic-private-original",
        nativeCode: "graph_port_publication",
        nativeMessage:
          "Native publishes only TCP ports; keep UDP publication on the Compose backend.",
        nativeService: "web",
      });
    };
    opts.dependencies.invoke = async (request) => {
      if (request.args[1] === "inspect") {
        if (unreserved) {
          throw new NativeRuntimeRequestError({
            message: "synthetic-private-inspection",
            nativeCode: "graph_unreserved",
          });
        }
        throw new Error("synthetic-private-inspection");
      }
      return invoke(request);
    };
    const failure = await startNativeProject(opts).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ClosedCliError);
    expect((failure as Error).cause).toBeUndefined();
    expect(Bun.inspect(failure) + JSON.stringify(failure)).not.toContain(
      "synthetic-private"
    );
    expect(nativeRuntimeFailure(failure)).toEqual({
      code: "graph_port_publication",
      service: "web",
      message:
        "Native publishes only TCP ports; keep UDP publication on the Compose backend.",
    });
  }
});

for (const [name, hotReload, expected] of [
  [
    "off for a large share",
    { state: "off", reason: "large_share", limit: 100_000, message: "ignored" },
    { state: "off", reason: "large_share", limit: 100_000 },
  ],
  [
    "forced on",
    { state: "on", reason: "setting", limit: 100_000 },
    { state: "on", reason: "setting", limit: 100_000 },
  ],
  ["the plain default", { state: "on" }, null],
] as const) {
  test(`HACK-2409: a foreground start prints the hot-reload notice once (${name})`, async () => {
    const { opts } = await fixture();
    const invoke = opts.dependencies.invoke!;
    let ups = 0;
    opts.dependencies.invoke = async (call) => {
      const result = await invoke(call);
      if (call.args[0] === "runtime" && call.args[1] === "up") {
        ups += 1;
        return {
          ...(result as Record<string, unknown>),
          hot_reload: hotReload,
        };
      }
      return result;
    };
    const notices: string[] = [];
    opts.dependencies.warn = (line) => notices.push(line);
    expect(await startNativeProject(opts)).toBe(0);
    expect(ups).toBe(1);
    expect(
      notices.filter((line) => line.startsWith("Hot reload on shared source"))
    ).toEqual(expected ? [renderNativeHotReloadNotice(expected)] : []);
  });
}

// HACK-2456: the pool stopped under the run while its foreground owner died.
function ownerExitedRefusal() {
  return new NativeRuntimeRequestError({
    nativeCode: "graph_foreground_owner_exited",
    message: "The run's foreground owner exited.",
  });
}
async function stoppedPoolUnderRunFixture(
  poolPhase: "stopped" | "running",
  routed = false
) {
  const { opts, events } = await retainedFinalizationFixture();
  if (routed) {
    configureHttpsFixture(opts);
  }
  const saved = await opts.dependencies.load!(opts.scope);
  await acknowledgeRetainedFrontend(opts.scope, saved!);
  let recovered = false;
  const invoke = opts.dependencies.invoke!;
  opts.dependencies.invoke = async (request) => {
    if (request.args[1] === "retained-preflight" && !recovered) {
      events.push("graph retained-preflight refused");
      throw ownerExitedRefusal();
    }
    if (request.args[0] === "runtime" && request.args[1] === "status") {
      events.push("runtime status");
      return poolPhase === "running"
        ? { phase: "running", process_alive: true }
        : { phase: "stopped", process_alive: false };
    }
    return await invoke(request);
  };
  const notices: string[] = [];
  opts.dependencies.warn = (line) => notices.push(line);
  const start = {
    ...opts,
    recoverStoppedPool: async () => {
      events.push("down --recover");
      recovered = true;
    },
  };
  return { start, events, notices };
}

test("up on a stopped pool whose run's owner died recovers the run with data retained, then starts it", async () => {
  const { start, events, notices } =
    await stoppedPoolUnderRunFixture("stopped");
  expect(await startNativeProject(start)).toBe(0);
  expect(events.slice(0, 5)).toEqual([
    "graph retained-preflight refused",
    "runtime status",
    "down --recover",
    "graph retained-preflight",
    "graph inspect",
  ]);
  expect(events.filter((event) => event === "down --recover")).toHaveLength(1);
  expect(events.indexOf("down --recover")).toBeLessThan(
    events.indexOf("runtime up")
  );
  expect(events).toContain("save");
  expect(notices.join("\n")).toContain("recovered with data retained");
});

// HACK-2579: the pool's provider was killed; its record still says running, and
// the run's detached owner has not noticed yet.
test("up on a pool whose provider exited under a running record recovers it with one line, then recovers the run", async () => {
  const { start, events, notices } =
    await stoppedPoolUnderRunFixture("stopped");
  let runtimeRecovered = false;
  let refusedOnce = false;
  const invoke = start.dependencies.invoke!;
  start.dependencies.invoke = async (request) => {
    if (request.args[1] === "retained-preflight" && !refusedOnce) {
      refusedOnce = true;
      events.push("graph retained-preflight owner running");
      throw new NativeRuntimeRequestError({
        nativeCode: "graph_foreground_owner_running",
        message: "Another hack up of this run is still running.",
      });
    }
    if (request.args[0] === "runtime" && request.args[1] === "recover") {
      events.push("runtime recover");
      runtimeRecovered = true;
      return { phase: "recovered-unclean", process_alive: false };
    }
    if (
      request.args[0] === "runtime" &&
      request.args[1] === "status" &&
      !runtimeRecovered
    ) {
      events.push("runtime status exited");
      return { phase: "process-exited", process_alive: false };
    }
    return await invoke(request);
  };
  expect(await startNativeProject(start)).toBe(0);
  expect(events.slice(0, 4)).toEqual([
    "graph retained-preflight owner running",
    "runtime status exited",
    "runtime recover",
    "graph retained-preflight refused",
  ]);
  expect(events.filter((event) => event === "runtime recover")).toHaveLength(1);
  expect(events.filter((event) => event === "down --recover")).toHaveLength(1);
  expect(
    notices.filter((line) => line === NATIVE_EXITED_RUNTIME_NOTICE)
  ).toHaveLength(1);
});

test.each([
  { routed: true },
  { routed: false },
])("detached recovery only retires after its own provider exits (routed: $routed)", async ({
  routed,
}) => {
  const { start } = await stoppedPoolUnderRunFixture("stopped", routed);
  const previousBoot = "12345678-1234-1234-1234-123456789abc";
  const boot = "87654321-4321-4321-4321-cba987654321";
  const token = "c".repeat(32);
  const oldPid = 1234;
  const newPid = 2345;
  let pid = oldPid;
  let newProviderGone = false;
  let exits = 0;
  let leases = 0;
  let serveArgs: readonly string[] | undefined;
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<void>();
  start.dependencies.watchPool = (options) =>
    watchNativeStartPool({
      ...options,
      checkMs: 5,
      graceMs: () =>
        typeof options.graceMs === "function" && options.graceMs() === 0
          ? 0
          : 100,
      read: async () => ({
        phase: "running",
        token,
        guest_boot_id: pid === oldPid ? previousBoot : boot,
        process: { pid },
      }),
      gone: (candidate) => candidate === oldPid || newProviderGone,
    });
  const invoke = start.dependencies.invoke!;
  start.dependencies.invoke = async (request) => {
    if (request.args[0] === "runtime" && request.args[1] === "up") {
      pid = newPid;
      return { phase: "running", process_alive: true, guest_boot_id: boot };
    }
    if (
      request.args[0] === "runtime" &&
      request.args[1] === "status" &&
      pid === newPid
    ) {
      return { phase: "running", process_alive: true, guest_boot_id: boot };
    }
    return await invoke(request);
  };
  start.dependencies.https = async (selection) => {
    expect(selection.pool.bootId).toBe(boot);
    leases++;
    return {
      identity: leaseIdentity(selection),
      caPath: "/synthetic/ca",
      httpsPort: selection.httpsPort,
      exited: new Promise(() => {}),
      verifyHostname: async () => ({ statusCode: 200 }),
      releaseAfterCleanup: async () => {},
    };
  };
  const serve = start.dependencies.serve!;
  start.dependencies.serve = async (request) => {
    serveArgs = request.args;
    return await serve({
      ...request,
      onReady: async () => {
        await request.onReady();
        ready.resolve();
        await stopped.promise;
      },
    });
  };
  const attempt = startNativeProject({
    ...start,
    ...(routed ? { https: httpsSelection } : {}),
    watchPool: true,
    exitOnPoolEnd: () => {
      exits++;
      exit.resolve();
    },
    recoverStoppedPool: async () => {
      // Let an eager watch observe the exited provider before the VM is replaced.
      await Bun.sleep(25);
      await start.recoverStoppedPool();
    },
  });
  try {
    await Promise.race([ready.promise, attempt]);
    expect(leases).toBe(routed ? 1 : 0);
    await Bun.sleep(150);
    expect(exits).toBe(0);
    const bootArg = serveArgs?.indexOf("--expect-boot") ?? -1;
    expect(bootArg).toBeGreaterThanOrEqual(0);
    expect(serveArgs?.[bootArg + 1]).toBe(boot);
    newProviderGone = true;
    await Promise.race([exit.promise, Bun.sleep(250)]);
    expect(exits).toBe(1);
  } finally {
    stopped.resolve();
    await attempt;
  }
});

test("up keeps the owner-exited refusal on a running pool without recovery or runtime up", async () => {
  const { start, events } = await stoppedPoolUnderRunFixture("running");
  const error = await startNativeProject(start).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(NativeRuntimeRequestError);
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "graph_foreground_owner_exited"
  );
  expect(events).toEqual([
    "graph retained-preflight refused",
    "runtime status",
  ]);
});

test("up without a recovery callback keeps the owner-exited refusal and reads no status", async () => {
  const { start, events } = await stoppedPoolUnderRunFixture("stopped");
  const { recoverStoppedPool: _omitted, ...plain } = start;
  await expect(startNativeProject(plain)).rejects.toBeInstanceOf(
    NativeRuntimeRequestError
  );
  expect(events).toEqual(["graph retained-preflight refused"]);
});

// HACK-2572: right after the pool stopped, the run's detached owner is still exiting.
function ownerRunningRefusal() {
  return new NativeRuntimeRequestError({
    nativeCode: "graph_foreground_owner_running",
    message: "Another foreground hack up still owns this run.",
  });
}
async function exitingOwnerFixture(opts: {
  readonly runningRefusals: number;
  readonly poolEnded: boolean;
  readonly waitMs?: number;
}) {
  const fixture = await stoppedPoolUnderRunFixture("stopped");
  const { start, events } = fixture;
  let refusals = 0;
  const invoke = start.dependencies.invoke!;
  start.dependencies.invoke = async (request) => {
    if (
      request.args[1] === "retained-preflight" &&
      refusals < opts.runningRefusals
    ) {
      refusals += 1;
      events.push("graph retained-preflight owner running");
      throw ownerRunningRefusal();
    }
    return await invoke(request);
  };
  start.dependencies.poolBootEnded = async () => {
    events.push("pool record");
    return opts.poolEnded;
  };
  start.dependencies.endedBootOwnerWaitMs = opts.waitMs ?? 5000;
  return fixture;
}

test("up waits, with one line, for the owner of an ended pool boot to go, then recovers the run", async () => {
  const { start, events, notices } = await exitingOwnerFixture({
    runningRefusals: 3,
    poolEnded: true,
  });
  expect(await startNativeProject(start)).toBe(0);
  expect(
    events.filter((event) => event === "graph retained-preflight owner running")
  ).toHaveLength(3);
  // Then the refusal is the exited owner's, and the existing recovery runs once.
  expect(events.filter((event) => event === "down --recover")).toHaveLength(1);
  expect(
    notices.filter((line) => line === NATIVE_ENDED_BOOT_OWNER_NOTICE)
  ).toHaveLength(1);
});

// HACK-2572: the owner's end seen by the preflight, point by point: alive, then
// ending (exited but not yet reaped, or its publication read mid-change), then
// exited. Every sequence must reach the same recovery, never a refusal to retry.
function endingOwnerRefusal() {
  return new NativeRuntimeRequestError({
    nativeCode: "graph_foreground_owner_uncertain",
    message: "The previous foreground owner of this run is ending.",
  });
}
async function endingOwnerFixture(
  sequence: readonly ("running" | "uncertain")[],
  recover = true
) {
  const fixture = await stoppedPoolUnderRunFixture("stopped");
  const { start, events } = fixture;
  let index = 0;
  const invoke = start.dependencies.invoke!;
  start.dependencies.invoke = async (request) => {
    if (request.args[1] === "retained-preflight" && index < sequence.length) {
      const point = sequence[index]!;
      index += 1;
      events.push(`graph retained-preflight owner ${point}`);
      throw point === "running" ? ownerRunningRefusal() : endingOwnerRefusal();
    }
    return await invoke(request);
  };
  start.dependencies.poolBootEnded = async () => true;
  start.dependencies.endedBootOwnerWaitMs = 5000;
  if (!recover) {
    const { recoverStoppedPool: _omitted, ...plain } = start;
    return { ...fixture, start: plain };
  }
  return fixture;
}

for (const sequence of [
  ["running", "uncertain", "uncertain"],
  ["uncertain"],
  ["running", "uncertain", "running", "uncertain"],
] as const) {
  test(`up through the owner's end (${sequence.join(", ")}, exited) waits with one line, then recovers once`, async () => {
    const { start, events, notices } = await endingOwnerFixture(sequence);
    expect(await startNativeProject(start)).toBe(0);
    expect(events.filter((event) => event === "down --recover")).toHaveLength(
      1
    );
    // One line when it actually waited: an owner already exited at the first
    // re-read is not waited for.
    expect(
      notices.filter((line) => line === NATIVE_ENDED_BOOT_OWNER_NOTICE)
    ).toHaveLength(sequence.length > 1 ? 1 : 0);
  });
}

test("restart through the owner's end waits with one line, then keeps its own exited refusal as before", async () => {
  // Restart passes no stopped-pool recovery: after the wait it decides as today.
  const { start, events, notices } = await endingOwnerFixture(
    ["running", "uncertain"],
    false
  );
  const error = await startNativeProject(start).catch(
    (caught: unknown) => caught
  );
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "graph_foreground_owner_exited"
  );
  expect(events).not.toContain("down --recover");
  expect(notices).toEqual([NATIVE_ENDED_BOOT_OWNER_NOTICE]);
});

test("a live foreground owner on a running pool keeps its refusal at once, with no wait or line", async () => {
  const { start, events, notices } = await exitingOwnerFixture({
    runningRefusals: Number.POSITIVE_INFINITY,
    poolEnded: false,
  });
  const error = await startNativeProject(start).catch(
    (caught: unknown) => caught
  );
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "graph_foreground_owner_running"
  );
  expect(events).toEqual([
    "graph retained-preflight owner running",
    "runtime status",
    "pool record",
  ]);
  expect(notices).toEqual([]);
});

test("an owner that outlives the bound keeps the owner-running refusal after the one line", async () => {
  const { start, events, notices } = await exitingOwnerFixture({
    runningRefusals: Number.POSITIVE_INFINITY,
    poolEnded: true,
    waitMs: 50,
  });
  const error = await startNativeProject(start).catch(
    (caught: unknown) => caught
  );
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "graph_foreground_owner_running"
  );
  expect(events).not.toContain("down --recover");
  expect(notices).toEqual([NATIVE_ENDED_BOOT_OWNER_NOTICE]);
});

test.each([
  [
    "Provider lease acquisition refused; recorded holder: retained startup check; no operation was admitted.",
    "retained startup check",
  ],
  [undefined, "unavailable"],
])("a bounded startup lock refusal reports holder %s and tells the user how to retry", async (nativeMessage, holder) => {
  const { opts, events } = await fixture();
  const blocker = new NativeRuntimeRequestError({
    message: "Native runtime request failed (provider_busy).",
    nativeCode: "provider_busy",
    nativeMessage,
  });
  opts.dependencies.invoke = async () => {
    throw blocker;
  };
  await expect(startNativeProject(opts)).rejects.toThrow(
    [
      "Native startup could not acquire a runtime lock (provider_busy).",
      `Holder: ${holder}.`,
      "Run hack up again after the holder finishes.",
    ].join("\n")
  );
  expect(events).toEqual([]);
});

test("the started envelope comes from observations: running jobs and unmet health goals are warming", () => {
  const args = [
    "--ready",
    "web=started",
    "--ready",
    "db=healthy",
    "--ready",
    "migrate=completed",
    "--ready",
    "seed=completed",
  ];
  expect(
    startedServiceSummary(args, {
      observations: {
        "container:web": { state: "running", health: "none" },
        "container:db": { state: "running", health: "starting" },
        "container:migrate": { state: "running", health: "none" },
        "container:seed": { state: "exited", code: 0 },
      },
    })
  ).toEqual({
    started: ["web"],
    completed: ["seed"],
    warming: ["db", "migrate"],
  });
  // Nothing observed: nothing claimed done.
  expect(startedServiceSummary(args, {})).toEqual({
    started: ["web"],
    completed: [],
    warming: ["db", "migrate", "seed"],
  });
});
