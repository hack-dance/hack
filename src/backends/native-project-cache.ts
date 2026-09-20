import { isRecord } from "../lib/guards.ts";
import type { NativeProjectReview } from "./native-project-review.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const CACHE_LABELS = new Set([
  "hack.dependencies.cache-volume",
  "hack.dependencies.lockfiles",
  "hack.dependencies.runtime-files",
  "hack.dependencies.bootstrap",
]);
const SHA = /^[a-f0-9]{64}$/;

/** Source sharing is meaningful only for active bind mounts, not image-only services. */
export function nativeSharedSourceFlags(plan: unknown): readonly string[] {
  if (!(isRecord(plan) && isRecord(plan.services))) {
    throw new Error("Native source review is invalid.");
  }
  const shared = Object.values(plan.services).some(
    (service) =>
      isRecord(service) &&
      service.active === true &&
      Array.isArray(service.mounts) &&
      service.mounts.some((mount) => isRecord(mount) && mount.kind === "bind")
  );
  return shared ? ["--shared-source"] : [];
}

/** Only the existing cache contract is admitted here; native review validates its values. */
export function hasOnlyNativeCacheLabels(labels: unknown): boolean {
  if (labels === undefined) {
    return true;
  }
  if (isRecord(labels)) {
    return Object.keys(labels).every((key) => CACHE_LABELS.has(key));
  }
  if (Array.isArray(labels)) {
    return labels.every(
      (value) =>
        typeof value === "string" &&
        CACHE_LABELS.has(value.split("=", 1)[0] ?? "")
    );
  }
  return false;
}

/** Publish the exact reviewed snapshot before admitting any content-keyed initializer. */
export async function publishNativeCacheSource(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly review: NativeProjectReview;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  readonly flags: string[];
  readonly initializers: ReadonlySet<string>;
}> {
  const plan = opts.review.report.plan;
  if (!(isRecord(plan) && isRecord(plan.services))) {
    throw new Error("Native cache review is invalid.");
  }
  const initializers = new Set<string>();
  for (const [name, service] of Object.entries(plan.services)) {
    if (!isRecord(service)) {
      throw new Error("Native service review is invalid.");
    }
    if (service.active === true && isRecord(service.dependency_cache)) {
      initializers.add(name);
    }
  }
  if (initializers.size === 0) {
    return { flags: [], initializers };
  }
  const publication = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [
      "project",
      "publish-source",
      ...opts.review.projectArgs,
      "--expect-plan",
      opts.review.planId,
      "--json",
    ],
  });
  if (
    !(
      isRecord(publication) &&
      typeof publication.revision === "string" &&
      SHA.test(publication.revision) &&
      publication.namespace === opts.review.namespace &&
      publication.state === "guest-content-verified-no-job-started"
    )
  ) {
    throw new Error(
      "Native cache source publication did not return a verified revision."
    );
  }
  return { flags: ["--source-revision", publication.revision], initializers };
}
