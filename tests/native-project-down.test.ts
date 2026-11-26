import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_LOST_REMOVAL_NOTE,
  NATIVE_LOST_REMOVAL_UNREPAIRABLE,
  NATIVE_OWNER_EXIT_NOTICE,
  NATIVE_RECOVERED_RESTART_NOTE,
  NATIVE_RESTART_INTENT_UNREADABLE_NOTE,
  NATIVE_RESTART_KEPT_UNCONFIRMED_NOTE,
  nativeDownEnvironment,
  nativeProjectDown,
  nativeRestartLockHeldNote,
} from "../src/backends/native-project-down.ts";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
  orphanNativeProjectLifetime,
  waitNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import {
  completeNativeRestartCleanup,
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  type NativeRestartIntent,
  nativeRestartOperationLock,
  removeNativeProjectRun,
  retireCleanedNativeRestart,
  saveNativeProjectRun,
  saveNativeRestartIntent,
  withNativeRestartLock,
} from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  markSharedHelperInstanceStopping,
  type ProjectSharedHelperConfig,
} from "../src/lib/project-shared-helpers.ts";
import oldReceipt from "./fixtures/native-next13/ready-pending.json";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";
import { installNext13Frontend } from "./helpers/native-next13-state.ts";
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
function snapshot(stopped = false) {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: stopped ? "stopped-data-retained" : "ready-observed",
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
    observations: {
      "container:web": {
        state: stopped ? "absent" : "running",
        health: "healthy",
      },
    },
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
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  if (saved) {
    await saveNativeProjectRun({ ...scope, run });
  }
  const finalization = await beginNativeProjectFinalization({ scope, run });
  await finalization.complete();
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}

/** A fixture root for the CLI's private HOME, beside the project checkout. */
async function clientRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-client-"))
  );
  roots.push(root);
  return root;
}

function finalizationRoot(scope: NativeProjectRunScope): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        home: scope.nativeHome,
        projectRoot: scope.projectRoot,
        projectDir: scope.projectDir,
        branch: scope.branch,
      })
    )
    .digest("hex");
  return join(
    scope.nativeHome,
    ".hack-local",
    "frontend-finalization",
    hash,
    run.run
  );
}

test("down waits for the captured frontend after cleanup and lifecycle retirement", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  const hooksFinished = Promise.withResolvers<void>();
  const calls: string[] = [];
  let cleaned = false;
  let stopped = false;
  const result = nativeProjectDown({
    ...opts,
    retireHostProcesses: async () => {
      calls.push("retire-host");
    },
    after: async () => {
      calls.push("after");
      hooksFinished.resolve();
    },
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  }).then((value) => {
    stopped = true;
    return value;
  });
  await hooksFinished.promise;
  await Bun.sleep(20);
  expect(stopped).toBe(false);
  expect(calls).toEqual([
    "inspect",
    "inspect",
    "cleanup",
    "inspect",
    "retire-host",
    "after",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  await lifetime.complete();
  expect((await result).status).toBe("stopped");
  expect(stopped).toBe(true);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down follows the HTTPS lease a started return adds to its lifetime during the stop (HACK-2707)", async () => {
  // `hack down` right after `up -d`: the frontend's HTTPS acquisition at the
  // owner's ready line runs beside this stop, so its lease intent can reach the
  // lifetime (version 2 to 3, same attempt) after down captured it. Down waits
  // on the lifetime that now carries the lease instead of refusing.
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization({
    scope: opts.scope,
    run,
    httpsPort: null,
  });
  expect(lifetime.token.version).toBe(2);
  let leased: Awaited<ReturnType<typeof beginNativeProjectFinalization>>;
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    after: async () => {
      leased = await beginNativeProjectFinalization({
        scope: opts.scope,
        run,
        httpsPort: 18_443,
        httpsLease: {
          version: 1,
          ownerGeneration: "1".repeat(32),
          leaseId: "2".repeat(32),
          run: run.run,
          attempt: lifetime.token.attempt,
          owner: run.owner,
          namespace: run.namespace,
          planId: run.planId,
        },
      });
      expect(leased.token.version).toBe(3);
      setTimeout(() => void leased.complete(), 50);
    },
    invoke: async (request) => {
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(
    await captureNativeProjectFinalization({ scope: opts.scope, run })
  ).toMatchObject({ version: 3, attempt: lifetime.token.attempt });
});

test("missing frontend identity refuses before hooks or cleanup without leaking paths", async () => {
  const opts = await fixture();
  await rm(finalizationRoot(opts.scope), { recursive: true });
  const calls: string[] = [];
  const result = nativeProjectDown({
    ...opts,
    before: async () => {
      calls.push("before");
    },
    invoke: async (request) => {
      calls.push(request.args[1]!);
      return snapshot();
    },
  });
  await expectClosedRefusal(result, "frontend finalization is unconfirmed");
  try {
    await result;
  } catch (error) {
    expect(String(error)).not.toContain(opts.scope.nativeHome);
  }
  expect(calls).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("frontend identity changed by a before hook refuses before compute cleanup", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      before: async () => {
        await beginNativeProjectFinalization({ scope: opts.scope, run });
        calls.push("before");
      },
      invoke: async (request) => {
        calls.push(request.args[1]!);
        return snapshot();
      },
    }),
    "ownership changed"
  );
  expect(calls).toEqual(["inspect", "before", "inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("stopped compute cannot borrow a wrong or missing frontend completion", async () => {
  for (const fault of [
    "changed",
    "missing-active",
    "missing-completion",
  ] as const) {
    const opts = await fixture();
    const root = finalizationRoot(opts.scope);
    const calls: string[] = [];
    let cleaned = false;
    await expectClosedRefusal(
      nativeProjectDown({
        ...opts,
        finalizationTimeoutMs: 1,
        invoke: async (request) => {
          calls.push(request.args[1]!);
          if (request.args[1] === "cleanup") {
            cleaned = true;
            if (fault === "changed") {
              const replacement = await beginNativeProjectFinalization({
                scope: opts.scope,
                run,
              });
              await replacement.complete();
            } else {
              await rm(
                join(
                  root,
                  fault === "missing-active" ? "active.json" : "completed.json"
                )
              );
            }
            return {};
          }
          return snapshot(cleaned);
        },
      }),
      "frontend finalization is unconfirmed"
    );
    expect(calls).toEqual(["inspect", "inspect", "cleanup", "inspect"]);
    expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  }
});

test("already-stopped down waits for finalization without guest cleanup or hooks", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  const retired = Promise.withResolvers<void>();
  const calls: string[] = [];
  let stopped = false;
  const result = nativeProjectDown({
    ...opts,
    before: async () => {
      throw new Error("replayed before");
    },
    after: async () => {
      throw new Error("replayed after");
    },
    retireHostProcesses: async () => {
      calls.push("retire-host");
      retired.resolve();
    },
    invoke: async (request) => {
      calls.push(request.args[1]!);
      return snapshot(true);
    },
  }).then((value) => {
    stopped = true;
    return value;
  });
  await retired.promise;
  await Bun.sleep(20);
  expect(stopped).toBe(false);
  await lifetime.complete();
  expect((await result).status).toBe("stopped");
  expect(calls).toEqual(["inspect", "retire-host"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down of a run that failed after started clears its failure record", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const result = await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "clear-failure-after-started") {
        expect(request.args).toEqual([
          "graph",
          "clear-failure-after-started",
          "--run-id",
          run.run,
          "--json",
        ]);
        return { run: run.run, cleared: true };
      }
      return {
        ...snapshot(true),
        failed_after_started: { code: "graph_service_failed", at: 1 },
      };
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls).toEqual(["inspect", "clear-failure-after-started"]);
  // Without a record nothing extra is called (see the test above).
});

test.each([
  { recover: false, phase: "started-observed", enrolled: false },
  { recover: true, phase: "started-observed", enrolled: false },
  { recover: false, phase: "ready-observed", enrolled: true },
  { recover: false, phase: "ready-observed", enrolled: false },
])("down reaches a starting owner holding the provider lease ($phase, recover $recover, enrolled $enrolled)", async ({
  recover,
  phase,
  enrolled,
}) => {
  // A start that returned at started: the owner holds the provider lease until
  // its ready line, so every leased command is refused until the stop lands.
  const opts = await fixture();
  let held = true;
  const calls: string[] = [];
  const initial = snapshot(false);
  const warming = {
    ...initial,
    receipt: {
      ...initial.receipt,
      phase,
      ...(enrolled ? { extending: ["slow"] } : {}),
    },
  };
  const started = performance.now();
  const result = await nativeProjectDown({
    ...opts,
    recover,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "status" || command === "foreground-owner") {
        return command === "status"
          ? warming
          : ownerSelection("running", phase);
      }
      if (command === "owner-status") {
        return {
          ok: true,
          run: run.run,
          plan: run.planId,
          runtime_error: "graph_starting",
        };
      }
      if (command === "cleanup") {
        // The owner's socket takes the stop without the lease; then it lets go.
        held = false;
        return {};
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      if (held) {
        throw new NativeRuntimeRequestError({
          message:
            "Native runtime request failed (provider_busy); inspect owned state before retrying.",
          nativeCode: "provider_busy",
        });
      }
      return snapshot(true);
    },
  }).catch((error: unknown) => error);
  expect(calls).toContain("status");
  expect(calls).toContain("cleanup");
  expect(result).toMatchObject({ status: "stopped" });
  // No wait for the lease the owner holds: well under the 15 s busy wait.
  expect(performance.now() - started).toBeLessThan(5000);
});

test("down --recover reaches the dead owner path when the first append write is pending", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let stopped = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return ownerSelection("exited", "ready-observed");
      }
      if (command === "recover-live-owner") {
        stopped = true;
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      return { ...snapshot(stopped), journal_incomplete: !stopped };
    },
  });
  expect(result).toMatchObject({ status: "stopped" });
  expect(
    calls.filter((command) => command === "recover-live-owner")
  ).toHaveLength(1);
  expect(calls).not.toContain("cleanup");
});

