import { isRecord } from "../lib/guards.ts";
import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/**
 * Shown after a down started the pool to recover its run (HACK-2456), and after
 * a native-authored recovery that started the pool did not complete (HACK-2715).
 */
export const NATIVE_RECOVERY_RUNTIME_STARTED_NOTE =
  "The native runtime was started to recover this run and is still running; run `runtime down` to stop it.";

/**
 * The `runtime up` arguments every native project start sends: the
 * Development profile with this project's direct share. A start appends its
 * retained, capacity, network and platform flags, then `--json`.
 *
 * Sent alone (as a stopped-pool recovery does, HACK-2456) they boot a stopped
 * pool exactly as its record describes. The runtime checks every flag that is
 * present against an existing pool and fixes nothing that is absent, so this
 * request cannot conflict with or change the network, socket or translation
 * intent the project's earlier start recorded.
 */
export function nativeProjectRuntimeUpArgs(projectRoot: string): string[] {
  return [
    "runtime",
    "up",
    "--profile",
    "development",
    "--project-share",
    projectRoot,
    "--unfiltered-source",
  ];
}

/**
 * True only when `runtime status` reports the pool neither running nor with a
 * live provider process. An unreadable status is not proof of a stopped pool.
 */
export async function nativeRuntimePoolStopped(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<boolean> {
  try {
    return nativeRuntimeStatusStopped(
      await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: ["runtime", "status", "--json"],
        timeoutMs: 30_000,
      })
    );
  } catch {
    return false;
  }
}

/** The predicate of {@link nativeRuntimePoolStopped} over one `runtime status`. */
export function nativeRuntimeStatusStopped(status: unknown): boolean {
  return (
    isRecord(status) &&
    typeof status.phase === "string" &&
    status.phase !== "running" &&
    status.process_alive !== true
  );
}
