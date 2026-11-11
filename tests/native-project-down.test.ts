import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
  nativeDownEnvironment,
  nativeProjectDown,
} from "../src/backends/native-project-down.ts";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  markSharedHelperInstanceStopping,
  type ProjectSharedHelperConfig,
} from "../src/lib/project-shared-helpers.ts";
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
      return snapshot(true);
    },
  });
  await expectClosedRefusal(result, "frontend finalization is unconfirmed");
  await expectClosedRefusal(
    result,
    `hack restart --recover-frontend --expect-finalization-attempt ${token.attempt}`
  );
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(calls).toEqual(["inspect"]);
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
    expect(stdout + stderr).toContain("Native project is not started");
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

test("down without --recover names the recovery when the foreground owner is gone", async () => {
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
    "run hack down --recover"
  );
  expect(calls).toEqual(["inspect", "inspect", "cleanup"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test.each([
  { enrollment: false, label: "ready owner" },
  { enrollment: true, label: "legacy pending cleanup" },
])("down --recover stops $label selected by its exact receipt", async ({
  enrollment,
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
        return ownerSelection("exited");
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
    name: "an owner that exited after its restore was admitted",
    selection: ownerSelection("exited", "failed-retained"),
    text: "no supported command can prove and retire that attempt yet",
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

test("down --recover names the exact frontend recovery when the owning frontend also exited", async () => {
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
  await expectClosedRefusal(
    nativeProjectDown({
      ...opts,
      recover: true,
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
        return snapshot(recovered);
      },
    }),
    `hack restart --recover-frontend --expect-finalization-attempt ${attempt}`
  );
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
  false,
  true,
])("down --recover dispatches the pinned predecessor boot and resumes retirement (stopped=%s)", async (stopped) => {
  const opts = await fixture();
  const calls: string[] = [];
  let cleaned = stopped;
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
        return { run: run.run, recovered: true, data_retained: true };
      }
      if (request.args[1] === "retire-recovered-publisher") {
        expect(cleaned).toBe(true);
        return { run: run.run, publisher_retired: true, data_retained: true };
      }
      expect(request.args[1]).toBe("inspect");
      return snapshot(cleaned);
    },
  });
  expect(result.status).toBe("stopped");
  expect(calls.includes("recover-cleanup")).toBe(!stopped);
  expect(calls).toContain("retire-recovered-publisher");
  expect(calls).not.toContain("recover-live-owner");
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
    "No safe cleanup command can proceed"
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
