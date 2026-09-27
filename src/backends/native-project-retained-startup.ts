import { isRecord } from "../lib/guards.ts";
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

const SHA = /^[a-f0-9]{64}$/;
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
    timeoutMs: 30_000,
    signal: opts.signal,
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
      (value.runtime_phase === "running" ||
        value.runtime_phase === "stopped") &&
      typeof value.selection === "string" &&
      SHA.test(value.selection)
    )
  ) {
    throw new Error(
      "Native retained startup eligibility changed; no hooks or runtime start were requested."
    );
  }
  return {
    runtimePhase: value.runtime_phase,
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
    throw new Error(
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
    throw new Error(
      "Native retained run mapping changed before runtime start; no start was requested."
    );
  }
}

export async function verifyNativeResumedRetainedGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun | null | undefined;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<void> {
  if (!opts.run) {
    return;
  }
  const observed = await inspectNativeProjectGraph({
    ...opts,
    run: opts.run.run,
  });
  if (!confirmedNativeRetainedGraph(observed, opts.run)) {
    throw new Error(
      "Native resumed retained graph differs; no graph restore was requested."
    );
  }
}
