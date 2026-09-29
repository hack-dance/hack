import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/** Reject incompatible source pools before hooks; runtime up rechecks before effects. */
export async function preflightNativeProjectSource(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: [
      "runtime",
      "check-project-share",
      "--project-share",
      opts.projectRoot,
      "--unfiltered-source",
      "--json",
    ],
    timeoutMs: 5000,
    signal: opts.signal,
  });
  if (
    !isRecord(result) ||
    result.source_admitted !== true ||
    typeof result.pool_initialized !== "boolean"
  ) {
    throw new Error(
      "Native source admission returned an invalid receipt; startup hooks were not run."
    );
  }
}
