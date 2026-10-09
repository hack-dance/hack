import type { acquireNativeExecutionInputs } from "../lib/native-execution-inputs.ts";
import {
  type NativeFiniteHooks,
  type NativeHookPhase,
  type NativeHookResult,
  prepareNativeFiniteHookPhase,
} from "../lib/native-host-hook-runner.ts";
import type { NativeAuthoredReceipt } from "./native-authored-graph-protocol.ts";
import type { NativeAuthoredHookOwner } from "./native-authored-hook-journal.ts";
import { serveNativeHookStop } from "./native-authored-hook-stop.ts";
import type {
  NativeAuthoredProjectAdmission,
  NativeAuthoredProjectRunSelection,
  NativeAuthoredProjectSource,
  NativeAuthoredProjectStartSelection,
} from "./native-authored-project-run.ts";

type Inputs = Awaited<ReturnType<typeof acquireNativeExecutionInputs>>;
export type NativeHookDiagnostic = {
  readonly phase: NativeHookPhase;
  readonly boundary:
    | "acquire"
    | "prepare"
    | "complete"
    | "failed"
    | "stop-request"
    | "stop-owner"
    | "stop-client"
    | "stop-operation";
  readonly compilerCode?: string;
};
export type NativeAuthoredStartupAttempt = {
  readonly source: NativeAuthoredProjectSource;
  readonly start: NativeAuthoredProjectStartSelection;
  observed?: NativeAuthoredReceipt;
  ready?: NativeAuthoredProjectRunSelection;
};
function freeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
}
export function hookSelection(inputs: Inputs): string {
  const plan = inputs.result.plan;
  return JSON.stringify({
    name: plan.name,
    source: plan.source,
    worktree: plan.worktree,
    profiles: plan.selected_profiles,
    host: plan.host,
  });
}
export function requireHookSuccess(result: NativeHookResult): void {
  if (
    result.outcome !== "complete" ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.canceled
  ) {
    throw new Error(
      "Native lifecycle hook did not complete successfully; values omitted."
    );
  }
}

const STOP_STAGES = {
  owner: "stop-owner",
  request: "stop-client",
  stop: "stop-operation",
} as const;
export function hookPhaseRunner(opts: {
  readonly owner: NativeAuthoredHookOwner | undefined;
  readonly hooks: NativeFiniteHooks | undefined;
  readonly readInputs: () => Inputs;
  readonly setInputs: (inputs: Inputs) => void;
  readonly identity: string;
  readonly acquire: (signal: AbortSignal) => Promise<Inputs>;
  readonly admission: NativeAuthoredProjectAdmission;
  readonly startup: AbortSignal;
  readonly hard: AbortSignal;
  readonly remaining: () => number;
  readonly projectRoot: string;
  readonly diagnostic: (error: unknown) => string | undefined;
  readonly stage: (value: NativeHookPhase) => void;
  readonly observe: (event: NativeHookDiagnostic) => void;
}): (name: NativeHookPhase) => Promise<NativeHookResult> {
  return async (name) => {
    const { owner, hooks } = opts;
    if (!(owner && hooks)) {
      throw new Error("Native hook owner unavailable; values omitted.");
    }
    const down = name.startsWith("down.");
    const signal = down ? opts.hard : opts.startup;
    opts.observe({ phase: name, boundary: "acquire" });
    if (down) {
      const current = await opts.acquire(signal);
      if (
        hookSelection(current) !== opts.identity ||
        current.result.semantic_hash !== opts.readInputs().result.semantic_hash
      ) {
        throw new Error("Native hook source changed; values omitted.");
      }
      opts.setInputs(current);
    }
    opts.stage(name);
    const fresh = async () => {
      if (name === "up.before") {
        const current = await opts.acquire(signal);
        if (
          hookSelection(current) !== opts.identity ||
          current.result.semantic_hash !==
            opts.readInputs().result.semantic_hash
        ) {
          throw new Error("Native hook selection changed; values omitted.");
        }
      } else {
        await opts.readInputs().assertFresh();
      }
      await opts.admission.assertHeld();
      await owner.assertFresh();
    };
    const budget = () => {
      if (signal.aborted) {
        throw new Error("Native hooks canceled; values omitted.");
      }
      return down ? undefined : opts.remaining();
    };
    opts.observe({ phase: name, boundary: "prepare" });
    try {
      const inputs = opts.readInputs();
      const result = await owner.phase({
        phase: name,
        assertFresh: fresh,
        beforeSpawn: () => {
          budget();
        },
        prepare: () =>
          prepareNativeFiniteHookPhase({
            hooks: hooks[name],
            report: inputs.result.environment_plan,
            projectRoot: opts.projectRoot,
            signal,
            remaining: budget,
            assertFresh: fresh,
            resolveHostValues: inputs.resolveHostValues,
            beforeSpawn: () => {
              budget();
            },
            onSpawn: owner.child,
          }),
      });
      opts.observe({ phase: name, boundary: "complete" });
      return result;
    } catch (error) {
      const code = opts.diagnostic(error);
      opts.observe({
        phase: name,
        boundary: "failed",
        compilerCode: code,
      });
      throw error;
    }
  };
}

export async function publishAuthoredReady(
  opts: {
    readonly run: string;
    readonly observe: (event: NativeHookDiagnostic) => void;
    readonly onReady: (value: NativeAuthoredProjectRunSelection) => void;
    readonly payload: () => Buffer | undefined;
    readonly admitted: NativeAuthoredStartupAttempt;
    readonly hookOwner: NativeAuthoredHookOwner | undefined;
    readonly phase: (name: NativeHookPhase) => Promise<NativeHookResult>;
    readonly inputs: () => Inputs;
    readonly admission: NativeAuthoredProjectAdmission;
    readonly remaining: () => number;
    readonly published: () => void;
    readonly stop: () => void;
    readonly stopped: Promise<boolean>;
    readonly endpoint: (
      value: Awaited<ReturnType<typeof serveNativeHookStop>>
    ) => void;
  },
  receipt: NativeAuthoredReceipt,
  assertRunning: () => void,
  refreshRunning: () => Promise<void>,
  publishReady: () => void
): Promise<void> {
  opts.payload()?.fill(0);
  if (!opts.admitted.observed) {
    throw new Error("Native runtime membership is unobserved; values omitted.");
  }
  if (opts.hookOwner) {
    requireHookSuccess(await opts.phase("up.after"));
    await refreshRunning();
  }
  await opts.inputs().assertFresh();
  await opts.admitted.source.assertFresh();
  await opts.admission.assertHeld();
  opts.admitted.ready = await opts.admission.publish({
    expectedStart: opts.admitted.start,
    record: {
      version: 2,
      kind: "native-authored-project-run",
      receipt,
    },
    assertReady: () => {
      opts.remaining();
      assertRunning();
      return undefined;
    },
  });
  freeze(opts.admitted.ready);
  if (opts.hookOwner) {
    const endpoint = await serveNativeHookStop({
      run: opts.run,
      assertFresh: opts.hookOwner.assertFresh,
      onRefusal: (stage) =>
        opts.observe({
          phase: "down.before",
          boundary: STOP_STAGES[stage],
        }),
      stop: () => {
        opts.observe({
          phase: "down.before",
          boundary: "stop-request",
        });
        opts.stop();
        return opts.stopped;
      },
    });
    opts.endpoint(endpoint);
    await opts.hookOwner.publishStop(endpoint);
  }
  publishReady();
  opts.published();

  opts.onReady(opts.admitted.ready);
}
