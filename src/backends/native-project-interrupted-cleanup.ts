import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../lib/guards.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import type { NativeProjectRun } from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA256 = /^[a-f0-9]{64}$/;

function refused(): Error {
  return new Error(
    "Native interrupted startup cleanup is unconfirmed; inspect owned state before retrying."
  );
}

/** A pending shutdown is fenced; it cannot reuse a failed-start selection. */
export class NativePartialShutdownError extends Error {
  constructor() {
    super(
      "Native retaining shutdown is incomplete; retained state and mapping require inspection. No uncertain stop was replayed. Inspect with hack doctor --native-cleanup inspect and follow explicit owned cleanup recovery; do not repeat down or restart the pool blindly."
    );
  }
}

function sameResources(before: unknown, after: unknown): boolean {
  if (
    !(isRecord(before) && isRecord(after)) ||
    Object.keys(before).length === 0 ||
    Object.keys(before).length !== Object.keys(after).length
  ) {
    return false;
  }
  return Object.entries(before).every(([key, resource]) => {
    const final = after[key];
    return (
      isRecord(resource) &&
      isRecord(final) &&
      isDeepStrictEqual(
        { ...resource, phase: undefined },
        { ...final, phase: undefined }
      )
    );
  });
}

/** Recover a selected failed startup after its native foreground has exited.
 * Native inspection must prove the dead owner, unchanged boot and exact pending
 * effect before issuing a separate retaining recovery. A bounded native journal
 * hint also admits inspection of unfinished post-ACK retirement. Neither hint
 * grants authority: native selection is revalidated before recovery. The old
 * effect is never replayed, and acknowledgement alone cannot establish cleanup.
 */
export async function recoverNativeInterruptedStartupCleanup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: NativeProjectRun;
  readonly snapshot: unknown;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<unknown | null> {
  const value = opts.snapshot;
  if (!(isRecord(value) && isRecord(value.receipt))) {
    return null;
  }
  const { receipt } = value;
  const pending =
    receipt.phase === "cleanup-intent" &&
    isRecord(receipt.relay_cleanup) &&
    receipt.relay_cleanup.phase === "pending";
  if (!(pending || value.interrupted_start_cleanup_incomplete === true)) {
    return null;
  }
  if (
    !["cleanup-intent", "stopped-data-retained"].includes(
      String(receipt.phase)
    ) ||
    value.journal_incomplete !== false ||
    receipt.run !== opts.run.run ||
    receipt.owner !== opts.run.owner ||
    receipt.namespace !== opts.run.namespace ||
    receipt.plan_id !== opts.run.planId
  ) {
    throw refused();
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  // Only a read-only native hint suppresses failed-start recovery. The hint
  // never authorizes an effect, even with an older completed startup journal.
  if (
    pending &&
    value.interrupted_start_cleanup_incomplete !== true &&
    isRecord(value.pending_cleanup) &&
    value.pending_cleanup.version === 1 &&
    value.pending_cleanup.kind === "partial_shutdown"
  ) {
    throw new NativePartialShutdownError();
  }
  try {
    const selection = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "graph",
        "inspect-interrupted-start-cleanup",
        "--run-id",
        opts.run.run,
        "--json",
      ],
      timeoutMs: 30_000,
    });
    if (
      !isRecord(selection) ||
      selection.run !== opts.run.run ||
      selection.phase !== receipt.phase ||
      selection.eligible !== true ||
      selection.data_retained !== true ||
      selection.same_boot !== true ||
      typeof selection.selection_sha256 !== "string" ||
      !SHA256.test(selection.selection_sha256)
    ) {
      throw refused();
    }
    const recovered = await invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        "graph",
        "recover-interrupted-start-cleanup",
        "--run-id",
        opts.run.run,
        "--expect-selection",
        selection.selection_sha256,
        "--retain-data",
        "--json",
      ],
      timeoutMs: 590_000,
    });
    if (
      !isRecord(recovered) ||
      recovered.run !== opts.run.run ||
      recovered.phase !== "stopped-data-retained" ||
      recovered.recovered !== true ||
      recovered.data_retained !== true ||
      recovered.same_boot !== true ||
      recovered.publisher_retired !== true ||
      recovered.reservation_released !== true
    ) {
      throw refused();
    }
    const final = await inspectNativeProjectGraph({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      run: opts.run.run,
      invoke,
    });
    if (
      !(
        confirmedNativeRetainedGraph(final, opts.run) &&
        isRecord(final) &&
        final.interrupted_start_cleanup_incomplete !== true &&
        isRecord(final.receipt) &&
        sameResources(receipt.resources, final.receipt.resources)
      )
    ) {
      throw refused();
    }
    return final;
  } catch {
    // Native errors and peer replies may contain arbitrary private diagnostics.
    throw refused();
  }
}
