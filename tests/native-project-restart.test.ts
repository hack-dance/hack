import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeHostDependencies } from "../src/backends/native-project-dependencies.ts";
import { nativeProjectDown } from "../src/backends/native-project-down.ts";
import { restartNativeProject } from "../src/backends/native-project-restart.ts";
import {
  nativeRestartSelection,
  preflightNativeRestart,
} from "../src/backends/native-project-restart-preflight.ts";
import {
  completeNativeRestartCleanup,
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeRestartIntent,
  removeNativeRestartIntent,
  saveNativeProjectRun,
  saveNativeRestartIntent,
  withNativeRestartLock,
} from "../src/backends/native-project-run.ts";

const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: "qa",
  profiles: ["app"],
  aws: null,
};
const token = {
  version: 1 as const,
  attempt: "e".repeat(32),
  scope: "f".repeat(64),
  run: run.run,
  owner: run.owner,
  namespace: run.namespace,
  planId: run.planId,
};
const scope = {
  projectRoot: "/fixture",
  projectDir: "/fixture/.hack",
  nativeHome: "/candidate",
  branch: null,
};
function fixture(pending: NativeRestartIntent | null = null) {
  const events: string[] = [];
  const state = { pending };
  const options: Parameters<typeof restartNativeProject>[0] = {
    scope,
    preflight: async () => {
      events.push("preflight");
    },
    down: async () => {
      events.push("down");
    },
    start: async ({ run: selected, onReady }) => {
      expect(selected).toEqual(run);
      events.push("start");
      await onReady();
      events.push("serving");
      return 0;
    },
    dependencies: {
      load: async () => (pending ? null : run),
      pending: async () => state.pending,
      save: async ({ intent }) => {
        state.pending = intent;
        events.push("intent");
      },
      cleaned: async ({ expected }) => {
        state.pending = { ...expected, phase: "cleaned" };
        return state.pending;
      },
      remove: async () => {
        state.pending = null;
        events.push("remove");
      },
      capture: async () => {
        events.push("capture");
        return token;
      },
      wait: async ({ token: selected }) => {
        expect(selected).toEqual(token);
        events.push("finalized");
      },
      lock: async (_scope, action) =>
        await action(async () => {
          events.push("unlock");
        }),
    },
  };
  return { options, events, state };
}
test("restart preflights before retaining cleanup and waits for frontend finalization", async () => {
  const f = fixture();
  expect(await restartNativeProject(f.options)).toBe(0);
  expect(f.events).toEqual([
    "preflight",
    "capture",
    "intent",
    "down",
    "finalized",
    "start",
    "remove",
    "unlock",
    "serving",
  ]);
});
test("changed selection and preflight failure do not stop the app", async () => {
  for (const options of [{ envName: "prod" }, { profiles: [] }]) {
    const f = fixture();
    await expect(
      restartNativeProject({ ...f.options, ...options })
    ).rejects.toThrow();
    expect(f.events).toEqual([]);
  }
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      preflight: async () => {
        throw new Error("changed plan");
      },
    })
  ).rejects.toThrow("changed plan");
  expect(f.events).toEqual([]);
});
test("failed finalization keeps pending data and never starts replacement", async () => {
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      dependencies: {
        ...f.options.dependencies,
        wait: async () => {
          throw new Error("not finalized");
        },
      },
    })
  ).rejects.toThrow("not finalized");
  expect(f.state.pending?.run).toEqual(run);
  expect(f.events).not.toContain("start");
});
test("resume uses persisted intent without new capture or cleanup", async () => {
  const f = fixture({ run, finalization: token, phase: "cleaned" });
  await restartNativeProject(f.options);
  expect(f.events).toEqual([
    "preflight",
    "finalized",
    "start",
    "remove",
    "unlock",
    "serving",
  ]);
});
test("a cleaned intent selects retained-state review with or without a matching mapping", async () => {
  for (const current of [null, run]) {
    const f = fixture({ run, finalization: token, phase: "cleaned" });
    await restartNativeProject({
      ...f.options,
      preflight: async (selected, { cleanedRetry }) => {
        expect(selected).toEqual(run);
        expect(cleanedRetry).toBe(true);
      },
      dependencies: { ...f.options.dependencies, load: async () => current },
    });
    expect(f.events.includes("down")).toBe(current !== null);
  }
});
test("explicit dead-owner recovery runs after preflight and retained cleanup, before replacement", async () => {
  const f = fixture({ run, finalization: token, phase: "cleaned" });
  await restartNativeProject({
    ...f.options,
    recovery: {
      expectAttempt: token.attempt,
      legacyPid: 52_141,
      verifyEffects: async ({ run: selected, token: selectedToken }) => {
        expect(selected).toEqual(run);
        expect(selectedToken).toEqual(token);
        f.events.push("effects");
      },
      retirePublisher: async (selected) => {
        expect(selected).toEqual(run);
        f.events.push("publisher-retired");
      },
    },
    dependencies: {
      ...f.options.dependencies,
      recover: async ({ expectAttempt, legacyPid, verifyEffects }) => {
        expect(expectAttempt).toBe(token.attempt);
        expect(legacyPid).toBe(52_141);
        await verifyEffects();
        f.events.push("recovered");
      },
    },
  });
  expect(f.events).toEqual([
    "preflight",
    "effects",
    "recovered",
    "publisher-retired",
    "finalized",
    "start",
    "remove",
    "unlock",
    "serving",
  ]);
});
test("failed publisher retirement preserves pending restart and never starts replacement", async () => {
  const f = fixture({ run, finalization: token, phase: "cleaned" });
  await expect(
    restartNativeProject({
      ...f.options,
      recovery: {
        expectAttempt: token.attempt,
        legacyPid: 52_141,
        verifyEffects: async () => undefined,
        retirePublisher: async () => {
          throw new Error("publisher still owned");
        },
      },
      dependencies: {
        ...f.options.dependencies,
        recover: async () => undefined,
      },
    })
  ).rejects.toThrow("publisher still owned");
  expect(f.state.pending?.phase).toBe("cleaned");
  expect(f.events).not.toContain("start");
});
test("failed replacement never drops intent or falls back to a fresh run", async () => {
  const f = fixture();
  await expect(
    restartNativeProject({
      ...f.options,
      start: async () => {
        throw new Error("admission failed");
      },
    })
  ).rejects.toThrow("admission failed");
  expect(f.state.pending?.run.run).toBe(run.run);
  expect(f.events).not.toContain("remove");
});
test("legacy unknown selections refuse and omitted flags preserve saved values", () => {
  expect(nativeRestartSelection({ run })).toEqual({
    envName: "qa",
    profiles: ["app"],
    aws: undefined,
  });
  expect(() =>
    nativeRestartSelection({ run: { ...run, profiles: undefined } })
  ).toThrow("legacy");
});

