import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { reportNativeStartLeaseWait } from "../lib/native-detached-up.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import type {
  loadNativeProjectRun,
  NativeProjectRun,
  NativeProjectRunScope,
} from "./native-project-run.ts";
import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "./native-runtime-client.ts";
import { NATIVE_START_LEASE_REQUEST_TIMEOUT_MS } from "./native-start-lease.ts";

const SHA = /^[a-f0-9]{64}$/;
/**
 * Stopped runtime phases the runtime's retained preflight accepts, besides a
 * clean `stopped` (HACK-2376): a later boot that failed before recording its
 * guest boot, after `runtime recover` where needed. To this caller each is a
 * stopped runtime that `runtime up` boots; the runtime itself keeps the checks.
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
}): Promise<NativeRetainedGraphObservation | undefined> {
  if (!opts.run) {
    return;
  }
  const observed = await inspectNativeProjectGraph({
    startupWait: true,
    ...opts,
    run: opts.run.run,
  });
  if (!confirmedNativeRetainedGraph(observed, opts.run)) {
    throw new ClosedCliError(
      "Native resumed retained graph differs; no graph restore was requested."
    );
  }
  return { run: opts.run.run, snapshot: observed };
}
