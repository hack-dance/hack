import { randomBytes } from "node:crypto";
import { isRecord } from "../lib/guards.ts";
import { nativeCacheInitializers } from "./native-project-cache.ts";
import type { NativeProjectReview } from "./native-project-review.ts";
import type { NativeProjectRun } from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
/** Native code verifies the current review against the retained shared-source contract. */
export async function verifyNativeSourceCompatibility(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly saved: NativeProjectRun;
  readonly review: NativeProjectReview;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<string | null> {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [
      "graph",
      "source-compatibility",
      ...opts.review.projectArgs,
      "--expect-plan",
      opts.review.planId,
      "--run-id",
      opts.saved.run,
      "--json",
    ],
  });
  if (
    !isRecord(result) ||
    result.run !== opts.saved.run ||
    result.owner !== opts.saved.owner ||
    result.namespace !== opts.saved.namespace ||
    result.namespace !== opts.review.namespace ||
    result.plan !== opts.saved.planId ||
    result.reviewed_plan !== opts.review.planId ||
    !(
      result.source_revision === null ||
      (typeof result.source_revision === "string" &&
        SHA.test(result.source_revision))
    )
  ) {
    throw new Error(
      "Native shared-source compatibility changed; retained data was not adopted."
    );
  }
  const cached = nativeCacheInitializers(opts.review.report.plan).size > 0;
  if ((result.source_revision === null) !== !cached) {
    throw new Error(
      "Native shared-source compatibility changed; retained data was not adopted."
    );
  }
  return result.source_revision;
}
/** Bind a stopped graph to the unchanged reviewed plan before acquiring its next owner. */
export async function selectNativeProjectRestore(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly restore?: NativeProjectRun;
  readonly review: NativeProjectReview;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  run: string;
  flags: string[];
  restoring: boolean;
  sourceRevision?: string;
}> {
  const saved = opts.restore;
  if (!saved) {
    return {
      run: randomBytes(16).toString("hex"),
      flags: [],
      restoring: false,
    };
  }
  const selected = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["graph", "restore-selection", "--run-id", saved.run, "--json"],
  });
  if (
    !isRecord(selected) ||
    selected.run !== saved.run ||
    selected.owner !== saved.owner ||
    selected.namespace !== opts.review.namespace ||
    selected.namespace !== saved.namespace ||
    selected.plan !== saved.planId ||
    typeof selected.generation !== "string" ||
    !SHA.test(selected.generation)
  ) {
    throw new Error(
      "Native restore selection changed; retained data was not adopted."
    );
  }
  const sourceRevision =
    selected.plan !== opts.review.planId
      ? await verifyNativeSourceCompatibility({
          runtime: opts.runtime,
          projectRoot: opts.projectRoot,
          saved,
          review: opts.review,
          invoke: opts.invoke,
        })
      : null;
  return {
    run: saved.run,
    flags: ["--expect-generation", selected.generation],
    restoring: true,
    ...(sourceRevision ? { sourceRevision } : {}),
  };
}
