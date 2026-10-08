import { acquireNativeExecutionInputs } from "./native-execution-inputs.ts";

/** Existing Compose adapter import; both consumers retain the same private input owner. */
export function acquireNativeComposeInputs(
  opts: Parameters<typeof acquireNativeExecutionInputs>[0]
): ReturnType<typeof acquireNativeExecutionInputs> {
  return acquireNativeExecutionInputs(opts);
}
