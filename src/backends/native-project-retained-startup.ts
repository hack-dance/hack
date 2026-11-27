import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { reportNativeStartLeaseWait } from "../lib/native-detached-up.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import {
  confirmedNativeRetainedGraph,
  lostContainerRemovals,
} from "./native-project-retained.ts";
import {
  type loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  recordNativeLostRemoval,
} from "./native-project-run.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  retainNativeRuntimeFailure,
} from "./native-runtime-client.ts";
import { NATIVE_START_LEASE_REQUEST_TIMEOUT_MS } from "./native-start-lease.ts";

const SHA = /^[a-f0-9]{64}$/;
/**
 * Stopped runtime phases the runtime's retained preflight accepts, besides a
 * clean `stopped`: a later boot that failed before recording its guest boot,
 * after `runtime recover` where needed (HACK-2376), and a pool whose provider
 * ended uncleanly after its boot recorded one, with its provider proven gone
 * (HACK-2730: the provider died after `hack down`, then `runtime recover`). To
 * this caller each is a stopped runtime that `runtime up` boots; the runtime
 * itself keeps the checks.
 */
const RETAINED_STOPPED_PHASES = new Set([
  "stopped",
  "recovered-unclean",
  "stopped-before-engine",
  "stopped-after-engine-failure",
]);
/** Offline boot eligibility only. Live compute/volume proof and restore selection
 * remain required after runtime up; this response cannot authorize graph restore.
 */
export async function preflightNativeRetainedStartup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}): Promise<{ runtimePhase: "running" | "stopped"; flags: string[] }> {
  requireActive(opts.signal);
  const value = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["graph", "retained-preflight", "--run-id", opts.run.run, "--json"],
    // The runtime waits up to 35 s for a lock another project's stop holds
    // (HACK-2724), then checks eligibility.
    timeoutMs: NATIVE_START_LEASE_REQUEST_TIMEOUT_MS,
    signal: opts.signal,
    onLeaseWait: reportNativeStartLeaseWait,
  });
  requireActive(opts.signal);
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      value.run === opts.run.run &&
      value.owner === opts.run.owner &&
      value.namespace === opts.run.namespace &&
      value.plan === opts.run.planId &&
      value.live_resources_verified === false &&
      typeof value.runtime_phase === "string" &&
      (value.runtime_phase === "running" ||
        RETAINED_STOPPED_PHASES.has(value.runtime_phase)) &&
      typeof value.selection === "string" &&
      SHA.test(value.selection)
    )
  ) {
    throw new ClosedCliError(
      "Native retained startup eligibility changed; no hooks or runtime start were requested."
    );
  }
  return {
    runtimePhase: value.runtime_phase === "running" ? "running" : "stopped",
    flags: [
      "--expect-retained-run",
      opts.run.run,
      "--expect-retained-selection",
      value.selection,
    ],
  };
}
/** The runtime's refusal of a retained start whose pool another start booted
 * or stopped after its preflight; the run and the pool's identity are
 * unchanged (HACK-2732). */
export const NATIVE_RETAINED_POOL_CHANGED = "graph_retained_pool_changed";

/**
 * `runtime up` for a retained start, which joins a pool another start booted
 * meanwhile (HACK-2732). Two projects' `hack up -d` on a stopped pool: each
 * preflight selects the stopped pool; one start boots it, and the other's
 * `runtime up`, under the startup lease, finds the pool booted since its
 * selection. Another project's own share, network or capacity change counts
 * the same way. The runtime refuses that with `graph_retained_pool_changed`
 * only when the run's receipt and its pool's stable identity (token, machine,
 * HOME alias, disks, root files, profile, layout and this run's own share) are
 * unchanged. Then `reselect` takes the selection again (the preflight and, on
 * a running pool, the graph confirmation) and `runtime up` runs once more,
 * which joins the running pool. Any other refusal is kept: a replaced owner,
 * token, disk or own share refuses with `graph_retained_startup`. A second
 * change is reported as it comes, naming the retry
 * ({@link NATIVE_RETAINED_POOL_CHANGED_AGAIN}).
 */
export async function runtimeUpJoiningChangedPool<T>(opts: {
  readonly flags: readonly string[];
  readonly up: (flags: readonly string[]) => Promise<T>;
  readonly reselect: () => Promise<readonly string[]>;
}): Promise<T> {
  try {
    return await opts.up(opts.flags);
  } catch (error) {
    if (
      !(
        opts.flags.length > 0 &&
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode === NATIVE_RETAINED_POOL_CHANGED
      )
    ) {
      throw error;
    }
  }
  const flags = await opts.reselect();
  try {
    return await opts.up(flags);
  } catch (error) {
    // A second change means the pool booted or stopped again while this start
    // waited: retried once only, it is reported as it is, with the next step.
    if (
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode === NATIVE_RETAINED_POOL_CHANGED
    ) {
      // The runtime's own fixed sentence (which names the same retry) stays the
      // detail a detached start reports.
      throw retainNativeRuntimeFailure({
        error: new NativeRuntimeRequestError({
          nativeCode: NATIVE_RETAINED_POOL_CHANGED,
          nativeMessage: error.nativeMessage,
          message: NATIVE_RETAINED_POOL_CHANGED_AGAIN,
        }),
        original: error,
      });
    }
    throw error;
  }
}

/** The refusal after the one retry also found the pool changed (HACK-2732). */
export const NATIVE_RETAINED_POOL_CHANGED_AGAIN =
  "Native runtime request failed (graph_retained_pool_changed): the native pool changed again while this start waited for it (another project started or stopped it). Nothing was started for this run and its data is kept. Retry hack up (or hack up -d).";

