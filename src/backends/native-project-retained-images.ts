import { isRecord } from "../lib/guards.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import {
  type NativeActiveReviewProof,
  selectNativeActiveReview,
} from "./native-project-review.ts";
import type { NativeProjectRun } from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const SERVICE = /^[a-zA-Z0-9_.-]{1,128}$/;

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
  return imagesFromReceipt({
    ...opts,
    restore: opts.restore,
    receipt: observed.receipt,
  });
}

function imagesFromReceipt(opts: {
  readonly originalSha256: string;
  readonly restore: NativeProjectRun;
  readonly receipt: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, string> {
  const { receipt } = opts;
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

function activeReceipt(value: unknown, saved: NativeProjectRun) {
  if (
    !isRecord(value) ||
    value.journal_incomplete !== false ||
    !isRecord(value.receipt) ||
    value.receipt.phase !== "ready-observed" ||
    value.receipt.run !== saved.run ||
    value.receipt.owner !== saved.owner ||
    value.receipt.namespace !== saved.namespace ||
    value.receipt.plan_id !== saved.planId ||
    !isRecord(value.receipt.resources)
  ) {
    throw new Error(
      "Native active image selection changed; the current graph was not stopped."
    );
  }
  return { ...value.receipt, resources: value.receipt.resources };
}

/**
 * Authenticate the active receipt before selecting its images. Native generation
 * binds the entire receipt, including completed initializers. The caller must
 * repeat this exact proof after review and before cleanup eligibility.
 */
export async function selectNativeActiveImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly originalSha256: string;
  readonly restore: NativeProjectRun;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  readonly images: ReadonlyMap<string, string>;
  readonly proof: NativeActiveReviewProof;
}> {
  const inspect = () =>
    inspectNativeProjectGraph({ ...opts, run: opts.restore.run });
  const initial = activeReceipt(await inspect(), opts.restore);
  const initialImages = imagesFromReceipt({ ...opts, receipt: initial });
  // Legacy/edited declarations still need active authority, but receive no pins.
  const service = Object.values(initial.resources).find(
    (resource) =>
      isRecord(resource) &&
      resource.kind === "container" &&
      typeof resource.key === "string" &&
      SERVICE.test(resource.key)
  );
  if (!isRecord(service) || typeof service.key !== "string") {
    throw new Error(
      "Native active image selection has no service authority; the current graph was not stopped."
    );
  }
  const proof = await selectNativeActiveReview({
    ...opts,
    retained: opts.restore,
    service: service.key,
    invoke: opts.invoke ?? invokeNativeRuntime,
  });
  // This fresh read is bracketed by native selection and the caller's recheck;
  // an earlier inspection cannot be authenticated by a later generation alone.
  const receipt = activeReceipt(await inspect(), opts.restore);
  const resource = isRecord(receipt.resources)
    ? receipt.resources[`container:${proof.service}`]
    : undefined;
  if (!isRecord(resource) || resource.id !== proof.container) {
    throw new Error(
      "Native active image identity changed; the current graph was not stopped."
    );
  }
  const images = imagesFromReceipt({ ...opts, receipt });
  if (JSON.stringify([...initialImages]) !== JSON.stringify([...images])) {
    throw new Error(
      "Native active image selection changed; the current graph was not stopped."
    );
  }
  return { images, proof };
}
