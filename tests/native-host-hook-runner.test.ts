import { afterEach, test as bunTest, expect } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withNativeAuthoredProjectAdmission } from "../src/backends/native-authored-project-run.ts";
import type { NativeEnvironmentPlan } from "../src/lib/native-env-plan-protocol.ts";
import {
  prepareNativeFiniteHookPhase,
  selectNativeFiniteHooks,
} from "../src/lib/native-host-hook-runner.ts";

const roots: string[] = [];
let activeCases = 0;
let unconfirmed = false;
function test(
  name: string,
  body: () => void | Promise<void>,
  timeout?: number
) {
  bunTest(
    name,
    async () => {
      if (unconfirmed) {
        throw new Error("Hook fixture settlement unconfirmed; roots retained.");
      }
      activeCases++;
      try {
        await body();
      } catch (error) {
        unconfirmed = true;
        throw error;
      } finally {
        activeCases--;
      }
    },
    timeout
  );
}
afterEach(async () => {
  if (activeCases !== 0) {
    unconfirmed = true;
  }
  if (unconfirmed) {
    return;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-finite-hooks-"))
  );
  roots.push(root);
  const projectDir = join(root, ".hack");
  const nativeHome = join(root, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  return { projectRoot: root, projectDir, nativeHome, branch: null };
}
const complete = {
  outcome: "complete",
  exitCode: 0,
  timedOut: false,
  canceled: false,
} as const;
function report(names: readonly string[]): NativeEnvironmentPlan {
  return {
    plan_version: 1,
    overlay: null,
    overlay_exists: false,
    complete: true,
    workloads: {},
    warnings: [],
    diagnostics: [],
    host: Object.fromEntries(
      names.map((name) => [
        name,
        { env_target: { kind: "host" }, bindings: {} },
      ])
    ),
  };
}
test("four finite phases preserve exec bytes, order, private append-only intent and known completion", async () => {
  const scope = await fixture();
  const phases = [
    "up.before",
    "up.after",
    "down.before",
    "down.after",
  ] as const;
  const hooks = selectNativeFiniteHooks({
    host: Object.fromEntries(
      ["up", "down"].map((phase) => [
        phase,
        Object.fromEntries(
          ["before", "after"].map((order) => [
            order,
            [
              {
                name: `${phase}-${order}`,
                env_target: { kind: "host" },
                command: {
                  exec: [
                    process.execPath,
                    "-e",
                    'const {appendFile}=await import("node:fs/promises"); await appendFile("order",process.argv[1]+"\\n");',
                    `${phase}.${order} $EXACT`,
                  ],
                },
              },
            ],
          ])
        ),
      ])
    ),
  });
  await withNativeAuthoredProjectAdmission(scope, async (admission) => {
    const owner = await admission.createHooks({
      run: "a".repeat(32),
      selectionHash: "b".repeat(64),
    });
    for (const phase of phases) {
      if (phase === "up.after") {
        await owner.graphEntered();
        const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
          detached: true,
          stdout: "ignore",
          stderr: "ignore",
        });
        await child.exited;
        await owner.graphChild(child.pid);
      }
      if (phase === "down.after") {
        await owner.graphRemoved();
      }
      const result = await owner.phase({
        phase,
        assertFresh: admission.assertHeld,
        beforeSpawn: () => undefined,
        prepare: () =>
          prepareNativeFiniteHookPhase({
            hooks: hooks[phase],
            report: report([phase.replace(".", "-")]),
            projectRoot: scope.projectRoot,
            signal: new AbortController().signal,
            remaining: () => 3000,
            assertFresh: admission.assertHeld,
            resolveHostValues: async () => ({}),
            beforeSpawn: () => undefined,
            onSpawn: owner.child,
          }),
      });
      expect(result).toEqual(complete);
    }
    expect(await readFile(join(scope.projectRoot, "order"), "utf8")).toBe(
      phases.map((phase) => `${phase} $EXACT\n`).join("")
    );
    expect(await admission.hooksRetained()).toBe(true);
    await owner.retire();
    expect(await admission.hooksRetained()).toBe(false);
  });
  const files = await readdir(
    join(scope.projectDir, ".internal/native-authored-runs")
  );
  expect(files.filter((name) => name.endsWith("-intent.json"))).toHaveLength(4);
  expect(files.filter((name) => name.endsWith("-complete.json"))).toHaveLength(
    4
  );
});
test("persistent process intent refuses instead of being discarded", () => {
  expect(() =>
    selectNativeFiniteHooks({
      host: { processes: { web: { command: { exec: ["true"] } } } },
    })
  ).toThrow();
});
test("finite hook admission preserves phases larger than the removed journal cap", () => {
  const hooks = Array.from({ length: 1025 }, (_, index) => ({
    name: `hook-${index}`,
    command: { exec: ["true"] },
    env_target: { kind: "host" },
  }));
  expect(
    selectNativeFiniteHooks({ host: { up: { before: hooks } } })["up.before"]
  ).toHaveLength(1025);
});
test("active cancellation settles resistant owned hook group before recording known completion", async () => {
  const scope = await fixture();
  const controller = new AbortController();
  let group = 0;
  const execute = await prepareNativeFiniteHookPhase({
    hooks: [
      {
        name: "resistant",
        env_target: { kind: "host" },
        command: {
          exec: [
            process.execPath,
            "-e",
            'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);',
          ],
        },
      },
    ],
    report: report(["resistant"]),
    projectRoot: scope.projectRoot,
    signal: controller.signal,
    remaining: () => 3000,
    assertFresh: async () => undefined,
    resolveHostValues: async () => ({}),
    beforeSpawn: () => undefined,
    onSpawn: async (pid) => {
      group = pid;
      setTimeout(() => controller.abort(), 100);
    },
  });
  const result = await execute();
  expect(result.outcome).toBe("complete");
  expect(result.canceled).toBe(true);
  expect(group).toBeGreaterThan(0);
  expect(() => process.kill(-group, 0)).toThrow();
}, 10_000);
test("unknown child capture retains intent and blocks new owner and retirement", async () => {
  const scope = await fixture();
  await withNativeAuthoredProjectAdmission(scope, async (admission) => {
    const owner = await admission.createHooks({
      run: "a".repeat(32),
      selectionHash: "b".repeat(64),
    });
    const result = await owner.phase({
      phase: "up.before",
      assertFresh: admission.assertHeld,
      beforeSpawn: () => undefined,
      prepare: async () => async () => ({ ...complete, outcome: "uncertain" }),
    });
    expect(result.outcome).toBe("uncertain");
    await expect(owner.retire()).rejects.toThrow("retained");
    await expect(
      owner.permit({ role: "execution", semanticHash: "c".repeat(64) })
    ).rejects.toThrow();
    await expect(
      admission.createHooks({
        run: "d".repeat(32),
        selectionHash: "b".repeat(64),
      })
    ).rejects.toThrow();
  });
});
test("pre-aborted finite hook refuses with zero spawn", async () => {
  const scope = await fixture();
  const controller = new AbortController();
  controller.abort();
  let spawns = 0;
  const execute = await prepareNativeFiniteHookPhase({
    hooks: [
      {
        name: "before",
        env_target: { kind: "host" },
        command: { exec: [process.execPath, "-e", "process.exit(0)"] },
      },
    ],
    report: report(["before"]),
    projectRoot: scope.projectRoot,
    signal: controller.signal,
    remaining: () => 1000,
    assertFresh: async () => undefined,
    resolveHostValues: async () => ({}),
    beforeSpawn: () => undefined,
    onSpawn: async () => {
      spawns++;
    },
  });
  expect((await execute()).outcome).toBe("uncertain");
  expect(spawns).toBe(0);
});
test("recovery journal gate accepts known completion and retains unknown intent without replay", async () => {
  const { withNativeAuthoredProjectRecoveryStorage } = await import(
    "../src/backends/native-authored-project-run.ts"
  );
  for (const known of [true, false]) {
    const scope = await fixture();
    const run = "e".repeat(32);
    await withNativeAuthoredProjectAdmission(scope, async (admission) => {
      const owner = await admission.createHooks({
        run,
        selectionHash: "f".repeat(64),
      });
      await owner.phase({
        phase: "up.before",
        assertFresh: admission.assertHeld,
        beforeSpawn: () => undefined,
        prepare: async () => async () => ({
          ...complete,
          outcome: known ? "complete" : "uncertain",
        }),
      });
    });
    if (known) {
      await withNativeAuthoredProjectRecoveryStorage(scope, (store) =>
        store.retireHooks(run)
      );
      await withNativeAuthoredProjectAdmission(scope, async (admission) => {
        expect(await admission.hooksRetained()).toBe(false);
      });
    } else {
      await expect(
        withNativeAuthoredProjectRecoveryStorage(scope, (store) =>
          store.retireHooks(run)
        )
      ).rejects.toThrow();
      await withNativeAuthoredProjectAdmission(scope, async (admission) => {
        expect(await admission.hooksRetained()).toBe(true);
      });
    }
  }
});
test("phase preparation captures every selected managed binding before spawn and preserves target, cwd and unset", async () => {
  const scope = await fixture();
  await mkdir(join(scope.projectRoot, "selected"));
  const prior = process.env.NATIVE_HOOK_DROP;
  process.env.NATIVE_HOOK_DROP = "inherited-canary";
  const names = ["first", "second"];
  const selectedReport = report(names);
  const host = Object.fromEntries(
    names.map((name) => [
      name,
      {
        env_target: { kind: "workload" as const, name: "web" },
        bindings: {
          TOKEN: {
            kind: "managed" as const,
            key: "SOURCE",
            scope: "web",
            secret: true,
          },
        },
      },
    ])
  );
  const acquisitions: string[] = [];
  let spawns = 0;
  try {
    const execute = await prepareNativeFiniteHookPhase({
      hooks: names.map((name) => ({
        name,
        cwd: "selected",
        env_target: { kind: "workload" as const, name: "web" },
        environment: {
          TOKEN: { env_ref: "SOURCE" },
          NATIVE_HOOK_DROP: { unset: true },
        },
        command: {
          exec: [
            process.execPath,
            "-e",
            'const {appendFile}=await import("node:fs/promises"); await appendFile("observed",JSON.stringify({token:process.env.TOKEN,drop:process.env.NATIVE_HOOK_DROP??null})+"\\n");',
          ],
        },
      })),
      report: { ...selectedReport, host },
      projectRoot: scope.projectRoot,
      signal: new AbortController().signal,
      remaining: () => 3000,
      assertFresh: async () => undefined,
      resolveHostValues: async (name) => {
        acquisitions.push(name);
        return { SOURCE: "private-test-canary" };
      },
      beforeSpawn: () => undefined,
      onSpawn: async () => {
        spawns++;
        expect(acquisitions).toEqual(names);
      },
    });
    const result = await execute();
    expect(result).toEqual(complete);
    expect(spawns).toBe(2);
    expect(
      (await readFile(join(scope.projectRoot, "selected/observed"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { token: "private-test-canary", drop: null },
      { token: "private-test-canary", drop: null },
    ]);
  } finally {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, "NATIVE_HOOK_DROP");
    } else {
      process.env.NATIVE_HOOK_DROP = prior;
    }
  }
});
test("a live captured foreground group blocks hook journal retirement and recovery", async () => {
  const scope = await fixture();
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    { detached: true, stdout: "ignore", stderr: "ignore" }
  );
  const { withNativeAuthoredProjectRecoveryStorage } = await import(
    "../src/backends/native-authored-project-run.ts"
  );
  const run = "9".repeat(32);
  try {
    await withNativeAuthoredProjectAdmission(scope, async (admission) => {
      const owner = await admission.createHooks({
        run,
        selectionHash: "a".repeat(64),
      });
      await owner.phase({
        phase: "up.before",
        assertFresh: admission.assertHeld,
        beforeSpawn: () => undefined,
        prepare: async () => async () => complete,
      });
      await owner.graphEntered();
      await owner.graphChild(child.pid);
      await owner.graphRemoved();
      await expect(owner.retire()).rejects.toThrow("retained");
    });
    await expect(
      withNativeAuthoredProjectRecoveryStorage(scope, (store) =>
        store.retireHooks(run)
      )
    ).rejects.toThrow(
      "Native authored run artifact is unsafe, changed, or owned by another run; inspect native state before retrying. Values omitted."
    );
    child.kill("SIGTERM");
    await child.exited;
    await withNativeAuthoredProjectRecoveryStorage(scope, (store) =>
      store.retireHooks(run)
    );
    await withNativeAuthoredProjectAdmission(scope, async (admission) => {
      expect(await admission.hooksRetained()).toBe(false);
    });
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});