/**
 * The retained run's eligibility once more, for a start whose selection the
 * runtime found stale (HACK-2732): the run mapping is still the one selected,
 * the preflight accepts it, and on a running pool its graph is still the
 * confirmed retained stop. Returns the new `runtime up` flags.
 */
export async function reselectNativeRetainedStartup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly load: typeof loadNativeProjectRun;
  readonly signal?: AbortSignal;
}): Promise<string[]> {
  await verifyNativeRetainedMapping(opts);
  const preflight = await preflightNativeRetainedStartup({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: opts.run,
    invoke: opts.invoke,
    signal: opts.signal,
  });
  await confirmRunningRetainedGraph({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: opts.run,
    invoke: opts.invoke,
    runtimePhase: preflight.runtimePhase,
    onLostRemoval: recordLostRemovalOf(opts.scope, opts.run),
  });
  requireActive(opts.signal);
  return preflight.flags;
}

/** The `onLostRemoval` of a retained start of `run` in `scope`: it records the
 * lost-removal marker that `hack down --recover` reads (HACK-2731). */
export function recordLostRemovalOf(
  scope: NativeProjectRunScope,
  run: NativeProjectRun
): () => Promise<void> {
  return () => recordNativeLostRemoval({ ...scope, run });
}

/** On a running pool, the retained run's graph must still be its confirmed
 * retained stop before a start is requested for it. */
export async function confirmRunningRetainedGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly runtimePhase: "running" | "stopped";
  /** Called, best effort, before the lost-removal refusal (HACK-2731). */
  readonly onLostRemoval?: () => Promise<void>;
}): Promise<void> {
  if (opts.runtimePhase !== "running") {
    return;
  }
  const observed = await inspectNativeProjectGraph({
    startupWait: true,
    runtime: opts.runtime,
    projectRoot: opts.projectRoot,
    run: opts.run.run,
    invoke: opts.invoke,
  });
  if (!confirmedNativeRetainedGraph(observed, opts.run)) {
    throw await unconfirmedRetainedGraph(
      observed,
      opts.run,
      "Native project already has an owned run mapping that is not safely stopped; inspect it before starting another run.",
      opts.onLostRemoval
    );
  }
}

function requireActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ClosedCliError(
      "Native retained startup was canceled; no hooks or runtime start were requested."
    );
  }
}

export async function verifyNativeRetainedMapping(opts: {
  readonly run: NativeProjectRun | null | undefined;
  readonly scope: NativeProjectRunScope;
  readonly load: typeof loadNativeProjectRun;
}): Promise<void> {
  if (
    opts.run &&
    JSON.stringify(await opts.load(opts.scope)) !== JSON.stringify(opts.run)
  ) {
    throw new ClosedCliError(
      "Native retained run mapping changed before runtime start; no start was requested."
    );
  }
}

/** A graph snapshot and the run it was read for. */
export interface NativeRetainedGraphObservation {
  readonly run: string;
  readonly snapshot: unknown;
}

/**
 * After runtime up, confirm the resumed retained graph. Returns the confirmed
 * snapshot so the retained image selection that follows (with no runtime
 * effect in between) reads it instead of inspecting the graph again.
 */
export async function verifyNativeResumedRetainedGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun | null | undefined;
  readonly invoke: typeof invokeNativeRuntime;
  /** Called, best effort, before the lost-removal refusal (HACK-2731). */
  readonly onLostRemoval?: () => Promise<void>;
}): Promise<NativeRetainedGraphObservation | undefined> {
  if (!opts.run) {
    return;
  }
  const observed = await inspectNativeProjectGraph({
    startupWait: true,
    runtime: opts.runtime,
    projectRoot: opts.projectRoot,
    invoke: opts.invoke,
    run: opts.run.run,
  });
  if (!confirmedNativeRetainedGraph(observed, opts.run)) {
    throw await unconfirmedRetainedGraph(
      observed,
      opts.run,
      "Native resumed retained graph differs; no graph restore was requested.",
      opts.onLostRemoval
    );
  }
  return { run: opts.run.run, snapshot: observed };
}

/**
 * The refusal when a retained run's stopped graph is not the stop its receipt
 * records because a lost VM brought back containers that its `hack down` had
 * removed (HACK-2096, HACK-2719). Seen after HACK-2730: the provider died
 * seconds after `hack down`, `hack up` recovered and booted the pool, and the
 * removal had not reached the guest disk. `hack down --recover` removes them
 * again on the running pool (data kept), and `hack up` then starts the run.
 */
export const NATIVE_RETAINED_LOST_REMOVAL =
  "This run is stopped with its data kept, but stopped containers that its last hack down had removed are listed again, most likely because the VM was lost seconds after that down, before the removal reached the guest disk. Nothing was started. Run hack down --recover to remove them again (data kept), then hack up.";

/** A retained graph that is not the confirmed stop: the lost-removal shape of
 * this exact run names its repair, anything else keeps `fallback`. The
 * lost-removal shape is first recorded (`onLostRemoval`, best effort) so that
 * `hack down --recover` starts the pool for the repair even after the pool
 * this start booted has gone idle and stopped (HACK-2731). */
async function unconfirmedRetainedGraph(
  observed: unknown,
  run: NativeProjectRun,
  fallback: string,
  onLostRemoval?: () => Promise<void>
): Promise<ClosedCliError> {
  const receipt =
    isRecord(observed) && isRecord(observed.receipt) ? observed.receipt : {};
  const thisRun =
    receipt.run === run.run &&
    receipt.owner === run.owner &&
    receipt.namespace === run.namespace &&
    receipt.plan_id === run.planId;
  if (!(thisRun && lostContainerRemovals(observed))) {
    return new ClosedCliError(fallback);
  }
  await onLostRemoval?.().catch(() => undefined);
  return new ClosedCliError(NATIVE_RETAINED_LOST_REMOVAL);
}
