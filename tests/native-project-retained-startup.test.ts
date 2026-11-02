import { expect, test } from "bun:test";
import {
  preflightNativeRetainedStartup,
  verifyNativeResumedRetainedGraph,
  verifyNativeRetainedMapping,
} from "../src/backends/native-project-retained-startup.ts";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";
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