test("already-stopped unacknowledged frontend refuses without replaying compute", async () => {
  const opts = await fixture();
  const root = finalizationRoot(opts.scope);
  const token = await captureNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  await writeFile(
    join(root, "active.json"),
    JSON.stringify({ ...token, pid: 2_147_483_647 })
  );
  await rm(join(root, "completed.json"));
  const calls: string[] = [];
  // HACK-1968: an exited frontend (a failed `hack up` that recorded this run) can
  // never finish; plain down reports the recovery command instead of waiting.
  const started = performance.now();
  const result = nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return ownerSelection("uncertain", "stopped-data-retained");
      }
      return snapshot(true);
    },
  });
  await expectClosedRefusal(result, "foreground owner");
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(calls).toEqual([
    "inspect",
    "foreground-owner",
    "retire-unadmitted-owner",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("restart alone may defer its finalization barrier until explicit recovery", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  expect(
    await captureNativeProjectFinalization({ scope: opts.scope, run })
  ).toEqual(lifetime.token);
  let cleaned = false;
  const calls: string[] = [];
  const result = await nativeProjectDown({
    ...opts,
    deferFinalization: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls).toEqual(["inspect", "inspect", "cleanup", "inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down invokes cleanup once and retains the stopped mapping for later up", async () => {
  const opts = await fixture();
  const events: string[] = [];
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    before: async () => {
      events.push("before");
    },
    retireHostProcesses: async () => {
      events.push("retire-host");
    },
    after: async () => {
      expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
      events.push("after");
    },
    invoke: async (request) => {
      events.push(request.args[1]!);
      if (request.args[1] === "cleanup") {
        cleaned = true;
        expect(request.args).not.toContain("--remove-data");
        return {};
      }
      const value = snapshot();
      if (cleaned) {
        value.receipt.phase = "stopped-data-retained";
        value.observations["container:web"].state = "absent";
      }
      return value;
    },
  });
  expect(result.status).toBe("stopped");
  expect(events).toEqual([
    "inspect",
    "before",
    "inspect",
    "cleanup",
    "inspect",
    "retire-host",
    "after",
  ]);
});
test("unconfirmed cleanup retains mapping and skips after hook", async () => {
  const opts = await fixture();
  let effects = 0;
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      retireHostProcesses: async () => {
        throw new Error("unexpected host retirement");
      },
      after: async () => {
        throw new Error("unexpected after");
      },
      invoke: async (request) => {
        if (request.args[1] === "cleanup") {
          effects++;
          return {};
        }
        return snapshot();
      },
    }),
    "unconfirmed"
  );
  expect(effects).toBe(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});
test("foreground concurrent mapping removal is accepted only after confirmed cleanup", async () => {
  const opts = await fixture();
  let cleaned = false;
  await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      if (request.args[1] === "cleanup") {
        cleaned = true;
        await removeNativeProjectRun({ ...opts.scope, expected: run });
        return {};
      }
      const value = snapshot();
      if (cleaned) {
        value.receipt.phase = "stopped-data-retained";
        value.observations["container:web"].state = "absent";
      }
      return value;
    },
  });
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});
test("foreign owner refuses before hooks or cleanup", async () => {
  const opts = await fixture();
  let calls = 0;
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      before: async () => {
        throw new Error("unexpected hook");
      },
      invoke: async () => {
        calls++;
        const value = snapshot();
        value.receipt.owner = "f".repeat(32);
        return value;
      },
    }),
    "unconfirmed"
  );
  expect(calls).toBe(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("native down rejects unsupported flags before project or runtime access", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-flags-"))
  );
  roots.push(root);
  for (const args of [
    ["--env", "qa"],
    ["--profile", "web"],
    ["--prune-caches"],
    ["--yes"],
    ["--target", "remote"],
  ]) {
    const child = Bun.spawn([process.execPath, "index.ts", "down", ...args], {
      env: privateCliEnv({
        root,
        env: {
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_HOME: "/nonexistent-native-home",
          HACK_NATIVE_BINARY: "/nonexistent-native-binary",
        },
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("Native down preserves data");
    } finally {
      clearTimeout(timer);
    }
  }
});

test("not-started native down does not run configured hooks", async () => {
  const opts = await fixture(false);
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "native-test",
      lifecycle: { down: { before: ["exit 87"] } },
    })
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: fixture\n"
  );
  const child = Bun.spawn(
    [process.execPath, "index.ts", "down", "--path", opts.scope.projectRoot],
    {
      env: privateCliEnv({
        root: await clientRoot(),
        env: {
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_HOME: opts.scope.nativeHome,
          HACK_NATIVE_BINARY: "/nonexistent-native-binary",
        },
      }),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^✓ nothing changed {2}\d+\.\ds\n$/);
    expect(stderr).toBe("");
  } finally {
    clearTimeout(timer);
  }
});

const DOWN_OVERLAY_REMOVED =
  "Native down refused before cleanup: .hack/hack.env.qa.yaml or .hack/hack.env.qa.local.yaml was removed since this run started, and the down hooks need the values this run started with. Restore it and run hack down again; nothing was stopped.";
test("down environment preserves explicit base and named overlay while legacy refuses", async () => {
  const opts = await fixture(false);
  const env = async (name: string, value: string) =>
    writeFile(
      join(opts.scope.projectDir, `hack.env.${name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: name,
        secretsprovider: "project_key",
        values: { global: { VALUE: value } },
      })
    );
  await env("default", "base");
  await env("qa", "qa-value");
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({ name: "fixture", env: { defaultOverlay: "qa" } })
  );
  expect(
    await nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: null },
      serviceNames: ["web"],
    })
  ).toEqual({ VALUE: "base" });
  expect(
    await nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa" },
      serviceNames: ["web"],
    })
  ).toEqual({ VALUE: "qa-value" });
  await env("qa", "fresh-value");
  expect(
    await nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa" },
      serviceNames: ["web"],
    })
  ).toEqual({ VALUE: "fresh-value" });
  await rm(join(opts.scope.projectDir, "hack.env.qa.yaml"));
  await expectClosedRefusal(
    nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa" },
      serviceNames: ["web"],
    }),
    DOWN_OVERLAY_REMOVED
  );
  await expectClosedRefusal(
    nativeDownEnvironment({ scope: opts.scope, run, serviceNames: ["web"] }),
    "legacy"
  );
});
test("down environment is empty only for a run recorded without managed env files", async () => {
  const opts = await fixture(false);
  // No managed env file exists. A named selection recorded as managed (or legacy)
  // means its overlay disappeared.
  await expectClosedRefusal(
    nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa" },
      serviceNames: ["web"],
    }),
    DOWN_OVERLAY_REMOVED
  );
  for (const selected of [
    { effectiveEnvName: "qa", unmanagedEnvironment: true as const },
    { effectiveEnvName: null },
  ]) {
    expect(
      await nativeDownEnvironment({
        scope: opts.scope,
        run: { ...run, ...selected },
        serviceNames: ["web"],
      })
    ).toEqual({});
  }
});
test("down hooks keep the recorded selection when env files appeared since startup", async () => {
  const opts = await fixture(false);
  const env = async (name: string, value: string) =>
    await writeFile(
      join(opts.scope.projectDir, `hack.env.${name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: name,
        secretsprovider: "project_key",
        values: { global: { VALUE: value } },
      })
    );
  const down = (selected: Partial<NativeProjectRun>) =>
    nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa", ...selected },
      serviceNames: ["web"],
    });
  // Started without managed env files: no values, even after files appear.
  await env("default", "base");
  await env("qa", "qa-value");
  expect(await down({ unmanagedEnvironment: true })).toEqual({});
  // Started base-only: the base values, never the overlay that appeared later.
  expect(await down({ baseOnlyEnvironment: true })).toEqual({ VALUE: "base" });
  // Started with the overlay: its current values while it exists.
  expect(await down({})).toEqual({ VALUE: "qa-value" });
});
test("before failure prevents cleanup; after failure retains the stopped mapping", async () => {
  for (const phase of ["before", "after"] as const) {
    const opts = await fixture();
    let cleaned = false;
    let calls = 0;
    const failure = new Error(`synthetic ${phase} failure`);
    await expect(
      nativeProjectDown({
        ...opts,
        [phase]: async () => {
          throw failure;
        },
        invoke: async (request) => {
          if (request.args[1] === "cleanup") {
            calls++;
            cleaned = true;
            return {};
          }
          const value = snapshot();
          if (cleaned) {
            value.receipt.phase = "stopped-data-retained";
            value.observations["container:web"].state = "absent";
          }
          return value;
        },
      })
    ).rejects.toBe(failure);
    expect(calls).toBe(phase === "before" ? 0 : 1);
    expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  }
});

test("native down JSON isolates hook output and uses saved overlay through real CLI", async () => {
  const opts = await fixture(false);
  await saveNativeProjectRun({
    ...opts.scope,
    run: { ...run, effectiveEnvName: "qa" },
  });
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "fixture",
      env: { defaultOverlay: "other" },
      lifecycle: {
        down: {
          before: ['test "$VALUE" = selected && echo hook-before'],
          after: ['test "$VALUE" = selected && echo hook-after'],
        },
      },
    })
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: fixture\n"
  );
  for (const [name, value] of [
    ["default", "wrong"],
    ["qa", "selected"],
    ["other", "wrong-other"],
  ]) {
    await writeFile(
      join(opts.scope.projectDir, `hack.env.${name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: name,
        secretsprovider: "project_key",
        values: { global: { VALUE: value } },
      })
    );
  }
  const binary = join(opts.scope.projectRoot, "fake-native");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst marker=${JSON.stringify(join(opts.scope.projectRoot, "cleaned"))};const value=${JSON.stringify(snapshot())};if(process.argv.includes("cleanup")){await Bun.write(marker,"yes");console.log("{}")}else{if(await Bun.file(marker).exists()){value.receipt.phase="stopped-data-retained";value.observations["container:web"].state="absent"}console.log(JSON.stringify(value))}`,
    { mode: 0o700 }
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "index.ts",
      "down",
      "--json",
      "--path",
      opts.scope.projectRoot,
    ],
    {
      env: privateCliEnv({
        root: await clientRoot(),
        env: {
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_HOME: opts.scope.nativeHome,
          HACK_NATIVE_BINARY: binary,
        },
      }),
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
    expect(JSON.parse(stdout)).toMatchObject({
      backend: "native",
      status: "stopped",
    });
    expect(stderr).toContain("hook-before");
    expect(stderr).toContain("hook-after");
    expect(await loadNativeProjectRun(opts.scope)).toEqual({
      ...run,
      effectiveEnvName: "qa",
    });
  } finally {
    clearTimeout(timer);
  }
});

