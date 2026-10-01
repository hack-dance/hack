import { isRecord } from "../lib/guards.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import type { NativeProjectRun } from "./native-project-run.ts";
import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;

/**
 * Restore unchanged declarations with their authenticated content IDs. Resolving
 * a mutable tag again could change compute around retained data. This observation
 * grants no restore authority: generation, input, source and resource checks still
 * run in native code at admission. Changed original input keeps normal resolution.
 */
export async function selectNativeRetainedImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly originalSha256: string;
  readonly restore?: NativeProjectRun;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<ReadonlyMap<string, string>> {
  if (!opts.restore) {
    return new Map();
  }
  const observed = await inspectNativeProjectGraph({
    ...opts,
    run: opts.restore.run,
  });
  if (
    !(
      confirmedNativeRetainedGraph(observed, opts.restore) &&
      isRecord(observed) &&
      isRecord(observed.receipt)
    )
  ) {
    throw new Error(
      "Native retained image selection changed; no images were resolved."
    );
  }
  const { receipt } = observed;
  if (receipt.normalized_input === undefined) {
    return new Map();
  }
  const normalized = receipt.normalized_input;
  if (
    !isRecord(normalized) ||
    normalized.namespace !== opts.restore.namespace ||
    typeof normalized.original_compose_sha256 !== "string" ||
    !SHA.test(normalized.original_compose_sha256) ||
    typeof normalized.normalized_compose_sha256 !== "string" ||
    !SHA.test(normalized.normalized_compose_sha256) ||
    !SHA.test(opts.originalSha256) ||
    !isRecord(receipt.resources)
  ) {
    throw new Error(
      "Native retained image provenance is invalid; no images were resolved."
    );
  }
  if (normalized.original_compose_sha256 !== opts.originalSha256) {
    return new Map();
  }
  const images = new Map<string, string>();
  for (const [key, resource] of Object.entries(receipt.resources)) {
    if (!isRecord(resource) || resource.kind !== "container") {
      continue;
    }
    if (
      typeof resource.key !== "string" ||
      key !== `container:${resource.key}` ||
      typeof resource.image !== "string" ||
      !IMAGE.test(resource.image)
    ) {
      throw new Error(
        "Native retained image identity is invalid; no images were resolved."
      );
    }
    images.set(resource.key, resource.image);
  }
  return images;
}
