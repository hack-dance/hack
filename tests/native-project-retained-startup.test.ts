import { expect, test } from "bun:test";
import {
  preflightNativeRetainedStartup,
  runtimeUpJoiningChangedPool,
  verifyNativeResumedRetainedGraph,
  verifyNativeRetainedMapping,
} from "../src/backends/native-project-retained-startup.ts";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";

/**
 * Retained-startup refusals are integrity or ownership outcomes: closed,
 * value-free messages that the CLI prints without a stack.
 */

const runtime = { binary: "/fixture/native", home: "/fixture/home" };
const scope = {
  projectRoot: "/fixture/project",
  projectDir: "/fixture/project/.hack",
  nativeHome: "/fixture/home",
  branch: null,
};
const run: NativeProjectRun = {
  run: "1".repeat(32),
  owner: "2".repeat(32),
  namespace: "3".repeat(64),
  planId: "4".repeat(64),
};
const eligible = {
  version: 1,
  run: run.run,
  owner: run.owner,
  namespace: run.namespace,
  plan: run.planId,
  live_resources_verified: false,
  runtime_phase: "stopped",
  selection: "5".repeat(64),
};

test("eligible retained startup selects the retained run", async () => {
  expect(
    await preflightNativeRetainedStartup({
      runtime,
      projectRoot: scope.projectRoot,
      run,
      invoke: async () => eligible,
    })
  ).toEqual({
    runtimePhase: "stopped",
    flags: [
      "--expect-retained-run",
      run.run,
      "--expect-retained-selection",
      eligible.selection,
    ],
  });
});

test("a retained run stays startable from the stopped phases the runtime accepts after a failed boot (HACK-2376)", async () => {
  for (const phase of [
    "stopped",
    "recovered-unclean",
    "stopped-before-engine",
    "stopped-after-engine-failure",
  ]) {
    expect(
      (
        await preflightNativeRetainedStartup({
          runtime,
          projectRoot: scope.projectRoot,
          run,
          invoke: async () => ({ ...eligible, runtime_phase: phase }),
        })
      ).runtimePhase
    ).toBe("stopped");
  }
  expect(
    (
      await preflightNativeRetainedStartup({
        runtime,
        projectRoot: scope.projectRoot,
        run,
        invoke: async () => ({ ...eligible, runtime_phase: "running" }),
      })
    ).runtimePhase
  ).toBe("running");
  // Any other phase is not an eligible retained start.
  for (const phase of ["failed-boot-stopped", "booting", "quiescing", "", 7]) {
    await expectClosedRefusal(
      preflightNativeRetainedStartup({
        runtime,
        projectRoot: scope.projectRoot,
        run,
        invoke: async () => ({ ...eligible, runtime_phase: phase }),
      }),
      "Native retained startup eligibility changed; no hooks or runtime start were requested."
    );
  }
});

test("changed retained eligibility refuses with a closed message", async () => {
  await expectClosedRefusal(
    preflightNativeRetainedStartup({
      runtime,
      projectRoot: scope.projectRoot,
      run,
      invoke: async () => ({ ...eligible, owner: "9".repeat(32) }),
    }),
    "Native retained startup eligibility changed; no hooks or runtime start were requested."
  );
});

test("a canceled retained startup refuses before any request", async () => {
  let calls = 0;
  await expectClosedRefusal(
    preflightNativeRetainedStartup({
      runtime,
      projectRoot: scope.projectRoot,
      run,
      signal: AbortSignal.abort(),
      invoke: async () => {
        calls++;
        return eligible;
      },
    }),
    "Native retained startup was canceled"
  );
  expect(calls).toBe(0);
});

test("a retained mapping changed before runtime start refuses", async () => {
  await expectClosedRefusal(
    verifyNativeRetainedMapping({
      run,
      scope,
      load: async () => ({ ...run, owner: "9".repeat(32) }),
    }),
    "Native retained run mapping changed before runtime start; no start was requested."
  );
});

test("a resumed retained graph that differs refuses", async () => {
  await expectClosedRefusal(
    verifyNativeResumedRetainedGraph({
      runtime,
      projectRoot: scope.projectRoot,
      run,
      invoke: async () => ({ journal_incomplete: false, receipt: {} }),
    }),
    "Native resumed retained graph differs; no graph restore was requested."
  );
});

test("a changed pool is retried only for a retained start, once (HACK-2732)", async () => {
  const changed = () =>
    new NativeRuntimeRequestError({
      nativeCode: "graph_retained_pool_changed",
      message: "Native runtime request failed (graph_retained_pool_changed).",
    });
  const calls: (readonly string[])[] = [];
  // A fresh start sends no retained flags: nothing is selected again.
  await expect(
    runtimeUpJoiningChangedPool({
      flags: [],
      up: async (flags) => {
        calls.push(flags);
        throw changed();
      },
      reselect: async () => {
        throw new Error("not selected again");
      },
    })
  ).rejects.toMatchObject({ nativeCode: "graph_retained_pool_changed" });
  expect(calls).toEqual([[]]);
  calls.length = 0;
  expect(
    await runtimeUpJoiningChangedPool({
      flags: ["--expect-retained-selection", "7"],
      up: async (flags) => {
        calls.push(flags);
        if (calls.length === 1) {
          throw changed();
        }
        return "joined";
      },
      reselect: async () => ["--expect-retained-selection", "8"],
    })
  ).toBe("joined");
  expect(calls).toEqual([
    ["--expect-retained-selection", "7"],
    ["--expect-retained-selection", "8"],
  ]);
});