test("recovered stopped graph retires host processes without replaying hooks or compute cleanup", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const result = await nativeProjectDown({
    ...opts,
    retireHostProcesses: async (selected) => {
      expect(selected).toEqual(run);
      calls.push("retire-host");
    },
    before: async () => {
      throw new Error("replayed before");
    },
    after: async () => {
      throw new Error("replayed after");
    },
    invoke: async (request) => {
      calls.push(request.args[1]!);
      const value = snapshot();
      value.receipt.phase = "stopped-data-retained";
      value.observations["container:web"].state = "absent";
      return value;
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls).toEqual(["inspect", "retire-host"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down recovers a selected interrupted startup without replaying hooks or ordinary cleanup", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    before: () => {
      throw new Error("unexpected before-hook replay");
    },
    after: () => {
      throw new Error("unexpected after-hook replay");
    },
    retireHostProcesses: async () => {
      calls.push("retire-host");
    },
    invoke: async ({ args }) => {
      calls.push(args[1]!);
      if (args[1] === "inspect-interrupted-start-cleanup") {
        return {
          run: run.run,
          phase: "cleanup-intent",
          eligible: true,
          same_boot: true,
          data_retained: true,
          selection_sha256: "f".repeat(64),
        };
      }
      if (args[1] === "recover-interrupted-start-cleanup") {
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          same_boot: true,
          publisher_retired: true,
          reservation_released: true,
        };
      }
      const value = snapshot(recovered);
      if (!recovered) {
        value.receipt.phase = "cleanup-intent";
        return {
          ...value,
          receipt: { ...value.receipt, relay_cleanup: { phase: "pending" } },
        };
      }
      return value;
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls).toEqual([
    "inspect",
    "inspect-interrupted-start-cleanup",
    "recover-interrupted-start-cleanup",
    "inspect",
    "retire-host",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down preserves a partial ready-graph shutdown without hooks, stop replay or startup recovery", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      before: async () => {
        calls.push("before");
      },
      after: async () => {
        calls.push("after");
      },
      retireHostProcesses: async () => {
        calls.push("retire");
      },
      invoke: async ({ args }) => {
        calls.push(args[1]!);
        const value = snapshot();
        value.receipt.phase = "cleanup-intent";
        return {
          ...value,
          receipt: { ...value.receipt, relay_cleanup: { phase: "pending" } },
          interrupted_start_cleanup_incomplete: false,
          pending_cleanup: { version: 1, kind: "partial_shutdown" },
        };
      },
    }),
    "Native retaining shutdown is incomplete"
  );
  expect(calls).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("stopped receipt with a remaining container preserves mapping", async () => {
  const opts = await fixture();
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      retireHostProcesses: async () => {
        throw new Error("unexpected host retirement");
      },
      invoke: async () => {
        const value = snapshot();
        value.receipt.phase = "stopped-data-retained";
        return value;
      },
    }),
    "unconfirmed"
  );
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("host retirement failure preserves confirmed stopped state and skips after hooks", async () => {
  const opts = await fixture();
  await expect(
    nativeProjectDown({
      ...opts,
      retireHostProcesses: async () => {
        throw new Error("host ownership uncertain");
      },
      after: async () => {
        throw new Error("unexpected after hook");
      },
      invoke: async () => {
        const value = snapshot();
        value.receipt.phase = "stopped-data-retained";
        value.observations["container:web"].state = "absent";
        return value;
      },
    })
  ).rejects.toThrow("host ownership uncertain");
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

/**
 * Native down marks shared helpers as stopping only once the down is
 * committed: after its before hook and the ownership/finalization rechecks,
 * immediately before graph cleanup. A down refused at any of those boundaries
 * must leave the shared helper shutdown generation and operation record alone,
 * so a concurrent up is not superseded by a shutdown that never happened.
 */
async function sharedHelperInstance(projectRoot: string) {
  const hackDir = join(projectRoot, "hack-home");
  const instances = join(hackDir, "shared-helpers", ".instances");
  await mkdir(instances, { recursive: true, mode: 0o700 });
  const operationPath = join(instances, "demo--a.operation");
  await writeFile(operationPath, "current-up-operation\n", { mode: 0o600 });
  const helper: ProjectSharedHelperConfig = {
    name: "issuer-bridge",
    enabled: true,
    command: ["/bin/true"],
    port: 4100,
    identityPath: "/__hack/identity",
    upstream: "https://issuer.test",
    env: [],
    readyTimeoutMs: 1000,
  };
  return {
    mark: async () => {
      await markSharedHelperInstanceStopping({
        helpers: [helper],
        composeProject: "demo--a",
        hackDir,
      });
    },
    generation: () =>
      readFile(join(instances, "demo--a.shutdown-generation"), "utf8").catch(
        () => null
      ),
    operation: () => readFile(operationPath, "utf8"),
  };
}

test("a native down refused after its before hook leaves the shared helper shutdown state unchanged", async () => {
  for (const refusal of ["finalization", "ownership", "hook"] as const) {
    const opts = await fixture();
    const helpers = await sharedHelperInstance(opts.scope.projectRoot);
    const calls: string[] = [];
    let inspections = 0;
    const result = nativeProjectDown({
      ...opts,
      before: async () => {
        calls.push("before");
        if (refusal === "finalization") {
          await beginNativeProjectFinalization({ scope: opts.scope, run });
        }
        if (refusal === "hook") {
          throw new Error("down.before hook failed");
        }
      },
      beforeCleanup: async () => {
        calls.push("before-cleanup");
        await helpers.mark();
      },
      invoke: async (request) => {
        calls.push(request.args[1]!);
        inspections += 1;
        const value = snapshot();
        if (refusal === "ownership" && inspections > 1) {
          value.receipt.owner = "f".repeat(32);
        }
        return value;
      },
    });
    if (refusal === "hook") {
      await expect(result).rejects.toThrow("down.before hook failed");
    } else {
      await expectClosedRefusal(
        result,
        refusal === "finalization" ? "ownership changed" : "unconfirmed"
      );
    }
    expect(calls).not.toContain("before-cleanup");
    expect(calls).not.toContain("cleanup");
    expect(await helpers.generation()).toBeNull();
    expect(await helpers.operation()).toBe("current-up-operation\n");
  }
});

test("a committed native down marks shared helpers as stopping immediately before graph cleanup", async () => {
  const opts = await fixture();
  const helpers = await sharedHelperInstance(opts.scope.projectRoot);
  const calls: string[] = [];
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    before: async () => {
      calls.push("before");
    },
    beforeCleanup: async () => {
      calls.push("before-cleanup");
      await helpers.mark();
    },
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls.slice(0, 5)).toEqual([
    "inspect",
    "before",
    "inspect",
    "before-cleanup",
    "cleanup",
  ]);
  expect(await helpers.generation()).not.toBeNull();
  expect(await helpers.operation()).toStartWith("stopping:");
});

const receiptSha = "f".repeat(64);
function ownerSelection(foreground: string, phase = "ready-observed") {
  return {
    version: 1,
    run: run.run,
    owner: run.owner,
    phase,
    receipt_sha256: receiptSha,
    foreground,
    live_owner_recovery: null as string | null,
  };
}

test("plain down refuses missing owner recovery proof without replaying cleanup", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      invoke: async (request) => {
        calls.push(request.args[1]!);
        if (request.args[1] === "cleanup") {
          throw new NativeRuntimeRequestError({
            message: "Native runtime request failed (graph_owner_recovery).",
            nativeCode: "graph_owner_recovery",
          });
        }
        return snapshot();
      },
    }),
    "cannot confirm this run's foreground owner state"
  );
  expect(calls).toEqual(["inspect", "inspect", "cleanup", "foreground-owner"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  { enrollment: false, label: "ready owner", phase: "ready-observed" },
  // Every service started, some goal unmet: a real run with a mapping.
  { enrollment: false, label: "started owner", phase: "started-observed" },
  {
    enrollment: true,
    label: "legacy pending cleanup",
    phase: "ready-observed",
  },
])("down --recover stops $label selected by its exact receipt", async ({
  enrollment,
  phase,
}) => {
  const opts = await fixture();
  const events: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    before: async () => {
      events.push("before");
    },
    retireHostProcesses: async () => {
      events.push("retire-host");
    },
    after: async () => {
      events.push("after");
    },
    invoke: async (request) => {
      events.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        expect(request.args).toEqual([
          "graph",
          "foreground-owner",
          "--run-id",
          run.run,
          "--json",
        ]);
        return ownerSelection("exited", phase);
      }
      if (request.args[1] === "recover-live-owner") {
        expect(request.args).toEqual([
          "graph",
          "recover-live-owner",
          "--run-id",
          run.run,
          "--expect-receipt",
          receiptSha,
          "--json",
        ]);
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          same_boot: true,
        };
      }
      expect(request.args[1]).toBe("inspect");
      const observed = snapshot(recovered);
      return enrollment
        ? {
            ...observed,
            receipt: {
              ...observed.receipt,
              relay_cleanup: {
                version: 1,
                runtime: new Array(16).fill(1),
                boot: new Array(16).fill(2),
                operation: new Array(16).fill(3),
                effect: new Array(32).fill(4),
                control_root: "/private/owned",
                phase: "pending",
              },
            },
          }
        : observed;
    },
  });
  expect(result.status).toBe("stopped");
  expect(result.dataPreserved).toBe(true);
  expect(events).toEqual([
    "inspect",
    "foreground-owner",
    "before",
    "inspect",
    "recover-live-owner",
    "inspect",
    "retire-host",
    "after",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  "absent",
  "running",
] as const)("down --recover with a %s owner takes the ordinary authenticated cleanup", async (foreground) => {
  const opts = await fixture();
  const calls: string[] = [];
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return ownerSelection(foreground);
      }
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls).toEqual([
    "inspect",
    "foreground-owner",
    "inspect",
    "cleanup",
    "inspect",
  ]);
});

