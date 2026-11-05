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
/** Concurrent cleanup observers share a provider lease. Retry only read-only lease contention. */
export async function inspectNativeProjectGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<unknown> {
  const deadline = performance.now() + 2000;
  for (;;) {
    try {
      return await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["graph", "inspect", "--run-id", opts.run, "--json"],
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (!isNativeProviderBusy(error) || performance.now() >= deadline) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}
