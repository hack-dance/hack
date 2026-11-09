import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const BUSY =
  "Native runtime request failed (provider_busy); inspect owned state before retrying.";

/**
 * True when a native request was refused only because another operation holds
 * the provider lease, such as a starting foreground `up`. Nothing was admitted.
 */
export function isNativeProviderBusy(error: unknown): boolean {
  return (
    (error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "provider_busy" &&
      error.nativeCauseCode === undefined) ||
    (error instanceof Error && error.message === BUSY)
  );
}
/**
 * How long an inspection waits out lease contention by default. Inspections
 * inside `up`, `restart`, `down` and recovery outlast a polling `hack ps` or
 * `hack logs` (each holds the lease briefly), so a concurrent read never fails
 * the mutating command. Those observers pass {@link OBSERVER_BUSY_WAIT_MS}.
 */
export const INSPECT_BUSY_WAIT_MS = 15_000;
/** Read-only observers report a busy runtime quickly instead of waiting. */
export const OBSERVER_BUSY_WAIT_MS = 2000;

/** Concurrent cleanup observers share a provider lease. Retry only read-only lease contention. */
export async function inspectNativeProjectGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
  /** Bound for retrying `provider_busy`; see {@link INSPECT_BUSY_WAIT_MS}. */
  readonly busyWaitMs?: number;
}): Promise<unknown> {
  const deadline =
    performance.now() + (opts.busyWaitMs ?? INSPECT_BUSY_WAIT_MS);
  for (;;) {
    try {
      return await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["graph", "inspect", "--run-id", opts.run, "--json"],
        timeoutMs: 30_000,
        signal: opts.signal,
      });
    } catch (error) {
      if (
        !isNativeProviderBusy(error) ||
        performance.now() >= deadline ||
        opts.signal?.aborted
      ) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}