test.each([
  {
    name: "an exited owner with an unproved failed start",
    selection: ownerSelection("exited", "failed-retained"),
    text: "run hack down --recover again",
  },
  {
    name: "an exited owner with an unproved unfinished start",
    selection: ownerSelection("exited", "preparing"),
    text: "run hack down --recover again",
  },
  {
    // HACK-2097: its start settled; it died after writing its cleanup intent.
    name: "an owner that died during its own stop",
    selection: ownerSelection("exited", "cleanup-intent"),
    text: "exited during its own stop (receipt cleanup-intent)",
  },
  {
    // The explicit cleanup refuses a restore in progress, so it is not named.
    name: "an owner that died while restoring",
    selection: ownerSelection("exited", "restoring"),
    text: "exited while restoring or restarting its retained run (receipt restoring)",
  },
  {
    name: "an unclassified publication",
    selection: ownerSelection("uncertain"),
    text: "cannot confirm this run's foreground owner state",
  },
  {
    name: "a selection for another owner",
    selection: { ...ownerSelection("exited"), owner: "9".repeat(32) },
    text: "cannot confirm this run's foreground owner state",
  },
  {
    name: "a malformed recovery selection",
    selection: { ...ownerSelection("exited"), live_owner_recovery: "short" },
    text: "cannot confirm this run's foreground owner state",
  },
  {
    name: "a malformed receipt digest",
    selection: { ...ownerSelection("exited"), receipt_sha256: "short" },
    text: "cannot confirm this run's foreground owner state",
  },
])("down --recover refuses $name before hooks or any stop", async ({
  selection,
  text,
}) => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      recover: true,
      before: async () => {
        calls.push("before");
      },
      invoke: async (request) => {
        calls.push(request.args[1]!);
        if (request.args[1] === "foreground-owner") {
          return selection;
        }
        expect(request.args[1]).toBe("inspect");
        return snapshot(selection.phase === "stopped-data-retained");
      },
    }),
    text
  );
  expect(calls).toEqual(["inspect", "foreground-owner"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  "exited",
  "uncertain",
])("down --recover retires a retained restore owner that died before admission (%s publication)", async (foreground) => {
  const opts = await fixture();
  const events: string[] = [];
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    before: async () => {
      events.push("before");
    },
    retireHostProcesses: async () => {
      events.push("retire-host");
    },
    invoke: async (request) => {
      events.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return ownerSelection(foreground, "stopped-data-retained");
      }
      if (request.args[1] === "retire-unadmitted-owner") {
        expect(request.args).toEqual([
          "graph",
          "retire-unadmitted-owner",
          "--run-id",
          run.run,
          "--expect-receipt",
          receiptSha,
          "--json",
        ]);
        return {
          version: 1,
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          relay_retired: true,
          dependency_reservation_released: false,
        };
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(true);
    },
  });
  expect(result.status).toBe("stopped");
  expect(result.dataPreserved).toBe(true);
  // Compute was never admitted: no before hook, stop or cleanup is requested.
  expect(events).toEqual([
    "inspect",
    "foreground-owner",
    "retire-unadmitted-owner",
    "inspect",
    "retire-host",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down --recover names a refused unadmitted owner retirement without hooks or a stop", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      recover: true,
      before: async () => {
        calls.push("before");
      },
      retireHostProcesses: async () => {
        calls.push("retire-host");
      },
      invoke: async (request) => {
        calls.push(request.args[1]!);
        if (request.args[1] === "foreground-owner") {
          return ownerSelection("uncertain", "stopped-data-retained");
        }
        if (request.args[1] === "retire-unadmitted-owner") {
          throw new NativeRuntimeRequestError({
            message:
              "Native runtime request failed (graph_unadmitted_owner_recovery).",
            nativeCode: "graph_unadmitted_owner_recovery",
          });
        }
        return snapshot(true);
      },
    }),
    "could not prove that this run's foreground owner exited before its restore was admitted"
  );
  expect(calls).toEqual([
    "inspect",
    "foreground-owner",
    "retire-unadmitted-owner",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  false,
  true,
])("down retires the dead frontend in one command and admits a fresh plain start (recover=%s)", async (recover) => {
  const opts = await fixture();
  // A frontend that began its finalization and exited without completing it.
  const module = join(
    import.meta.dir,
    "../src/backends/native-project-finalization.ts"
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { beginNativeProjectFinalization } = await import(${JSON.stringify(module)});
       const lifetime = await beginNativeProjectFinalization(JSON.parse(process.argv[1]));
       process.stdout.write(lifetime.token.attempt);`,
      JSON.stringify({ scope: opts.scope, run }),
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const attempt = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(attempt).toMatch(/^[a-f0-9]{32}$/);
  let recovered = false;
  const started = performance.now();
  const result = await nativeProjectDown({
    ...opts,
    recover,
    invoke: async (request) => {
      if (request.args[1] === "foreground-owner") {
        return ownerSelection("exited");
      }
      if (request.args[1] === "recover-live-owner") {
        recovered = true;
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      if (request.args[1] === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      return snapshot(recovered);
    },
  });
  expect(result.status).toBe("stopped");
  const token = await captureNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  await waitNativeProjectFinalization({
    scope: opts.scope,
    run,
    token,
    timeoutMs: 1,
  });
  // Same admission barrier used by plain up: no special restart is needed.
  const next = await beginNativeProjectFinalization({ scope: opts.scope, run });
  expect(next.token.attempt).not.toBe(attempt);
  await next.complete();
  expect(recovered).toBe(true);
  // An exited frontend is not awaited for the ordinary finalization budget.
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("down --recover resumes an interrupted dead-owner recovery by its original receipt", async () => {
  const opts = await fixture();
  const original = "1".repeat(64);
  const events: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    before: async () => {
      events.push("before");
    },
    retireHostProcesses: async () => {
      events.push("retire-host");
    },
    invoke: async (request) => {
      events.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        // Interrupted after its cleanup intent: the receipt is no longer ready.
        return {
          ...ownerSelection("exited", "cleanup-intent"),
          live_owner_recovery: original,
        };
      }
      if (request.args[1] === "recover-live-owner") {
        expect(request.args).toContain(original);
        expect(request.args).not.toContain(receiptSha);
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      const value = snapshot(recovered);
      if (!recovered) {
        value.receipt.phase = "cleanup-intent";
      }
      return value;
    },
  });
  expect(result.status).toBe("stopped");
  // The resumed stop runs no before hook and requests no ordinary cleanup.
  expect(events).toEqual([
    "inspect",
    "foreground-owner",
    "recover-live-owner",
    "inspect",
    "retire-host",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  { stopped: false, complete: false },
  { stopped: true, complete: undefined },
  { stopped: true, complete: false },
  { stopped: true, complete: true },
])("down --recover resumes predecessor cleanup until its completion commits (stopped=$stopped, complete=$complete)", async ({
  stopped,
  complete,
}) => {
  const opts = await fixture();
  const calls: string[] = [];
  let cleaned = stopped;
  let committed = complete === true;
  const selected = "7".repeat(64);
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return {
          ...ownerSelection(
            "exited",
            stopped ? "stopped-data-retained" : "ready-observed"
          ),
          dead_owner_recovery: selected,
          dead_owner_recovery_complete: complete,
        };
      }
      if (request.args[1] === "recover-cleanup") {
        expect(request.args).toEqual([
          "graph",
          "recover-cleanup",
          "--run-id",
          run.run,
          "--expect-receipt",
          selected,
          "--json",
        ]);
        cleaned = true;
        committed = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (request.args[1] === "retire-recovered-publisher") {
        expect(cleaned).toBe(true);
        expect(committed).toBe(true);
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls.includes("recover-cleanup")).toBe(!complete);
  if (!complete) {
    expect(calls.indexOf("recover-cleanup")).toBeLessThan(
      calls.indexOf("retire-recovered-publisher")
    );
  }
  expect(calls).toContain("retire-recovered-publisher");
  expect(calls).not.toContain("recover-live-owner");
});

test("completed predecessor recovery retries host retirement before reporting stopped", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let reservationHeld = true;
  let attempts = 0;
  const invoke = async (request: { args: readonly string[] }) => {
    calls.push(request.args[1]!);
    if (request.args[1] === "foreground-owner") {
      return {
        ...ownerSelection("exited", "stopped-data-retained"),
        dead_owner_recovery: "7".repeat(64),
        dead_owner_recovery_complete: true,
      };
    }
    if (request.args[1] === "retire-recovered-publisher") {
      attempts++;
      if (attempts === 1) {
        throw new NativeRuntimeRequestError({
          message: "reservation release interrupted",
          nativeCode: "dependency_reservation",
        });
      }
      reservationHeld = false;
      return { run: run.run, publisher_retired: true, data_retained: true };
    }
    expect(request.args[1]).toBe("inspect");
    return snapshot(true);
  };
  await expectClosedRefusal(
    nativeProjectDown({ ...opts, recover: true, invoke }),
    "reservation release interrupted"
  );
  expect(reservationHeld).toBe(true);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  const result = await nativeProjectDown({ ...opts, recover: true, invoke });
  expect(result.status).toBe("stopped");
  expect(reservationHeld).toBe(false);
  expect(attempts).toBe(2);
  expect(calls).not.toContain("recover-cleanup");
});

test("an unfinished stopped predecessor recovery must succeed before publication retirement", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      recover: true,
      invoke: async (request) => {
        calls.push(request.args[1]!);
        if (request.args[1] === "foreground-owner") {
          return {
            ...ownerSelection("exited", "stopped-data-retained"),
            dead_owner_recovery: "7".repeat(64),
            dead_owner_recovery_complete: false,
          };
        }
        if (request.args[1] === "recover-cleanup") {
          throw new NativeRuntimeRequestError({
            message: "proof changed",
            nativeCode: "graph_dead_owner_recovery",
          });
        }
        expect(request.args[1]).toBe("inspect");
        return snapshot(true);
      },
    }),
    "graph_dead_owner_recovery"
  );
  expect(calls).toContain("recover-cleanup");
  expect(calls).not.toContain("retire-recovered-publisher");
});

test("a running owner with retained recovery selectors still uses ordinary authenticated cleanup", async () => {
  const opts = await fixture();
  let cleaned = false;
  const calls: string[] = [];
  await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return {
          ...ownerSelection("running"),
          live_owner_recovery: "7".repeat(64),
          dead_owner_recovery: "8".repeat(64),
        };
      }
      if (request.args[1] === "cleanup") {
        cleaned = true;
        return {};
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(cleaned);
    },
  });
  expect(calls).toContain("cleanup");
  expect(calls).not.toContain("recover-cleanup");
  expect(calls).not.toContain("recover-live-owner");
});

test("a recovery proof refusal does not suggest stopping a dead owner", async () => {
  const opts = await fixture();
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      recover: true,
      invoke: async (request) => {
        if (request.args[1] === "foreground-owner") {
          return ownerSelection("exited");
        }
        if (request.args[1] === "recover-live-owner") {
          throw new NativeRuntimeRequestError({
            message: "private detail",
            nativeCode: "publisher_stop_uncertain",
          });
        }
        return snapshot();
      },
    }),
    "Run hack ps --json"
  );
});

test("a malformed optional recovery hint cannot block a running owner's authenticated stop", async () => {
  const opts = await fixture();
  let stopped = false;
  await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      if (request.args[1] === "foreground-owner") {
        return {
          ...ownerSelection("running"),
          live_owner_recovery: { malformed: true },
          dead_owner_recovery: "bad",
          dead_owner_recovery_complete: { malformed: true },
        };
      }
      if (request.args[1] === "cleanup") {
        stopped = true;
        return {};
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(stopped);
    },
  });
  expect(stopped).toBe(true);
});

test("a predecessor retained stop without a recovery intent keeps unadmitted retirement", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return {
          ...ownerSelection("exited", "stopped-data-retained"),
          dead_owner_recovery: null,
        };
      }
      if (request.args[1] === "retire-unadmitted-owner") {
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(true);
    },
  });
  expect(calls).toContain("retire-unadmitted-owner");
  expect(calls).not.toContain("recover-cleanup");
});

for (const predecessor of [false, true]) {
  test(`next.13 writer state: one down --recover retires graph and dead frontend (${predecessor ? "predecessor" : "same"} boot)`, async () => {
    const opts = await fixture(false);
    const child = Bun.spawn([process.execPath, "-e", ""], {
      env: privateCliEnv({
        root: opts.scope.projectRoot,
        home: opts.scope.nativeHome,
      }),
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    await installNext13Frontend({ scope: opts.scope, exitedPid: child.pid });
    expect(await loadNativeProjectRun(opts.scope)).toMatchObject(run);
    let stopped = false;
    const calls: string[] = [];
    const inspect = () => ({
      journal_incomplete: false,
      receipt: {
        ...oldReceipt,
        phase: stopped ? "stopped-data-retained" : oldReceipt.phase,
      },
      observations: Object.fromEntries(
        Object.entries(oldReceipt.resources).map(([key, resource]) => [
          key,
          {
            state:
              resource.kind === "volume"
                ? "present"
                : stopped
                  ? "absent"
                  : "running",
          },
        ])
      ),
    });
    const result = await nativeProjectDown({
      ...opts,
      recover: true,
      invoke: async (request) => {
        const command = request.args[1]!;
        calls.push(command);
        if (command === "foreground-owner") {
          return {
            ...ownerSelection("exited"),
            dead_owner_recovery: predecessor ? "7".repeat(64) : null,
          };
        }
        if (["recover-live-owner", "recover-cleanup"].includes(command)) {
          stopped = true;
          return {
            run: run.run,
            recovered: true,
            data_retained: true,
            publisher_retired: true,
          };
        }
        if (command === "retire-recovered-publisher") {
          return { run: run.run, publisher_retired: true, data_retained: true };
        }
        if (command === "managed-hostname-authority") {
          return { authority: { present: false } };
        }
        return inspect();
      },
    });
    expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
    expect(stopped).toBe(true);
    expect(calls).not.toContain("restore-selection");
    const token = await captureNativeProjectFinalization({
      scope: opts.scope,
      run,
    });
    await waitNativeProjectFinalization({
      scope: opts.scope,
      run,
      token,
      timeoutMs: 1,
    });
    const next = await beginNativeProjectFinalization({
      scope: opts.scope,
      run,
    });
    expect(next.token.attempt).not.toBe(token.attempt);
    await next.complete();
  });
}

test.each([
  { phase: "ready-observed", original: null },
  { phase: "failed-retained", original: null },
  { phase: "preparing", original: null },
  { phase: "restoring", original: null },
  { phase: "cleanup-intent", original: "1".repeat(64) },
])("plain down resumes exact dead-owner cleanup after $phase without replaying the refused stop", async ({
  phase,
  original,
}) => {
  const opts = await fixture();
  const calls: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "cleanup") {
        throw new NativeRuntimeRequestError({
          nativeCode: "graph_owner_recovery",
          message: "owner unavailable",
        });
      }
      if (command === "foreground-owner") {
        return {
          ...ownerSelection("exited", phase),
          live_owner_recovery: original,
          failed_start_recoverable: [
            "failed-retained",
            "preparing",
            "restoring",
          ].includes(phase),
        };
      }
      if (command === "recover-live-owner") {
        expect(request.args).toContain(original ?? receiptSha);
        recovered = true;
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      return snapshot(recovered);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls.filter((call) => call === "cleanup")).toHaveLength(1);
  expect(calls.filter((call) => call === "recover-live-owner")).toHaveLength(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  "preparing",
  "restoring",
])("down --recover selects the exact unfinished $phase receipt", async (phase) => {
  const opts = await fixture();
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async ({ args }) => {
      if (args[1] === "foreground-owner") {
        return {
          ...ownerSelection("exited", phase),
          failed_start_recoverable: true,
        };
      }
      if (args[1] === "recover-live-owner") {
        expect(args).toContain(receiptSha);
        recovered = true;
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      expect(args[1]).toBe("inspect");
      return snapshot(recovered);
    },
  });
  expect(result.status).toBe("stopped");
});

// HACK-2456: the pool stopped under a running project.
function poolStoppedError() {
  return new NativeRuntimeRequestError({
    nativeCode: "runtime_not_running",
    message: "The candidate runtime is not running (phase stopped).",
  });
}

test.each([
  "ready-observed",
  "started-observed",
])("down --recover on a stopped pool with a dead owner starts the pool once and recovers with data retained (%s)", async (phase) => {
  const opts = await fixture();
  const calls: string[] = [];
  let pool = false;
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        expect(request.args).toEqual([
          "runtime",
          "up",
          "--profile",
          "development",
          "--project-share",
          opts.scope.projectRoot,
          "--unfiltered-source",
          "--json",
        ]);
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return {
          ...ownerSelection("exited", phase),
          dead_owner_recovery: pool ? "7".repeat(64) : null,
        };
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "recover-cleanup") {
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      expect(command).toBe("inspect");
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({
    status: "stopped",
    dataPreserved: true,
    runtimeStarted: true,
  });
  expect(calls).toEqual([
    "inspect",
    "foreground-owner",
    "up",
    "inspect",
    "foreground-owner",
    "recover-cleanup",
    "retire-recovered-publisher",
    "inspect",
  ]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

// HACK-2579: the pool's provider was killed; inspection refuses the dead recorded
// provider until `runtime recover` records the pool stopped.
test("down on a pool whose provider exited under a running record recovers the pool, then recovers the run", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let runtimeRecovered = false;
  let pool = false;
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "status") {
        return runtimeRecovered
          ? { phase: "recovered-unclean", process_alive: false }
          : { phase: "process-exited", process_alive: false };
      }
      if (command === "recover") {
        runtimeRecovered = true;
        return { phase: "recovered-unclean", process_alive: false };
      }
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return {
          ...ownerSelection("exited"),
          dead_owner_recovery: pool ? "7".repeat(64) : null,
        };
      }
      if (!runtimeRecovered) {
        throw new NativeRuntimeRequestError({
          nativeCode: "process_identity_unavailable",
          message: "Cannot establish native provider process identity.",
        });
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "recover-cleanup") {
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  expect(calls.slice(0, 5)).toEqual([
    "inspect",
    "status",
    "recover",
    "inspect",
    "foreground-owner",
  ]);
  expect(calls.filter((call) => call === "recover")).toHaveLength(1);
  expect(calls.filter((call) => call === "recover-cleanup")).toHaveLength(1);
});

// HACK-2572: right after the pool stopped, the run's detached owner is still exiting.
test("down --recover waits for the owner of an ended pool boot to go, then recovers as before", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let pool = false;
  let cleaned = false;
  let owners = 0;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    poolBootEnded: async () => !pool,
    endedBootOwnerWaitMs: 5000,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        owners += 1;
        return owners <= 2
          ? ownerSelection("running")
          : {
              ...ownerSelection("exited"),
              dead_owner_recovery: pool ? "7".repeat(64) : null,
            };
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "recover-cleanup") {
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  // Two reads see the owner still running, the third sees it exited; then the
  // pool is started once and the run recovered as for any dead owner.
  expect(calls.slice(0, 5)).toEqual([
    "inspect",
    "foreground-owner",
    "foreground-owner",
    "foreground-owner",
    "foreground-owner",
  ]);
  expect(calls.filter((call) => call === "up")).toHaveLength(1);
  expect(calls).toContain("recover-cleanup");
});

// HACK-2572: the owner's end seen by the selection, point by point.
for (const recover of [true, false]) {
  test(`${recover ? "down --recover" : "plain down"} through the owner's end (running, uncertain, exited) recovers once`, async () => {
    const opts = await fixture();
    const calls: string[] = [];
    const points = ["running", "uncertain", "uncertain"] as const;
    let pool = false;
    let cleaned = false;
    let owners = 0;
    const result = await nativeProjectDown({
      ...opts,
      ...(recover ? { recover: true } : {}),
      poolBootEnded: async () => !pool,
      endedBootOwnerWaitMs: 5000,
      invoke: async (request) => {
        const command = request.args[1]!;
        calls.push(command);
        if (command === "up") {
          pool = true;
          return { phase: "running" };
        }
        if (command === "foreground-owner") {
          owners += 1;
          const point = points[owners - 1];
          return point
            ? ownerSelection(point)
            : {
                ...ownerSelection("exited"),
                dead_owner_recovery: pool ? "7".repeat(64) : null,
              };
        }
        if (!pool) {
          throw poolStoppedError();
        }
        if (!recover) {
          // The retried plain down then takes its ordinary path on the running pool.
          return snapshot(true);
        }
        if (command === "recover-cleanup") {
          cleaned = true;
          return { run: run.run, recovered: true, data_retained: true };
        }
        if (command === "retire-recovered-publisher") {
          return { run: run.run, publisher_retired: true, data_retained: true };
        }
        return snapshot(cleaned);
      },
    });
    expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
    // Three selections see the owner alive or ending; the pool is started once only
    // after one sees it exited.
    expect(calls.slice(0, 6)).toEqual([
      "inspect",
      "foreground-owner",
      "foreground-owner",
      "foreground-owner",
      "foreground-owner",
      "foreground-owner",
    ]);
    expect(calls.filter((call) => call === "up")).toHaveLength(1);
    if (recover) {
      expect(calls.filter((call) => call === "recover-cleanup")).toHaveLength(
        1
      );
    }
  });
}

