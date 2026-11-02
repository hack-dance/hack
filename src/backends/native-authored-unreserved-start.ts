import {
  loadNativeAuthoredProjectRun,
  type NativeAuthoredProjectRunScope,
  withNativeAuthoredProjectAdmission,
  withNativeAuthoredProjectStatus,
} from "./native-authored-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

function refused(): never {
  throw new Error(
    "Native startup intent is not a provably unreserved attempt; selected state is retained. Values omitted."
  );
}

/**
 * Read-only selection for explicit recovery: true only when a startup intent is
 * retained without a Ready mapping or a frontend recovery intent. Any refusal
 * (including a saved recovery intent) selects the stored-generation owner, which
 * keeps its own refusals. Nothing is created, locked or repaired here.
 */
export async function nativeAuthoredUnreservedStartSelected(
  scope: NativeAuthoredProjectRunScope
): Promise<boolean> {
  try {
    return await withNativeAuthoredProjectStatus(
      { ...scope },
      async (saved) => await Promise.resolve(saved.pending)
    );
  } catch {
    return false;
  }
}

/**
 * Explicit `down --recover` for a startup intent whose native consumer never
 * reserved runtime state (HACK-1272). It holds a fresh startup admission, so no
 * live or interrupted foreground CLI (and therefore no consumer it spawned) can
 * still own this attempt; a stale admission lock refuses as busy. Under that
 * admission it requires no Ready mapping, hook owner or live-stop owner, asks the
 * native runtime to inspect the exact run, and retires the start intent and its
 * source only for the exact `native_graph_unreserved` refusal (journal absent and
 * no foreground owner published). Any receipt, any other refusal, or a successful
 * inspection retains every file. No input is acquired and nothing is served,
 * replayed or cleaned in the guest.
 */
export async function retireNativeAuthoredUnreservedStart(opts: {
  readonly scope: NativeAuthoredProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Exact public native-request seam for isolated owner tests. */
  readonly request?: typeof invokeNativeRuntime;
}): Promise<{ readonly run: string }> {
  const scope = { ...opts.scope };
  const runtime = { ...opts.runtime };
  const { timeoutMs, signal } = opts;
  const request = opts.request ?? invokeNativeRuntime;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000 ||
    signal?.aborted ||
    runtime.home !== scope.nativeHome
  ) {
    return refused();
  }
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1 || signal?.aborted) {
      return refused();
    }
    return value;
  };
  return await withNativeAuthoredProjectAdmission(scope, async (admission) => {
    const start = await admission.loadStart();
    if (
      start === null ||
      (await admission.hooksRetained()) ||
      (await admission.liveStopRetained()) ||
      (await loadNativeAuthoredProjectRun(scope)) !== null
    ) {
      return refused();
    }
    const run = start.record.review.provenance.run;
    remaining();
    let refusal: unknown;
    try {
      await request({
        runtime,
        cwd: scope.projectRoot,
        args: ["graph", "native", "inspect", "--run-id", run, "--json"],
        timeoutMs: remaining(),
        signal,
        boundNativeAuthoredReadDrain: true,
      });
    } catch (error) {
      refusal = error;
    }
    if (refusal === undefined) {
      // A journal exists; this attempt belongs to receipt-owned recovery.
      return refused();
    }
    remaining();
    await admission.assertHeld();
    await admission.retireUnreserved({ expectedStart: start, refusal });
    return { run };
  });
}
