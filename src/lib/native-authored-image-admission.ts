import { isRecord } from "./guards.ts";

/**
 * Closed refusal of the bounded native authored consumer. The code and wording
 * are byte-identical to runtime-core's `native_graph_admission`
 * (`provider/graph/native/mod.rs`), which `graph native plan`, `frontend-plan`
 * and `serve` all return for a non-content-ID image.
 */
export const NATIVE_GRAPH_ADMISSION_CODE = "native_graph_admission";
export const NATIVE_GRAPH_ADMISSION_MESSAGE =
  "Native consumption requires its exact compiler review, immutable images, bounded process/readiness and a separately admitted live-source or persistent-storage contract; values omitted.";

const CONTENT_ID = /^sha256:[a-f0-9]{64}$/;

/**
 * Whether every selected workload in a compiled plan names an immutable
 * `sha256:` image content ID, the only image form the native consumer runs.
 *
 * A registry tag or `repository@sha256:` manifest digest is valid authored
 * configuration (the Compose backend runs it) but is not a content ID. Only the
 * compiler's selected `services` and `jobs` are checked, matching the workloads
 * native lowering admits. A build-only workload has no image and is left to the
 * native planner's own subset refusal; a non-string image or a malformed plan
 * fails closed. This checks only image identity, not the rest of the native
 * subset. Pure: no runtime, registry or state access.
 */
export function nativeConsumerAdmitsImages(plan: unknown): boolean {
  if (!isRecord(plan)) {
    return false;
  }
  for (const field of ["services", "jobs"] as const) {
    const workloads = plan[field];
    if (workloads === undefined) {
      continue;
    }
    if (!isRecord(workloads)) {
      return false;
    }
    for (const workload of Object.values(workloads)) {
      if (!isRecord(workload)) {
        return false;
      }
      if (
        workload.image !== undefined &&
        !(typeof workload.image === "string" && CONTENT_ID.test(workload.image))
      ) {
        return false;
      }
    }
  }
  return true;
}