test("down keeps its refusal at once when the stopped pool's owner is running but the boot is not proven ended", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const error = await nativeProjectDown({
    ...opts,
    recover: true,
    poolBootEnded: async () => false,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return ownerSelection("running");
      }
      throw poolStoppedError();
    },
  }).catch((caught: unknown) => caught);
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "runtime_not_running"
  );
  expect(calls).not.toContain("up");
});

// HACK-2715 review round 6 (seen on a real VM at 2d0d6b08, the hook row): after
// `runtime down --force`, a project with lifecycle hooks ran `down.before` and
// `down.after` while `hack down` recovered its run on the pool it started. The
// services had stopped with the ended boot; no down hook runs for such a down.
test("down that starts a stopped pool to recover a dead owner's run runs no down hook", async () => {
  const opts = await fixture();
  const phases: string[] = [];
  const calls: string[] = [];
  let pool = false;
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    hooks: {
      configured: true,
      run: async ({ phase }) => {
        phases.push(phase);
      },
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return {
          ...ownerSelection("exited", "ready-observed"),
          dead_owner_recovery: pool ? "7".repeat(64) : null,
        };
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "cleanup") {
        // The owner exited with the ended boot: the authenticated stop finds no
        // owner to answer it.
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (graph_owner_recovery).",
          nativeCode: "graph_owner_recovery",
        });
      }
      if (command === "recover-cleanup") {
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  expect(calls).toContain("recover-cleanup");
  expect(phases).toEqual([]);
});

// HACK-2715 review round 6: another project already started the pool again, so
// this down never sees it stopped. The owner selection's dead-owner recovery
// hint (given only for a run its boot evidence places in an earlier boot) still
// tells it the run's boot ended, and no live-path down hook runs.
test("down after another project restarted the pool runs no down hook when the selection has a dead-owner recovery hint", async () => {
  const opts = await fixture();
  const phases: string[] = [];
  const calls: string[] = [];
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    hooks: {
      configured: true,
      run: async ({ phase }) => {
        phases.push(phase);
      },
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return {
          ...ownerSelection("exited", "ready-observed"),
          dead_owner_recovery: "7".repeat(64),
        };
      }
      if (command === "cleanup") {
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (graph_owner_recovery).",
          nativeCode: "graph_owner_recovery",
        });
      }
      if (command === "recover-cleanup") {
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({ status: "stopped" });
  expect(result).not.toHaveProperty("runtimeStarted");
  expect(calls).not.toContain("up");
  expect(calls).toContain("recover-cleanup");
  expect(phases).toEqual([]);
});

// Without a hint (no boot evidence), the same down runs its hooks as before.
test("down whose owner selection has no dead-owner recovery hint runs its down hooks", async () => {
  const opts = await fixture();
  const phases: string[] = [];
  let cleaned = false;
  await nativeProjectDown({
    ...opts,
    hooks: {
      configured: true,
      run: async ({ phase }) => {
        phases.push(phase);
      },
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      if (command === "foreground-owner") {
        return ownerSelection("running", "ready-observed");
      }
      if (command === "cleanup") {
        cleaned = true;
        return { run: run.run, stopped: true, data_retained: true };
      }
      return snapshot(cleaned);
    },
  }).catch(() => undefined);
  expect(phases[0]).toBe("before");
});

