import { randomBytes } from "node:crypto";
import { isRecord } from "../lib/guards.ts";
import type { NativeProjectReview } from "./native-project-review.ts";
import type { NativeProjectRun } from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
/** Bind a stopped graph to the unchanged reviewed plan before acquiring its next owner. */
export async function selectNativeProjectRestore(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly restore?: NativeProjectRun;
  readonly review: NativeProjectReview;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{ run: string; flags: string[]; restoring: boolean }> {
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
    selected.plan !== opts.review.planId ||
    selected.namespace !== saved.namespace ||
    selected.plan !== saved.planId ||
    typeof selected.generation !== "string" ||
    !SHA.test(selected.generation)
  ) {
    throw new Error(
      "Native restore selection changed; retained data was not adopted."
    );
  }
  return {
    run: saved.run,
    flags: ["--expect-generation", selected.generation],
    restoring: true,
  };
}
