import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const BUSY =
  "Native runtime request failed (provider_busy); inspect owned state before retrying.";
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
      if (
        !(error instanceof Error) ||
        error.message !== BUSY ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}