// Review round 6 (Low): after the pool boot ended, a `down.after` an earlier
// healthy down left owed in the journal still runs once; only the live-path
// hooks are skipped.
test("down after the pool boot ended still runs a down.after an earlier down left owed", async () => {
  const opts = await fixture();
  const { replaceNativeDownHookRecord } = await import(
    "../src/backends/native-project-down-hooks.ts"
  );
  expect(
    await replaceNativeDownHookRecord(opts.scope, null, {
      run: run.run,
      generation: "e".repeat(32),
      state: "after-owed",
    })
  ).toBe(true);
  const phases: string[] = [];
  let pool = false;
  const result = await nativeProjectDown({
    ...opts,
    hooks: {
      configured: true,
      run: async ({ phase }) => {
        phases.push(phase);
      },
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return ownerSelection("exited", "ready-observed");
      }
      if (!pool) {
        throw poolStoppedError();
      }
      // An earlier healthy down already stopped the graph and owes its after.
      return snapshot(true);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  expect(phases).toEqual(["after"]);
});

/**
 * The state a ready detached Compose start leaves when its pool boot ends
 * under it, as kept in the real-VM homes at efcec5d3 (`p1257-hooks`,
 * `p1257-hooksb`): the start wrote the ready run's `owed` down-hook record,
 * and its frontend exited (with the pool watch) without completing its
 * finalization.
 */
async function endedBootReadyRun(scope: NativeProjectRunScope): Promise<void> {
  const { replaceNativeDownHookRecord } = await import(
    "../src/backends/native-project-down-hooks.ts"
  );
  expect(
    await replaceNativeDownHookRecord(scope, null, {
      run: run.run,
      generation: "f".repeat(32),
      state: "owed",
    })
  ).toBe(true);
  const module = join(
    import.meta.dir,
    "../src/backends/native-project-finalization.ts"
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { beginNativeProjectFinalization } = await import(${JSON.stringify(module)});
       await beginNativeProjectFinalization(JSON.parse(process.argv[1]));`,
      JSON.stringify({ scope, run }),
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  expect(await child.exited).toBe(0);
}

// HACK-2715, real VM at efcec5d3: `runtime down --force` (`p1257-hooks`), or
// another project's down that started the stopped pool again (`p1257-hooksb`),
// then this project's plain `hack down`. With the frontend gone the down
// selects the owner, `graph foreground-owner` gives its dead-owner recovery hint
// (the homes' `dead-owner-cleanup.json` records it as `original_sha256`, from
// the ended boot to the new one), `recover-cleanup` stops the run, and the
// stopped path ran the ready run's `owed` record as `down.before` and
// `down.after`. The services had stopped with the ended boot: neither runs, and
// the record is retired so a later down does not run them either.
for (const poolStopped of [true, false]) {
  test(`down of a ready run whose pool boot ended runs no owed down hook (${poolStopped ? "after runtime down --force" : "after another project restarted the pool"})`, async () => {
    const opts = await fixture();
    await endedBootReadyRun(opts.scope);
    const { loadNativeDownHookRecord } = await import(
      "../src/backends/native-project-down-hooks.ts"
    );
    const phases: string[] = [];
    const calls: string[] = [];
    let pool = !poolStopped;
    let cleaned = false;
    const down = () =>
      nativeProjectDown({
        ...opts,
        poolBootEnded: async () => false,
        hooks: {
          configured: true,
          run: async ({ phase }) => {
            phases.push(phase);
          },
        },
        invoke: async (request) => {
          const command = request.args[1]!;
          calls.push(command);
          if (command === "up") {
            pool = true;
            return { phase: "running" };
          }
          if (command === "foreground-owner") {
            return cleaned
              ? ownerSelection("absent", "stopped-data-retained")
              : {
                  ...ownerSelection("exited", "ready-observed"),
                  dead_owner_recovery: pool ? "3".repeat(64) : null,
                  dead_owner_recovery_complete: false,
                };
          }
          if (!pool) {
            throw poolStoppedError();
          }
          if (command === "recover-cleanup") {
            expect(request.args).toContain("3".repeat(64));
            cleaned = true;
            return { run: run.run, recovered: true, data_retained: true };
          }
          if (command === "retire-recovered-publisher") {
            return {
              run: run.run,
              publisher_retired: true,
              data_retained: true,
            };
          }
          if (command === "managed-hostname-authority") {
            return { authority: { present: false } };
          }
          expect(command).toBe("inspect");
          return snapshot(cleaned);
        },
      });
    const result = await down();
    expect(result.status).toBe("stopped");
    expect(result.runtimeStarted === true).toBe(poolStopped);
    expect(calls.filter((call) => call === "recover-cleanup")).toHaveLength(1);
    expect(phases).toEqual([]);
    expect(await loadNativeDownHookRecord(opts.scope)).toBeNull();
    // A later down of the stopped run has nothing owed either.
    expect((await down()).status).toBe("stopped");
    expect(phases).toEqual([]);
  });
}

// The same boot: a frontend crash on a running pool is recovered by the
// same-boot recovery, which gives no dead-owner hint. The ready run's owed
// hooks then run once on the stopped graph, as before.
test("down of a ready run whose frontend crashed on the same boot still runs its owed down hooks", async () => {
  const opts = await fixture();
  await endedBootReadyRun(opts.scope);
  const phases: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    hooks: {
      configured: true,
      run: async ({ phase }) => {
        phases.push(phase);
      },
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      if (command === "foreground-owner") {
        return ownerSelection("exited", "ready-observed");
      }
      if (command === "recover-live-owner") {
        recovered = true;
        return {
          run: run.run,
          recovered: true,
          data_retained: true,
          publisher_retired: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      return snapshot(recovered);
    },
  });
  expect(result.status).toBe("stopped");
  expect(recovered).toBe(true);
  expect(phases).toEqual(["before", "after"]);
});

test("plain down on a stopped pool with a dead owner also starts the pool to recover", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  let pool = false;
  const result = await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return ownerSelection("exited");
      }
      if (!pool) {
        throw poolStoppedError();
      }
      // The retried down then takes its ordinary path on the running pool.
      return snapshot(true);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  expect(calls.slice(0, 3)).toEqual(["inspect", "foreground-owner", "up"]);
  expect(calls.filter((call) => call === "up")).toHaveLength(1);
});

test.each([
  { foreground: "running", phase: "ready-observed" },
  { foreground: "uncertain", phase: "ready-observed" },
  { foreground: "absent", phase: "ready-observed" },
  { foreground: "exited", phase: "stopped-data-retained" },
  // A retained stop whose frontend finished its finalization needs nothing more.
  { foreground: "absent", phase: "stopped-data-retained" },
  // A restore or restart in progress has no supported recovery after a boot,
  // so the pool is not started for it (requireRecoverableOwner).
  { foreground: "exited", phase: "restoring" },
  { foreground: "exited", phase: "restarting" },
  // A same-boot recovery (recover-live-owner) cannot run after the boot this
  // would start, so the pool is not started for it either.
  {
    foreground: "exited",
    phase: "ready-observed",
    extra: { live_owner_recovery: "a".repeat(64) },
  },
] as {
  foreground: string;
  phase: string;
  extra?: Record<string, unknown>;
}[])("down --recover on a stopped pool keeps its refusal without runtime up (owner $foreground, $phase)", async ({
  foreground,
  phase,
  extra,
}) => {
  const opts = await fixture();
  const calls: string[] = [];
  const attempt = nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return { ...ownerSelection(foreground, phase), ...extra };
      }
      throw poolStoppedError();
    },
  });
  const error = await attempt.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(NativeRuntimeRequestError);
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "runtime_not_running"
  );
  expect(calls).toEqual(["inspect", "foreground-owner"]);
});

// HACK-2714 (real VM, row 2): the provider died after "Project started" and
// before the owner's ready line, and the owner's unwind left `failed-retained`.
// `runtime recover` stopped the pool; the down must start it, because the
// runtime's cross-boot dead-owner recovery now retires that start. Before this
// fix the down kept `runtime_not_running` here, and `hack up` refused.
test.each([
  { phase: "failed-retained" },
  { phase: "preparing" },
  // The same-boot hint does not matter once the boot has ended.
  { phase: "failed-retained", extra: { failed_start_recoverable: true } },
] as {
  phase: string;
  extra?: Record<string, unknown>;
}[])("down --recover starts a stopped pool for a start lost before ready ($phase)", async ({
  phase,
  extra,
}) => {
  const opts = await fixture();
  const calls: string[] = [];
  let pool = false;
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        // On the new boot the runtime names the lost start's dead-owner
        // recovery; while the pool is stopped it cannot.
        return {
          ...ownerSelection("exited", phase),
          ...extra,
          dead_owner_recovery: pool ? receiptSha : null,
        };
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "recover-cleanup") {
        expect(request.args).toContain(receiptSha);
        cleaned = true;
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (command === "retire-recovered-publisher") {
        expect(cleaned).toBe(true);
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      expect(command).toBe("inspect");
      return snapshot(cleaned);
    },
  });
  expect(result).toMatchObject({ status: "stopped", runtimeStarted: true });
  expect(calls.slice(0, 3)).toEqual(["inspect", "foreground-owner", "up"]);
  expect(calls.filter((call) => call === "up")).toHaveLength(1);
  expect(calls).toContain("recover-cleanup");
  expect(calls).not.toContain("recover-live-owner");
});

/** A frontend that began its finalization and exited without completing it. */
async function deadFrontend(scope: NativeProjectRunScope): Promise<void> {
  const module = join(
    import.meta.dir,
    "../src/backends/native-project-finalization.ts"
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { beginNativeProjectFinalization } = await import(${JSON.stringify(module)});
       await beginNativeProjectFinalization(JSON.parse(process.argv[1]));`,
      JSON.stringify({ scope, run }),
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  expect(await child.exited).toBe(0);
}

// HACK-2456, seen on a real VM: a recovery stopped the graph and retired the
// owner's publication, then failed in the frontend finalization (the shared
// HTTPS lease), and the pool was stopped again. down --recover must still work.
test("down --recover starts a stopped pool to finish a recovery whose frontend finalization failed", async () => {
  const opts = await fixture();
  await deadFrontend(opts.scope);
  const calls: string[] = [];
  let pool = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        pool = true;
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return ownerSelection("absent", "stopped-data-retained");
      }
      if (!pool) {
        throw poolStoppedError();
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return snapshot(true);
    },
  });
  expect(result).toMatchObject({
    status: "stopped",
    dataPreserved: true,
    runtimeStarted: true,
  });
  expect(calls.slice(0, 3)).toEqual(["inspect", "foreground-owner", "up"]);
  expect(calls.filter((call) => call === "up")).toHaveLength(1);
  // The dead frontend's finalization is now recovered, so plain up may start.
  const token = await captureNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  await waitNativeProjectFinalization({
    scope: opts.scope,
    run,
    token,
    timeoutMs: 1,
  });
});

test("a frontend lost after its lifetime and mapping were written: down --recover finds both (PR B review, item 1)", async () => {
  const opts = await fixture();
  // The started chain registers this frontend's lifetime, then saves the mapping;
  // the frontend then dies, leaving a warming run whose owner has exited.
  await deadFrontend(opts.scope);
  const calls: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return ownerSelection("exited", "started-observed");
      }
      if (command === "recover-live-owner") {
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          same_boot: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return snapshot(recovered);
    },
  });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(calls).toContain("recover-live-owner");
  // The dead frontend's lifetime was captured and is now recovered: the next up
  // can register its own.
  const token = await captureNativeProjectFinalization({
    scope: opts.scope,
    run,
  });
  await waitNativeProjectFinalization({
    scope: opts.scope,
    run,
    token,
    timeoutMs: 1,
  });
});

test("a frontend lost in the window: plain down recovers it as down --recover does", async () => {
  const opts = await fixture();
  await deadFrontend(opts.scope);
  const calls: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return ownerSelection("exited", "started-observed");
      }
      if (command === "recover-live-owner") {
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          same_boot: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return snapshot(recovered);
    },
  });
  // Past finalization capture to owner selection, then the same-boot recovery.
  expect(calls.indexOf("foreground-owner")).toBeLessThan(
    calls.indexOf("recover-live-owner")
  );
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
});

// HACK-2097: a foreground `up` is lost (killed) while its graph owner still runs.
// The owner sees its frontend go and runs its own retaining stop, so the
// `down --recover` that follows can select it running and then reach it after it
// stopped (publication retired) or after it died mid-way (publication left).
async function lostForegroundDown(opts: {
  /** The selections after the stop went unanswered; the last one repeats. */
  readonly reselections: readonly ReturnType<typeof ownerSelection>[];
  readonly recover?: boolean;
  /** False: the frontend is alive, so plain down selects only after the stop. */
  readonly lostFrontend?: boolean;
  /** False: an absent owner left the graph ready (a torn retirement). */
  readonly stoppedByOwner?: boolean;
  readonly ownerExitWaitMs?: number;
}) {
  const fx = await fixture();
  const lostFrontend = opts.lostFrontend !== false;
  if (lostFrontend) {
    await deadFrontend(fx.scope);
  }
  const recover = opts.recover ?? true;
  // The first selection, before the stop, saw the owner running.
  const selectsFirst = lostFrontend || recover;
  const calls: string[] = [];
  const events: string[] = [];
  const notices: string[] = [];
  let stopped = false;
  let selections = 0;
  const down = nativeProjectDown({
    ...fx,
    recover,
    ownerExitWaitMs: opts.ownerExitWaitMs ?? 0,
    notice: (line) => {
      notices.push(line);
    },
    before: async () => {
      events.push("before");
    },
    retireHostProcesses: async () => {
      events.push("retire-host");
    },
    after: async () => {
      events.push("after");
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        selections += 1;
        // Running at the first selection; the owner then stops on its own.
        if (selectsFirst && selections === 1) {
          return ownerSelection("running");
        }
        const selection =
          opts.reselections[
            Math.min(
              selections - (selectsFirst ? 2 : 1),
              opts.reselections.length - 1
            )
          ]!;
        if (
          selection.foreground === "absent" &&
          opts.stoppedByOwner !== false
        ) {
          stopped = true;
        }
        return selection;
      }
      if (command === "cleanup") {
        throw new NativeRuntimeRequestError({
          message: "Native runtime request failed (graph_owner_recovery).",
          nativeCode: "graph_owner_recovery",
        });
      }
      if (command === "recover-live-owner") {
        expect(request.args).toEqual([
          "graph",
          "recover-live-owner",
          "--run-id",
          run.run,
          "--expect-receipt",
          receiptSha,
          "--json",
        ]);
        stopped = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          same_boot: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return snapshot(stopped);
    },
  });
  return { fx, calls, events, notices, down };
}

