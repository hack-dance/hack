import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshNativeProjectDependencies } from "../src/backends/native-project-dependency-refresh.ts";
import {
  loadNativeProjectRun,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

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
function response() {
  return {
    ok: true,
    run: run.run,
    owner: run.owner,
    namespace: run.namespace,
    plan: run.planId,
    generation: "e".repeat(64),
    changed_slots: [] as number[],
  };
}
async function fixture(saved = true) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-dependency-refresh-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome);
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  if (saved) {
    await saveNativeProjectRun({ ...scope, run });
  }
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}

test("refresh validates the owned no-op or bounded changed slots with one public request", async () => {
  const opts = await fixture();
  for (const changedSlots of [
    [],
    [3, 0],
    Array.from({ length: 32 }, (_, n) => n),
  ]) {
    let calls = 0;
    const result = await refreshNativeProjectDependencies({
      ...opts,
      invoke: async (request) => {
        calls++;
        expect(request).toEqual({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: [
            "graph",
            "refresh-dependencies",
            "--run-id",
            run.run,
            "--json",
          ],
          timeoutMs: 180_000,
        });
        return { ...response(), changed_slots: changedSlots };
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({
      mapping: run,
      generation: response().generation,
      changedSlots,
    });
    expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  }
});

test("missing owned mapping never invokes refresh", async () => {
  const opts = await fixture(false);
  let calls = 0;
  await expect(
    refreshNativeProjectDependencies({
      ...opts,
      invoke: async () => {
        calls++;
        return response();
      },
    })
  ).rejects.toThrow("not been started");
  expect(calls).toBe(0);
});

test("foreign identities and malformed refresh outcomes refuse without replay or diagnostics", async () => {
  const opts = await fixture();
  const invalid: unknown[] = [null, [], {}, { ...response(), ok: false }];
  for (const key of ["run", "plan", "owner", "namespace"]) {
    invalid.push({ ...response(), [key]: "foreign-private-value" });
  }
  for (const generation of [
    null,
    7,
    "e".repeat(63),
    "E".repeat(64),
    "g".repeat(64),
  ]) {
    invalid.push({ ...response(), generation });
  }
  for (const slots of [
    null,
    "0",
    [-1],
    [32],
    [0.5],
    ["0"],
    [Number.NaN],
    [0, 0],
    Array.from({ length: 33 }, (_, n) => n),
  ]) {
    invalid.push({ ...response(), changed_slots: slots });
  }
  for (const value of invalid) {
    let calls = 0;
    let failure: unknown;
    try {
      await refreshNativeProjectDependencies({
        ...opts,
        invoke: async () => {
          calls++;
          return value;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("identity or outcome is unconfirmed");
    expect(String(failure)).not.toContain("private-value");
    expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  }
});

test("lost refresh reply omits subprocess diagnostics and never replays", async () => {
  const opts = await fixture();
  let calls = 0;
  let failure: unknown;
  try {
    await refreshNativeProjectDependencies({
      ...opts,
      invoke: async () => {
        calls++;
        throw new Error("synthetic-private-subprocess-diagnostic");
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(calls).toBe(1);
  expect(String(failure)).toContain("No request or command was replayed");
  expect(String(failure)).not.toContain("synthetic-private");
});

test("refresh preserves only allowlisted native codes without replay or raw diagnostics", async () => {
  const opts = await fixture();
  for (const [nativeCode, nativeCauseCode, diagnostic] of [
    ["provider_busy", undefined, "Native diagnostic: provider_busy."],
    [
      "graph_owner_recovery",
      "graph_dependency_rebind_incomplete",
      "Native diagnostic: graph_owner_recovery: graph_dependency_rebind_incomplete.",
    ],
  ] as const) {
    let calls = 0;
    let failure: unknown;
    try {
      await refreshNativeProjectDependencies({
        ...opts,
        invoke: async () => {
          calls++;
          throw new NativeRuntimeRequestError({
            message: "private stderr /private/fixture token=secret-input",
            nativeCode,
            nativeCauseCode,
          });
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(calls).toBe(1);
    expect(String(failure)).toContain(diagnostic);
    expect(String(failure)).toContain("No request or command was replayed");
    expect(String(failure)).not.toContain("private stderr");
    expect(String(failure)).not.toContain("/private/fixture");
    expect(String(failure)).not.toContain("secret-input");
    expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
  }
});

test("refresh omits unknown, malformed and forged diagnostic identifiers", async () => {
  const opts = await fixture();
  const privateValues = [
    "synthetic_private_value",
    "provider_busy\nsecret-input",
    "/private/fixture",
    "p".repeat(4096),
  ];
  for (const value of privateValues) {
    for (const nativeCode of ["provider_busy", value]) {
      let calls = 0;
      let failure: unknown;
      try {
        await refreshNativeProjectDependencies({
          ...opts,
          invoke: async () => {
            calls++;
            throw new NativeRuntimeRequestError({
              message: "private raw diagnostic",
              nativeCode,
              nativeCauseCode: value,
            });
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(calls).toBe(1);
      expect(String(failure)).not.toContain(value);
      expect(String(failure)).not.toContain("private raw diagnostic");
      expect(String(failure).includes("Native diagnostic:")).toBe(
        nativeCode === "provider_busy"
      );
    }
  }
  await expect(
    refreshNativeProjectDependencies({
      ...opts,
      invoke: async () => {
        throw Object.assign(new Error("private forged diagnostic"), {
          nativeCode: "provider_busy",
          nativeCauseCode: "provider_state",
        });
      },
    })
  ).rejects.not.toThrow("Native diagnostic:");
});

test("mapping removal, replacement or selector drift during refresh cannot authorize traffic", async () => {
  for (const change of ["removed", "run", "selector"]) {
    const opts = await fixture();
    let calls = 0;
    await expect(
      refreshNativeProjectDependencies({
        ...opts,
        invoke: async () => {
          calls++;
          await removeNativeProjectRun({ ...opts.scope, expected: run });
          if (change !== "removed") {
            await saveNativeProjectRun({
              ...opts.scope,
              run:
                change === "run"
                  ? { ...run, run: "1".repeat(32) }
                  : { ...run, effectiveEnvName: "qa" },
            });
          }
          return response();
        },
      })
    ).rejects.toThrow("identity or outcome is unconfirmed");
    expect(calls).toBe(1);
  }
});
