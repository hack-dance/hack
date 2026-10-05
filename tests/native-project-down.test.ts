import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  type NativeProjectRunScope,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";

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
  await expect(result).rejects.toThrow("frontend finalization is unconfirmed");
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
  await expect(
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
    })
  ).rejects.toThrow("ownership changed");
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
    await expect(
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
      })
    ).rejects.toThrow("frontend finalization is unconfirmed");
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
  await expect(
    nativeProjectDown({
      ...opts,
      finalizationTimeoutMs: 1,
      invoke: async (request) => {
        calls.push(request.args[1]!);
        return snapshot(true);
      },
    })
  ).rejects.toThrow("frontend finalization is unconfirmed");
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
  await expect(
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
    })
  ).rejects.toThrow("unconfirmed");
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
  await expect(
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
    })
  ).rejects.toThrow("unconfirmed");
  expect(calls).toBe(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("native down rejects unsupported flags before project or runtime access", async () => {
  for (const args of [
    ["--env", "qa"],
    ["--profile", "web"],
    ["--prune-caches"],
    ["--yes"],
    ["--target", "remote"],
  ]) {
    const child = Bun.spawn([process.execPath, "index.ts", "down", ...args], {
      env: {
        ...process.env,
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_HOME: "/nonexistent-native-home",
        HACK_NATIVE_BINARY: "/nonexistent-native-binary",
      },
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
      env: {
        ...process.env,
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_HOME: opts.scope.nativeHome,
        HACK_NATIVE_BINARY: "/nonexistent-native-binary",
      },
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
  await expect(
    nativeDownEnvironment({
      scope: opts.scope,
      run: { ...run, effectiveEnvName: "qa" },
      serviceNames: ["web"],
    })
  ).rejects.toThrow("unavailable");
  await expect(
    nativeDownEnvironment({ scope: opts.scope, run, serviceNames: ["web"] })
  ).rejects.toThrow("legacy");
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
      env: {
        ...process.env,
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_HOME: opts.scope.nativeHome,
        HACK_NATIVE_BINARY: binary,
      },
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
  await expect(
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
    })
  ).rejects.toThrow("Native retaining shutdown is incomplete");
  expect(calls).toEqual(["inspect"]);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("stopped receipt with a remaining container preserves mapping", async () => {
  const opts = await fixture();
  await expect(
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
    })
  ).rejects.toThrow("unconfirmed");
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
