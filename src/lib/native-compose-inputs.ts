import {
  acquireNativeExecutionInputs,
  nativeExecutionSourceRevision,
} from "./native-execution-inputs.ts";

/** Preserve the material owner's fingerprint API through the shared input owner. */
export function nativeComposeSourceRevision(
  prepared: Parameters<typeof nativeExecutionSourceRevision>[0]
): string {
  return nativeExecutionSourceRevision(prepared);
}

/** Existing Compose adapter import; both consumers retain the same private input owner. */
export function acquireNativeComposeInputs(
  opts: Parameters<typeof acquireNativeExecutionInputs>[0]
): ReturnType<typeof acquireNativeExecutionInputs> {
  return acquireNativeExecutionInputs(opts);
}