const selectionCount = (calls: readonly string[]) =>
  calls.filter((c) => c === "foreground-owner").length;

/** The lost frontend's lifetime is recovered, so the next `up` can register its own. */
async function expectFrontendRecovered(scope: NativeProjectRunScope) {
  const token = await captureNativeProjectFinalization({ scope, run });
  await waitNativeProjectFinalization({ scope, run, token, timeoutMs: 1 });
}

test("lost foreground, live owner: down --recover completes when the owner stopped itself before the stop arrived", async () => {
  const { fx, calls, events, notices, down } = await lostForegroundDown({
    reselections: [ownerSelection("absent", "stopped-data-retained")],
  });
  expect(await down).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(selectionCount(calls)).toBe(2);
  expect(notices).toEqual([]);
  expect(calls).not.toContain("recover-live-owner");
  expect(calls).not.toContain("retire-unadmitted-owner");
  // Cleanup was asked once and never replayed; the stop is confirmed after.
  expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
  expect(calls[calls.indexOf("cleanup") + 2]).toBe("inspect");
  // Frontend recovery retires host processes again under its own lock.
  expect(events.slice(0, 3)).toEqual(["before", "retire-host", "after"]);
  expect(await loadNativeProjectRun(fx.scope)).toEqual(run);
  await expectFrontendRecovered(fx.scope);
});

test("lost foreground, live owner: down --recover recovers an owner that died before the stop arrived", async () => {
  const { fx, calls, events, down } = await lostForegroundDown({
    reselections: [ownerSelection("exited")],
  });
  expect(await down).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(calls.indexOf("cleanup")).toBeLessThan(
    calls.indexOf("recover-live-owner")
  );
  expect(events.slice(0, 3)).toEqual(["before", "retire-host", "after"]);
  await expectFrontendRecovered(fx.scope);
});

test("lost foreground, live owner: an owner still running after the bounded wait is not treated as dead and names the rerun", async () => {
  const { fx, calls, events, down } = await lostForegroundDown({
    reselections: [ownerSelection("running")],
  });
  await expectClosedRefusal(
    down,
    "Native down --recover found this run's foreground owner still running or retiring its publication after it stopped answering; retained data was not changed and nothing was replayed. Run hack ps --json, wait for the owner to exit, then run hack down --recover again."
  );
  expect(calls).not.toContain("recover-live-owner");
  expect(calls).not.toContain("retire-unadmitted-owner");
  expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
  expect(events).toEqual(["before"]);
  expect(await loadNativeProjectRun(fx.scope)).toEqual(run);
});

test("lost foreground, live owner: down --recover waits while the owner finishes its stop and retires its publication", async () => {
  // Still running (its stop in progress), then its publication read
  // mid-retirement (`uncertain` over the stopped receipt), then gone.
  const { fx, calls, events, notices, down } = await lostForegroundDown({
    reselections: [
      ownerSelection("running"),
      ownerSelection("uncertain", "stopped-data-retained"),
      ownerSelection("absent", "stopped-data-retained"),
    ],
    ownerExitWaitMs: 10_000,
  });
  expect(await down).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(selectionCount(calls)).toBe(4);
  expect(notices).toEqual([NATIVE_OWNER_EXIT_NOTICE]);
  // A publication read mid-change is never retired as an unadmitted owner.
  expect(calls).not.toContain("retire-unadmitted-owner");
  expect(calls).not.toContain("recover-live-owner");
  expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
  expect(events.slice(0, 3)).toEqual(["before", "retire-host", "after"]);
  await expectFrontendRecovered(fx.scope);
});

test("lost foreground, live owner: a publication still uncertain after the bounded wait refuses with the rerun step", async () => {
  const { fx, calls, events, notices, down } = await lostForegroundDown({
    reselections: [ownerSelection("uncertain", "stopped-data-retained")],
    ownerExitWaitMs: 300,
  });
  await expectClosedRefusal(
    down,
    "wait for the owner to exit, then run hack down --recover again"
  );
  // It polled within the bound instead of refusing at the first read.
  expect(selectionCount(calls)).toBeGreaterThan(2);
  expect(notices).toEqual([NATIVE_OWNER_EXIT_NOTICE]);
  expect(calls).not.toContain("retire-unadmitted-owner");
  expect(calls).not.toContain("recover-live-owner");
  expect(events).toEqual(["before"]);
  expect(await loadNativeProjectRun(fx.scope)).toEqual(run);
});

test("lost foreground, live owner: an owner that died during its own stop is diagnosed as such, not as an unconfirmed start", async () => {
  // Its retaining cleanup wrote `cleanup-intent` before stopping anything.
  const { fx, calls, events, down } = await lostForegroundDown({
    reselections: [ownerSelection("exited", "cleanup-intent")],
  });
  const error = await expectClosedRefusal(
    down,
    "Native down --recover found that this run's foreground owner exited during its own stop (receipt cleanup-intent); retained data and evidence were kept and nothing was replayed."
  );
  expect(error.message).toContain(
    "native-candidate.md#explicit-cleanup-after-a-dead-foreground-owner"
  );
  expect(error.message).not.toContain("before its start was confirmed");
  expect(error.message).not.toContain("never settled");
  expect(calls).not.toContain("recover-live-owner");
  expect(events).toEqual(["before"]);
  expect(await loadNativeProjectRun(fx.scope)).toEqual(run);
});

test("lost foreground, live owner: plain down completes when the owner stopped itself, and its refusals name plain down", async () => {
  const stoppedItself = await lostForegroundDown({
    recover: false,
    reselections: [ownerSelection("absent", "stopped-data-retained")],
  });
  expect(await stoppedItself.down).toMatchObject({
    status: "stopped",
    dataPreserved: true,
  });
  expect(selectionCount(stoppedItself.calls)).toBe(2);
  expect(stoppedItself.calls).not.toContain("recover-live-owner");
  await expectFrontendRecovered(stoppedItself.fx.scope);

  const stillRunning = await lostForegroundDown({
    recover: false,
    reselections: [ownerSelection("running")],
  });
  const error = await expectClosedRefusal(
    stillRunning.down,
    "Native down found this run's foreground owner still running"
  );
  expect(error.message).toContain("then run hack down again.");
  expect(error.message).not.toContain("--recover");
});

test("plain down with a live frontend accepts an owner that retired itself before its stop arrived", async () => {
  // No selection before the stop; the one after it finds the owner gone.
  const { calls, down } = await lostForegroundDown({
    recover: false,
    lostFrontend: false,
    reselections: [ownerSelection("absent", "stopped-data-retained")],
  });
  expect(await down).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(calls.indexOf("cleanup")).toBeLessThan(
    calls.indexOf("foreground-owner")
  );
  expect(selectionCount(calls)).toBe(1);
  // The stopped receipt is confirmed after the selection, never assumed.
  expect(calls[calls.indexOf("foreground-owner") + 1]).toBe("inspect");
});

test("lost foreground, live owner: an absent owner whose graph is still ready refuses without recovery (unconfirmed-absent control)", async () => {
  // A torn retirement: the publication is gone, the receipt still ready.
  const { fx, calls, events, down } = await lostForegroundDown({
    reselections: [ownerSelection("absent")],
    stoppedByOwner: false,
  });
  await expectClosedRefusal(down, "Native down cleanup is unconfirmed");
  expect(calls).not.toContain("recover-live-owner");
  expect(calls).not.toContain("retire-unadmitted-owner");
  expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
  expect(events).toEqual(["before"]);
  expect(await loadNativeProjectRun(fx.scope)).toEqual(run);
});

test("a start that crashed after its lifetime and before its mapping: plain down finds it from the lifetime", async () => {
  // No mapping was saved; the lifetime record carries the same run identity.
  const opts = await fixture(false);
  await deadFrontend(opts.scope);
  const calls: string[] = [];
  let recovered = false;
  const result = await nativeProjectDown({
    ...opts,
    startupWaitMs: 1,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "foreground-owner") {
        return ownerSelection("exited", "started-observed");
      }
      if (command === "recover-live-owner") {
        recovered = true;
        return {
          run: run.run,
          phase: "stopped-data-retained",
          recovered: true,
          data_retained: true,
          publisher_retired: true,
          same_boot: true,
        };
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return snapshot(recovered);
    },
  });
  expect(result).toMatchObject({ status: "stopped", run: run.run });
  expect(calls).toContain("recover-live-owner");
  // Recovered: a second down no longer selects it.
  expect(await orphanNativeProjectLifetime(opts.scope)).toBeNull();
});

test("down --recover sends runtime up at most once when the pool is still not running", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const attempt = nativeProjectDown({
    ...opts,
    recover: true,
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "up") {
        return { phase: "running" };
      }
      if (command === "foreground-owner") {
        return ownerSelection("exited");
      }
      throw poolStoppedError();
    },
  });
  const error = await attempt.catch((caught: unknown) => caught);
  expect((error as NativeRuntimeRequestError).nativeCode).toBe(
    "runtime_not_running"
  );
  expect(calls).toEqual(["inspect", "foreground-owner", "up", "inspect"]);
});

test("the restart coordinator's down never starts a stopped pool", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  const attempt = nativeProjectDown({
    ...opts,
    recover: true,
    deferFinalization: true,
    invoke: async (request) => {
      calls.push(request.args[1]!);
      if (request.args[1] === "foreground-owner") {
        return ownerSelection("exited");
      }
      throw poolStoppedError();
    },
  });
  await expect(attempt).rejects.toBeInstanceOf(NativeRuntimeRequestError);
  expect(calls).toEqual(["inspect"]);
});

/**
 * HACK-2096: a `hack restart` whose replacement was lost (its VM died) after its
 * old run was stopped leaves a `cleaned` restart intent, and `hack up` refuses
 * while it is pending. Once `hack down --recover` retires the replacement with
 * its data kept, the project is an ordinary stopped one: the recovery retires
 * the intent too, so its one named follow-up, `hack up`, works.
 */
