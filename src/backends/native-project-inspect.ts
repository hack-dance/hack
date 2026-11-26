import { reportNativeStartLeaseWait } from "../lib/native-detached-up.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";
import { NATIVE_START_LEASE_REQUEST_TIMEOUT_MS } from "./native-start-lease.ts";

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

/**
 * Run one read-only native request, retrying only provider-lease contention
 * (`provider_busy`: nothing was admitted) until `deadline` (a
 * `performance.now()` time) or until `signal` aborts. Any other outcome,
 * including a refusal after the lease was taken, returns or throws at once, so
 * nothing past acquisition is ever replayed. At the deadline the last refusal,
 * which names the holder, is thrown.
 */
export async function withNativeProviderBusyWait<T>(opts: {
  readonly request: () => Promise<T>;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}): Promise<T> {
  for (;;) {
    try {
      return await opts.request();
    } catch (error) {
      if (
        !isNativeProviderBusy(error) ||
        performance.now() >= opts.deadline ||
        opts.signal?.aborted
      ) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}

/** Concurrent cleanup observers share a provider lease. Retry only read-only lease contention. */
export async function inspectNativeProjectGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
  /** Bound for retrying `provider_busy`; see {@link INSPECT_BUSY_WAIT_MS}. */
  readonly busyWaitMs?: number;
  readonly startupWait?: boolean;
}): Promise<unknown> {
  return await withNativeProviderBusyWait({
    deadline:
      performance.now() +
      (opts.startupWait ? 0 : (opts.busyWaitMs ?? INSPECT_BUSY_WAIT_MS)),
    signal: opts.signal,
    request: () =>
      (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          "graph",
          "inspect",
          "--run-id",
          opts.run,
          "--json",
          ...(opts.startupWait ? ["--startup-wait"] : []),
        ],
        // A startup inspect waits up to 35 s for a lock another project's stop
        // holds, and reports that wait (HACK-2724).
        ...(opts.startupWait
          ? {
              timeoutMs: NATIVE_START_LEASE_REQUEST_TIMEOUT_MS,
              onLeaseWait: reportNativeStartLeaseWait,
            }
          : { timeoutMs: 30_000 }),
        signal: opts.signal,
      }),
  });
}

/**
 * Lease-free `graph status` of a run whose owner still holds the provider lease
 * (its start loop, until the ready line). Same receipt shape as `graph inspect`,
 * but a point-in-time observation: it authorizes no effect, and every effect on
 * what it selects (down, recovery) re-inspects under the lease. A journal that
 * moves during the read (`graph_status_changed`) is read again, bounded.
 */
export async function observeStartingNativeProjectGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}): Promise<unknown> {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["graph", "status", "--run-id", opts.run, "--json"],
        timeoutMs: 30_000,
        signal: opts.signal,
      });
    } catch (error) {
      const changed =
        error instanceof NativeRuntimeRequestError &&
        (error.nativeCode === "graph_status_changed" ||
          error.nativeCauseCode === "graph_status_changed");
      if (!changed || performance.now() >= deadline || opts.signal?.aborted) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}
