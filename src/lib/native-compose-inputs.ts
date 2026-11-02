import {
  acquireNativeExecutionFilePlanningInputs,
  acquireNativeExecutionInputs,
  nativeExecutionSourceRevision,
} from "./native-execution-inputs.ts";

/** Preserve the material owner's fingerprint API through the shared input owner. */
export function nativeComposeSourceRevision(
  prepared: Parameters<typeof nativeExecutionSourceRevision>[0]
): string {
  return nativeExecutionSourceRevision(prepared);
}

export type NativeComposeExecutionInputs = Awaited<
  ReturnType<typeof acquireNativeExecutionInputs>
>;

/** Existing Compose adapter import; both consumers retain the same private input owner. */
export function acquireNativeComposeInputs(
  opts: Parameters<typeof acquireNativeExecutionInputs>[0]
): ReturnType<typeof acquireNativeExecutionInputs> {
  return acquireNativeExecutionInputs(opts);
}

/** Symbolic planning only; the Compose command separately owns private material. */
export function acquireNativeComposeFilePlanningInputs(
  opts: Parameters<typeof acquireNativeExecutionFilePlanningInputs>[0]
): ReturnType<typeof acquireNativeExecutionFilePlanningInputs> {
  return acquireNativeExecutionFilePlanningInputs(opts);
}