async function lostReplacementDown(opts: {
  readonly recover: boolean;
  readonly phase: NativeRestartIntent["phase"];
  readonly intentRun?: string;
  readonly lockHeld?: boolean;
  /** An inspect under the restart lock no longer reads the run as stopped. */
  readonly resumedUnderLock?: boolean;
  /** The intent on disk cannot be read. */
  readonly unreadable?: boolean;
  /** How many inspects under the restart lock answer `provider_busy` first. */
  readonly busyUnderLock?: number;
  /** The re-inspect's busy wait (the production default is 15 s). */
  readonly retireBusyWaitMs?: number;
}) {
  const fx = await fixture();
  const { lock } = await nativeRestartOperationLock(fx.scope);
  const locked = () =>
    stat(lock).then(
      () => true,
      () => false
    );
  const intentRun = { ...run, run: opts.intentRun ?? run.run };
  const prepared: NativeRestartIntent = {
    phase: "prepared",
    run: intentRun,
    finalization: {
      ...(await captureNativeProjectFinalization({ scope: fx.scope, run })),
      run: intentRun.run,
    },
  };
  await saveNativeRestartIntent({ ...fx.scope, intent: prepared });
  if (opts.phase === "cleaned") {
    await completeNativeRestartCleanup({ ...fx.scope, expected: prepared });
  }
  const intentFile = lock.replace(/\.lock\.operation$/, ".json");
  if (opts.unreadable) {
    await writeFile(intentFile, "{}\n", { mode: 0o600 });
  }
  await deadFrontend(fx.scope);
  let inspectsUnderLock = 0;
  const notices: string[] = [];
  let recovered = false;
  const down = () =>
    nativeProjectDown({
      ...fx,
      recover: opts.recover,
      ...(opts.retireBusyWaitMs === undefined
        ? {}
        : { restartRetireBusyWaitMs: opts.retireBusyWaitMs }),
      notice: (line) => {
        notices.push(line);
      },
      invoke: async (request) => {
        const command = request.args[1]!;
        if (command === "foreground-owner") {
          return ownerSelection("exited");
        }
        if (command === "recover-live-owner") {
          recovered = true;
          return {
            run: run.run,
            phase: "stopped-data-retained",
            recovered: true,
            data_retained: true,
            publisher_retired: true,
            same_boot: true,
          };
        }
        if (command === "managed-hostname-authority") {
          return { authority: { present: false } };
        }
        expect(command).toBe("inspect");
        if (!opts.lockHeld && (await locked())) {
          inspectsUnderLock++;
          if (inspectsUnderLock <= (opts.busyUnderLock ?? 0)) {
            // A `hack ps`, `hack logs` or another project's starting `up`
            // holds the provider lease.
            throw new NativeRuntimeRequestError({
              message:
                "Native runtime request failed (provider_busy); inspect owned state before retrying.",
              nativeCode: "provider_busy",
            });
          }
          // Another owner resumed the run between the down and the lock.
          return snapshot(recovered && !opts.resumedUnderLock);
        }
        return snapshot(recovered);
      },
    });
  const result = opts.lockHeld
    ? await withNativeRestartLock(fx.scope, async () => await down())
    : await down();
  return {
    result,
    notices,
    lock,
    inspectsUnderLock,
    intent: opts.unreadable
      ? await readFile(intentFile, "utf8")
      : await loadNativeRestartIntent(fx.scope),
  };
}

test("down --recover retires a cleaned restart whose replacement was lost, so hack up can resume", async () => {
  const { result, notices, intent } = await lostReplacementDown({
    recover: true,
    phase: "cleaned",
  });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(intent).toBeNull();
  expect(notices).toContain(NATIVE_RECOVERED_RESTART_NOTE);
});

test.each([
  { name: "plain down", recover: false, phase: "cleaned" },
  { name: "a prepared intent", recover: true, phase: "prepared" },
  {
    name: "an intent for another run",
    recover: true,
    phase: "cleaned",
    intentRun: "9".repeat(32),
  },
  {
    name: "a restart that holds its lock",
    recover: true,
    phase: "cleaned",
    lockHeld: true,
  },
  {
    // HACK-2096 review L5: the run is re-inspected under the lock.
    name: "a run resumed before the lock was taken",
    recover: true,
    phase: "cleaned",
    resumedUnderLock: true,
  },
] as const)("down keeps the pending restart for $name", async (opts) => {
  const { result, notices, intent, inspectsUnderLock } =
    await lostReplacementDown(opts);
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(typeof intent === "string" ? undefined : intent?.phase).toBe(
    opts.phase
  );
  expect(notices).not.toContain(NATIVE_RECOVERED_RESTART_NOTE);
  if ("resumedUnderLock" in opts) {
    expect(inspectsUnderLock).toBe(1);
    // Kept, but not silently (HACK-2096 round-2 review).
    expect(notices).toContain(NATIVE_RESTART_KEPT_UNCONFIRMED_NOTE);
  }
});

test("down --recover waits out a briefly busy provider and retires the pending restart", async () => {
  // HACK-2096 round-2 review: a read-only `hack ps` or another project's
  // starting `up` holds the lease for a moment; that is no sign of a resume.
  const { result, notices, intent, inspectsUnderLock } =
    await lostReplacementDown({
      recover: true,
      phase: "cleaned",
      busyUnderLock: 3,
      retireBusyWaitMs: 2000,
    });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(inspectsUnderLock).toBe(4);
  expect(intent).toBeNull();
  expect(notices).toContain(NATIVE_RECOVERED_RESTART_NOTE);
  expect(notices).not.toContain(NATIVE_RESTART_KEPT_UNCONFIRMED_NOTE);
});

test("down --recover keeps the pending restart past the busy wait and says to run it again", async () => {
  // The retry itself is proven by the briefly-busy test; this one only needs
  // the wait to run out, so it asserts no retry count (no clock dependence).
  const { result, notices, intent, inspectsUnderLock } =
    await lostReplacementDown({
      recover: true,
      phase: "cleaned",
      busyUnderLock: Number.POSITIVE_INFINITY,
      retireBusyWaitMs: 120,
    });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(inspectsUnderLock).toBeGreaterThanOrEqual(1);
  expect(typeof intent === "string" ? undefined : intent?.phase).toBe(
    "cleaned"
  );
  expect(notices).not.toContain(NATIVE_RECOVERED_RESTART_NOTE);
  const kept = notices.filter(
    (line) => line === NATIVE_RESTART_KEPT_UNCONFIRMED_NOTE
  );
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain("pending hack restart was kept");
  expect(kept[0]).toContain(
    "If the run should not be running, run hack down --recover again"
  );
  expect(kept[0]).not.toContain("\n");
});

test("down --recover names the pending restart and the held lock it kept", async () => {
  // HACK-2096 review L6: a held lock is no longer skipped silently.
  const { result, notices, lock } = await lostReplacementDown({
    recover: true,
    phase: "cleaned",
    lockHeld: true,
  });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(notices).toContain(nativeRestartLockHeldNote(lock));
  const line = notices.find((notice) => notice.includes(lock));
  expect(line).toContain("pending hack restart");
  expect(line).toContain("run hack down --recover again");
  expect(line).not.toContain("\n");
});

test("an unreadable restart intent does not fail a down --recover that stopped the run", async () => {
  // HACK-2096 review L7: the stop stands; the intent is reported, not retired.
  const { result, notices, intent } = await lostReplacementDown({
    recover: true,
    phase: "cleaned",
    unreadable: true,
  });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(notices).toContain(NATIVE_RESTART_INTENT_UNREADABLE_NOTE);
  expect(notices).not.toContain(NATIVE_RECOVERED_RESTART_NOTE);
  expect(intent).toBe("{}\n");
});

/**
 * HACK-2096 real-VM row 8: the provider was killed seconds after a `hack down`
 * removed the run's containers, during the next `hack up`'s image pull. The
 * guest engine's removal had not reached its disk, so the next boot listed the
 * web container again, `exited` (137), while the receipt records it removed.
 * `hack down --recover` refused ("cleanup is unconfirmed") and `hack up`
 * refused the mapping: a dead end. `down --recover` now has the runtime remove
 * exactly those containers again (`graph cleanup`, volumes kept), confirms them
 * absent, and `hack up` can start the run.
 */
function lostRemovalSnapshot(webState: string) {
  const base = snapshot(true);
  return {
    ...base,
    receipt: {
      ...base.receipt,
      resources: {
        "container:web": {
          ...base.receipt.resources["container:web"],
          phase: "absent",
        },
      },
    },
    observations: {
      "container:web": { state: webState, health: null },
    },
  };
}
async function lostRemovalDown(opts: {
  readonly recover: boolean;
  readonly webState: "exited" | "running";
  /** Whether the runtime's cleanup actually removes the container. */
  readonly cleanupClears?: boolean;
  /** The runtime refuses the owner-less repair with this code (real-VM row 8). */
  readonly refusedWith?: "graph_owner_recovery" | "graph_lost_removal";
}) {
  const fx = await fixture();
  const calls: string[] = [];
  const notices: string[] = [];
  let cleaned = false;
  const down = nativeProjectDown({
    ...fx,
    recover: opts.recover,
    notice: (line) => {
      notices.push(line);
    },
    before: async () => {
      throw new Error("replayed before");
    },
    after: async () => {
      throw new Error("replayed after");
    },
    invoke: async (request) => {
      const command = request.args[1]!;
      calls.push(command);
      if (command === "cleanup") {
        expect(request.args).toEqual([
          "graph",
          "cleanup",
          "--run-id",
          run.run,
          "--json",
        ]);
        if (opts.refusedWith) {
          // The repair could not prove the retired owner or the containers.
          throw new NativeRuntimeRequestError({
            message: `Native runtime request failed (${opts.refusedWith}); inspect owned state before retrying.`,
            nativeCode: opts.refusedWith,
          });
        }
        cleaned = true;
        return {};
      }
      if (command === "foreground-owner") {
        return ownerSelection("exited");
      }
      if (command === "managed-hostname-authority") {
        return { authority: { present: false } };
      }
      expect(command).toBe("inspect");
      return lostRemovalSnapshot(
        cleaned && opts.cleanupClears !== false ? "absent" : opts.webState
      );
    },
  });
  const result = await down.then(
    (value) => value,
    (error: unknown) => error
  );
  return { result, calls, notices };
}

test("down --recover removes containers a lost VM brought back, so hack up can start", async () => {
  const { result, calls, notices } = await lostRemovalDown({
    recover: true,
    webState: "exited",
  });
  expect(result).toMatchObject({ status: "stopped", dataPreserved: true });
  expect(calls).toEqual(["inspect", "foreground-owner", "cleanup", "inspect"]);
  expect(notices).toContain(NATIVE_LOST_REMOVAL_NOTE);
});

test.each([
  { name: "a plain down", recover: false, webState: "exited" },
  { name: "a container still running", recover: true, webState: "running" },
] as const)("down never replays cleanup of a stopped run for $name", async (opts) => {
  const { result, calls, notices } = await lostRemovalDown(opts);
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain("cleanup is unconfirmed");
  expect(calls).not.toContain("cleanup");
  expect(notices).not.toContain(NATIVE_LOST_REMOVAL_NOTE);
});

test("down --recover prints no removal note when the re-inspection still finds the container", async () => {
  // Round-4 review: the note prints only after the re-inspection verifies.
  const { result, calls, notices } = await lostRemovalDown({
    recover: true,
    webState: "exited",
    cleanupClears: false,
  });
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain("cleanup is unconfirmed");
  expect(calls).toContain("cleanup");
  expect(notices).not.toContain(NATIVE_LOST_REMOVAL_NOTE);
});

test.each([
  // No retired publication: the cleanup still goes to an owner that is gone.
  { code: "graph_owner_recovery" },
  // The repair found a container it does not admit (HACK-2719).
  { code: "graph_lost_removal" },
] as const)("down --recover says plainly when the runtime refuses to remove brought-back containers ($code)", async ({
  code,
}) => {
  // Real-VM row 8: since HACK-2719 the runtime removes them without the owner
  // under the retired owner's lock; this is the refusal when it cannot prove
  // that. It names no command that fails and none that discards the data.
  const { result, calls, notices } = await lostRemovalDown({
    recover: true,
    webState: "exited",
    refusedWith: code,
  });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe(NATIVE_LOST_REMOVAL_UNREPAIRABLE);
  expect(calls).toContain("cleanup");
  expect(notices).not.toContain(NATIVE_LOST_REMOVAL_NOTE);
  expect(NATIVE_LOST_REMOVAL_UNREPAIRABLE).toContain("data kept");
  expect(NATIVE_LOST_REMOVAL_UNREPAIRABLE).not.toContain("--remove-data");
  expect(NATIVE_LOST_REMOVAL_UNREPAIRABLE).not.toContain("run hack up");
});

test("retiring a cleaned restart is a no-op without one", async () => {
  const fx = await fixture();
  expect(
    await retireCleanedNativeRestart({
      ...fx.scope,
      run: run.run,
      stillStopped: async () => true,
    })
  ).toEqual({ status: "none" });
});