test("preflight compares actual reviewed identity before cleanup eligibility", async () => {
  const { preflightNativeRestart } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  const calls: string[] = [];
  const image = `sha256:${"9".repeat(64)}`;
  const input = {
    originalSha256: "1".repeat(64),
    environmentFiles: [],
    serviceNames: ["app"],
    normalizedComposeJson: JSON.stringify({ services: { app: { image } } }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: "qa",
  };
  const options: Parameters<typeof preflightNativeRestart>[0] = {
    runtime: { binary: "/unused", home: "/candidate" },
    scope,
    composeFile: "/fixture/.hack/docker-compose.yml",
    run,
    dependencies: {
      prepare: async ({ envName }) => {
        expect(envName).toBe("qa");
        return input;
      },
      adapt: async ({ input: prepared }) => prepared,
      dependencies: async () => [],
      invoke: async ({ args }) => {
        if (args[0] === "graph") {
          expect(args[1]).toBe("source-compatibility");
          return {};
        }
        if (args[1] === "probe") {
          expect(args).toEqual([
            "runtime",
            "probe",
            "--profile",
            "development",
            "--json",
          ]);
          return { admitted: true };
        }
        expect(args).toEqual(["runtime", "status", "--json"]);
        return { network: "internet" };
      },
      review: async (options) => {
        calls.push("review");
        expect(options.profiles).toEqual(["app"]);
        return await options.run({
          planId: "0".repeat(64),
          namespace: run.namespace,
          report: {},
          projectArgs: [],
        });
      },
    },
  };
  await expect(preflightNativeRestart(options)).rejects.toThrow(
    "compatibility changed"
  );
  expect(calls).toEqual(["review"]);
  // The native receipt, not the immutable ownership plan, records current routes.
  await expect(
    preflightNativeRestart({
      ...options,
      dependencies: {
        ...options.dependencies,
        review: async (reviewOptions) =>
          await reviewOptions.run({
            planId: run.planId,
            namespace: run.namespace,
            report: { plan: { hostname_change_sha256: "f".repeat(64) } },
            projectArgs: [],
          }),
      },
    })
  ).rejects.toThrow("compatibility changed");
});

test("preflight refuses a stale host listener before restart cleanup", async () => {
  const { preflightNativeRestart } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  const directory = await mkdtemp(
    join(tmpdir(), "hack-restart-listener-test-")
  );
  try {
    await writeFile(join(directory, "hack-relay-guest"), "relay fixture");
    const calls: string[] = [];
    const input = {
      originalSha256: "1".repeat(64),
      environmentFiles: [],
      serviceNames: ["app"],
      normalizedComposeJson: JSON.stringify({
        services: { app: { image: `sha256:${"9".repeat(64)}` } },
      }),
      managedEnvironment: {},
      lifecycleHostEnvironment: {},
      effectiveEnvName: "qa",
    };
    await expect(
      preflightNativeRestart({
        runtime: { binary: join(directory, "hack-native"), home: "/candidate" },
        scope,
        composeFile: "/fixture/.hack/docker-compose.yml",
        run,
        dependencyFile: "/private/selection.json",
        dependencies: {
          prepare: async () => input,
          adapt: async ({ input: prepared }) => prepared,
          dependencies: async () => [
            {
              service: "app",
              binding: "qa",
              slot: 0,
              guest_port: 8444,
              aliases: ["qa.example.com"],
              host_pid: 12_345,
              host_port: 8444,
            },
          ],
          invoke: async ({ args }) => {
            calls.push(`${args[0]} ${args[1]}`);
            if (args[1] === "status") {
              return { network: "internet" };
            }
            if (args[1] === "probe") {
              return { admitted: true };
            }
            expect(args.slice(0, 3)).toEqual([
              "graph",
              "dependency-plan",
              "--dependencies",
            ]);
            const selection = JSON.parse(await readFile(args[3] ?? "", "utf8"));
            expect(selection.plan).toBe(run.planId);
            expect(selection.dependencies[0].host_pid).toBe(12_345);
            throw new Error("process_identity_unavailable");
          },
          review: async (options) =>
            await options.run({
              planId: run.planId,
              namespace: run.namespace,
              report: {},
              projectArgs: [],
            }),
        },
      })
    ).rejects.toThrow("host dependency listener is unavailable or changed");
    expect(calls).toEqual([
      "runtime status",
      "runtime probe",
      "graph dependency-plan",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfirmed down hooks cannot be silently skipped on resume", async () => {
  const f = fixture({ run, finalization: token, phase: "prepared" });
  await expect(restartNativeProject(f.options)).rejects.toThrow("down hooks");
  expect(f.events).not.toContain("start");
  expect(f.events).not.toContain("preflight");
});

test("network mismatch refuses before an otherwise valid restart", async () => {
  const { requireNativeRestartNetwork } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  expect(() =>
    requireNativeRestartNetwork({
      network: { "approved-hosts": { hosts: ["example.com"] } },
    })
  ).toThrow("not stopped");
  expect(() =>
    requireNativeRestartNetwork({ network: "internet" })
  ).not.toThrow();
  expect(() =>
    requireNativeRestartNetwork(
      { network: { "approved-hosts": { hosts: ["example.com"] } } },
      ["example.com"]
    )
  ).not.toThrow();
});

test("restart preflight refuses failed or unknown admission before reading environment", async () => {
  const { preflightNativeRestart } = await import(
    "../src/backends/native-project-restart-preflight.ts"
  );
  for (const admission of [{ admitted: false }, {}, null]) {
    const calls: string[] = [];
    await expect(
      preflightNativeRestart({
        runtime: { binary: "/unused", home: "/candidate" },
        scope,
        composeFile: "/fixture/.hack/docker-compose.yml",
        run,
        dependencies: {
          invoke: async ({ args }) => {
            calls.push(String(args[1]));
            return args[1] === "status" ? { network: "internet" } : admission;
          },
          prepare: async () => {
            throw new Error("environment should not be read");
          },
        },
      })
    ).rejects.toThrow("admission failed before cleanup");
    expect(calls).toEqual(["status", "probe"]);
  }
});

function stoppedRetainedGraph() {
  return {
    journal_incomplete: false,
    receipt: {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      phase: "stopped-data-retained",
      resources: {
        app: { kind: "container", key: "app" },
        default: { kind: "network", key: "default" },
        data: { kind: "volume", key: "data" },
      },
    },
    observations: {
      "container:app": { state: "absent" },
      "network:default": { state: "absent" },
      "volume:data": { state: "present" },
    },
  };
}

async function listenerIntentFixture() {
  const directory = await mkdtemp(join(tmpdir(), "hack-restart-intent-test-"));
  const path = join(directory, "dependencies.json");
  const selection = {
    version: 1,
    dependencies: [
      {
        service: "app",
        binding: "qa",
        guest_port: 8444,
        aliases: ["qa.example.com"],
        host_port: 8444,
        host_executable: "/usr/bin/ssh",
      },
    ],
  };
  await writeFile(path, JSON.stringify(selection), { mode: 0o600 });
  await writeFile(join(directory, "hack-relay-guest"), "relay fixture");
  const calls: string[] = [];
  const input = {
    originalSha256: "1".repeat(64),
    environmentFiles: [],
    serviceNames: ["app"],
    normalizedComposeJson: JSON.stringify({
      services: { app: { image: `sha256:${"9".repeat(64)}` } },
    }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: "qa",
  };
  const options: Parameters<typeof preflightNativeRestart>[0] = {
    runtime: { binary: join(directory, "hack-native"), home: "/candidate" },
    scope,
    composeFile: "/fixture/.hack/docker-compose.yml",
    run,
    dependencyFile: path,
    dependencies: {
      prepare: async ({ envName }) => {
        expect(envName).toBe("qa");
        return input;
      },
      adapt: async ({ input: prepared }) => prepared,
      invoke: async ({ args }) => {
        calls.push(`${args[0]} ${args[1]}`);
        if (args[1] === "inspect") {
          expect(args).toEqual([
            "graph",
            "inspect",
            "--run-id",
            run.run,
            "--json",
          ]);
          return stoppedRetainedGraph();
        }
        if (args[1] === "status") {
          return { network: "internet" };
        }
        if (args[1] === "probe") {
          return { admitted: true };
        }
        expect(args[1]).toBe("dependency-discover");
        throw new Error("host_endpoint_identity");
      },
      review: async (review) => {
        calls.push("review");
        expect(
          JSON.parse(review.input.normalizedComposeJson).services.app.init
        ).toBe(true);
        return await review.run({
          planId: run.planId,
          namespace: run.namespace,
          report: {},
          projectArgs: [],
        });
      },
    },
  };
  return { directory, path, selection, calls, options };
}

test("cleaned retry with absent listeners reaches startup hooks before actual identity capture", async () => {
  const listener = await listenerIntentFixture();
  try {
    const f = fixture({ run, finalization: token, phase: "cleaned" });
    const captured: number[] = [];
    let hookStarted = false;
    expect(
      await restartNativeProject({
        ...f.options,
        preflight: async (selected, { cleanedRetry }) => {
          expect(cleanedRetry).toBe(true);
          await preflightNativeRestart({
            ...listener.options,
            run: selected,
            cleanedRetry,
          });
        },
        start: async ({ onReady }) => {
          f.events.push("up.before");
          hookStarted = true;
          // Normal startup reads this same intent after its hook has launched the
          // listener. The earlier provisional PID must never become authority.
          const dependencies = await readNativeHostDependencies({
            path: listener.path,
            services: ["app"],
            discover: async ({ hostPort, executable }) => {
              expect(hookStarted).toBe(true);
              expect(hostPort).toBe(8444);
              expect(executable).toBe("/usr/bin/ssh");
              return { host_pid: 12_345, endpoint_fingerprint: "8".repeat(64) };
            },
          });
          captured.push(
            ...dependencies.map((dependency) => dependency.host_pid)
          );
          await onReady();
          return 0;
        },
      })
    ).toBe(0);
    expect(captured).toEqual([12_345]);
    expect(listener.calls).toEqual([
      "graph inspect",
      "runtime status",
      "runtime probe",
      "review",
    ]);
    expect(f.events).toEqual(["finalized", "up.before", "remove", "unlock"]);
    expect(JSON.parse(await readFile(listener.path, "utf8"))).toEqual(
      listener.selection
    );
  } finally {
    await rm(listener.directory, { recursive: true, force: true });
  }
});

test("persisted retaining cleanup keeps its mapping and retry captures listeners after hooks", async () => {
  const listener = await listenerIntentFixture();
  try {
    const projectRoot = await realpath(listener.directory);
    const projectDir = join(projectRoot, ".hack");
    const nativeHome = join(projectRoot, "candidate");
    await mkdir(projectDir);
    await mkdir(nativeHome);
    const retainedScope = { projectRoot, projectDir, nativeHome, branch: null };
    const intent: NativeRestartIntent = {
      phase: "prepared",
      run,
      finalization: token,
    };
    await saveNativeProjectRun({ ...retainedScope, run });
    await saveNativeRestartIntent({ ...retainedScope, intent });
    const cleaned = await completeNativeRestartCleanup({
      ...retainedScope,
      expected: intent,
    });
    expect(cleaned.phase).toBe("cleaned");
    expect(await loadNativeProjectRun(retainedScope)).toEqual(run);
    expect(await loadNativeRestartIntent(retainedScope)).toEqual(cleaned);
    const runtime = { ...listener.options.runtime, home: nativeHome };
    const f = fixture(cleaned);
    let hookStarted = false;
    const captured: number[] = [];
    expect(
      await restartNativeProject({
        ...f.options,
        scope: retainedScope,
        preflight: async (selected, { cleanedRetry }) => {
          expect(cleanedRetry).toBe(true);
          await preflightNativeRestart({
            ...listener.options,
            runtime,
            scope: retainedScope,
            run: selected,
            cleanedRetry,
          });
        },
        down: async () => {
          await nativeProjectDown({
            runtime,
            scope: retainedScope,
            invoke: listener.options.dependencies?.invoke,
            before: async () => {
              throw new Error("down hooks must not replay");
            },
            after: async () => {
              throw new Error("down hooks must not replay");
            },
            retireHostProcesses: async () => {
              f.events.push("retire");
            },
          });
        },
        start: async ({ onReady }) => {
          f.events.push("up.before");
          hookStarted = true;
          const dependencies = await readNativeHostDependencies({
            path: listener.path,
            services: ["app"],
            discover: async () => {
              expect(hookStarted).toBe(true);
              expect(await loadNativeProjectRun(retainedScope)).toEqual(run);
              return { host_pid: 12_345, endpoint_fingerprint: "8".repeat(64) };
            },
          });
          captured.push(
            ...dependencies.map((dependency) => dependency.host_pid)
          );
          await onReady();
          return 0;
        },
        dependencies: {
          ...f.options.dependencies,
          load: loadNativeProjectRun,
          pending: loadNativeRestartIntent,
          cleaned: completeNativeRestartCleanup,
          remove: removeNativeRestartIntent,
          lock: withNativeRestartLock,
        },
      })
    ).toBe(0);
    expect(captured).toEqual([12_345]);
    expect(listener.calls).toEqual([
      "graph inspect",
      "runtime status",
      "runtime probe",
      "review",
      "graph inspect",
    ]);
    expect(f.events).toEqual(["retire", "finalized", "up.before"]);
    expect(await loadNativeProjectRun(retainedScope)).toEqual(run);
    expect(await loadNativeRestartIntent(retainedScope)).toBeNull();
  } finally {
    await rm(listener.directory, { recursive: true, force: true });
  }
});

test("cleaned intent cannot bypass live, uncertain, foreign or malformed retained graph observations", async () => {
  const listener = await listenerIntentFixture();
  try {
    const stopped = stoppedRetainedGraph();
    const invalid: unknown[] = [
      null,
      { ...stopped, journal_incomplete: true },
      { ...stopped, receipt: { ...stopped.receipt, phase: "ready-observed" } },
      ...["run", "owner", "namespace", "plan_id"].map((field) => ({
        ...stopped,
        receipt: { ...stopped.receipt, [field]: "foreign" },
      })),
      ...["container:app", "network:default"].map((key) => ({
        ...stopped,
        observations: { ...stopped.observations, [key]: { state: "present" } },
      })),
      ...["absent", "uncertain"].map((state) => ({
        ...stopped,
        observations: { ...stopped.observations, "volume:data": { state } },
      })),
      {
        ...stopped,
        observations: {
          ...stopped.observations,
          "container:other": { state: "absent" },
        },
      },
      {
        ...stopped,
        observations: {
          "container:app": stopped.observations["container:app"],
          "network:default": stopped.observations["network:default"],
        },
      },
      ...[["container"], { kind: "container" }, "unknown"].map((kind) => ({
        ...stopped,
        receipt: {
          ...stopped.receipt,
          resources: {
            ...stopped.receipt.resources,
            app: { key: "app", kind },
          },
        },
      })),
      {
        ...stopped,
        receipt: {
          ...stopped.receipt,
          resources: {
            ...stopped.receipt.resources,
            duplicate: stopped.receipt.resources.app,
          },
        },
      },
      {
        ...stopped,
        receipt: { ...stopped.receipt, resources: {} },
        observations: {},
      },
    ];
    for (const observed of invalid) {
      listener.calls.length = 0;
      const f = fixture({ run, finalization: token, phase: "cleaned" });
      await expect(
        restartNativeProject({
          ...f.options,
          preflight: async (selected, { cleanedRetry }) =>
            await preflightNativeRestart({
              ...listener.options,
              run: selected,
              cleanedRetry,
              dependencies: {
                ...listener.options.dependencies,
                invoke: async ({ args }) => {
                  listener.calls.push(`${args[0]} ${args[1]}`);
                  return observed;
                },
              },
            }),
          dependencies: { ...f.options.dependencies, load: async () => run },
        })
      ).rejects.toThrow("cannot confirm the stopped retained graph");
      expect(listener.calls).toEqual(["graph inspect"]);
      expect(f.events).toEqual([]);
      expect(f.state.pending?.phase).toBe("cleaned");
    }
    const f = fixture({ run, finalization: token, phase: "cleaned" });
    await expect(
      restartNativeProject({
        ...f.options,
        preflight: async (selected, { cleanedRetry }) =>
          await preflightNativeRestart({
            ...listener.options,
            run: selected,
            cleanedRetry,
            dependencies: {
              ...listener.options.dependencies,
              invoke: async () => {
                throw new Error("sensitive fixture failure");
              },
            },
          }),
        dependencies: { ...f.options.dependencies, load: async () => run },
      })
    ).rejects.toThrow("cannot confirm the stopped retained graph");
    expect(f.events).toEqual([]);
  } finally {
    await rm(listener.directory, { recursive: true, force: true });
  }
});

test("active restart still refuses absent or wrong-executable listeners before cleanup", async () => {
  const listener = await listenerIntentFixture();
  try {
    const f = fixture();
    await expect(
      restartNativeProject({
        ...f.options,
        preflight: async (selected, { cleanedRetry }) => {
          expect(cleanedRetry).toBe(false);
          await preflightNativeRestart({
            ...listener.options,
            run: selected,
            cleanedRetry,
          });
        },
      })
    ).rejects.toThrow("bounded explicit listener selection; values omitted");
    expect(listener.calls).toEqual([
      "runtime status",
      "runtime probe",
      "graph dependency-discover",
    ]);
    expect(f.events).toEqual([]);
    expect(f.state.pending).toBeNull();
  } finally {
    await rm(listener.directory, { recursive: true, force: true });
  }
});

test("malformed dependency intent refuses cleaned retry without capture or startup hooks", async () => {
  const listener = await listenerIntentFixture();
  try {
    for (const binding of [
      { ...listener.selection.dependencies[0], host_executable: "relative" },
      { ...listener.selection.dependencies[0], aliases: ["127.0.0.1"] },
      { ...listener.selection.dependencies[0], host_pid: 0 },
      {
        ...listener.selection.dependencies[0],
        unexpected: "sensitive-fixture-value",
      },
    ]) {
      listener.calls.length = 0;
      await writeFile(
        listener.path,
        JSON.stringify({ version: 1, dependencies: [binding] })
      );
      const f = fixture({ run, finalization: token, phase: "cleaned" });
      await expect(
        restartNativeProject({
          ...f.options,
          preflight: async (selected, { cleanedRetry }) =>
            await preflightNativeRestart({
              ...listener.options,
              run: selected,
              cleanedRetry,
            }),
        })
      ).rejects.toThrow("dependency intent is invalid; values omitted");
      expect(listener.calls).toEqual([
        "graph inspect",
        "runtime status",
        "runtime probe",
      ]);
      expect(f.events).toEqual([]);
      expect(f.state.pending?.phase).toBe("cleaned");
    }
  } finally {
    await rm(listener.directory, { recursive: true, force: true });
  }
});

test("active legacy restart preserves adapted labels and rechecks authenticated selection before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-active-review-"));
  try {
    const projectRoot = await realpath(root);
    for (const drift of [false, true]) {
      const f = fixture();
      const scoped = {
        ...scope,
        projectRoot,
        projectDir: join(projectRoot, ".hack"),
        branch: "feature-a",
      };
      const calls: string[] = [];
      let compatible = false;
      const input = {
        originalSha256: "1".repeat(64),
        environmentFiles: [],
        serviceNames: ["app"],
        normalizedComposeJson: JSON.stringify({
          services: {
            app: {
              image: `sha256:${"a".repeat(64)}`,
              labels: {
                caddy: "app.hack, app.hack.gy",
                "caddy.tls": "internal",
                "caddy.reverse_proxy": "{{upstreams 3000}}",
              },
            },
          },
        }),
        managedEnvironment: {},
        lifecycleHostEnvironment: {},
        effectiveEnvName: "qa",
      };
      const result = restartNativeProject({
        ...f.options,
        scope: scoped,
        preflight: async () =>
          await preflightNativeRestart({
            runtime: { binary: "/unused", home: "/candidate" },
            scope: scoped,
            composeFile: join(projectRoot, "compose.yml"),
            run,
            dependencies: {
              prepare: async () => input,
              adapt: async ({ input: value }) => value,
              dependencies: async () => [],
              invoke: async ({ args }) => {
                calls.push(args[1] ?? "unknown");
                if (args[1] === "status") {
                  return { network: "internet" };
                }
                if (args[1] === "probe") {
                  return { admitted: true };
                }
                if (args[0] === "project") {
                  if (args.includes("--normalized-file")) {
                    const value = JSON.parse(
                      await readFile(
                        args[args.indexOf("--normalized-file") + 1] ?? "",
                        "utf8"
                      )
                    );
                    expect(value.services.app.labels.caddy).toBe(
                      "app.hack, app.hack.gy"
                    );
                    expect(args).not.toContain("--branch");
                  }
                  return {
                    plan_id: "e".repeat(64),
                    plan: {
                      source: projectRoot,
                      namespace: args.includes("--branch")
                        ? "f".repeat(64)
                        : run.namespace,
                      compose_sha256: input.originalSha256,
                      services: { app: { active: true } },
                    },
                  };
                }
                if (args[1] === "run-selection") {
                  expect(args[args.indexOf("--service") + 1]).toBe("app");
                  return {
                    ok: true,
                    run: run.run,
                    owner: run.owner,
                    namespace: run.namespace,
                    plan: run.planId,
                    service: "app",
                    container: "2".repeat(64),
                    boot: compatible && drift ? "changed-boot" : "owned-boot",
                    generation: "3".repeat(64),
                  };
                }
                if (args[1] === "source-compatibility") {
                  compatible = true;
                  return {
                    run: run.run,
                    owner: run.owner,
                    namespace: run.namespace,
                    plan: run.planId,
                    reviewed_plan: "e".repeat(64),
                    source_revision: null,
                  };
                }
                throw new Error("Unexpected effect");
              },
            },
          }),
      });
      if (drift) {
        await expect(result).rejects.toThrow("active review identity changed");
        expect(f.events).toEqual([]);
      } else {
        expect(await result).toBe(0);
        expect(f.events).toContain("down");
      }
      expect(calls.at(-1)).toBe("run-selection");
      expect(calls.filter((action) => action === "run-selection")).toHaveLength(
        3
      );
      expect(calls).not.toContain("restore-selection");
      expect(calls).not.toContain("run-service");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
