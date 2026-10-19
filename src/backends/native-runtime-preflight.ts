import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  isNativeRuntimeNotRunning,
  NATIVE_RUNTIME_NOT_RUNNING,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/**
 * True when a `runtime status --json` reply reports a runtime that cannot
 * serve a graph: any phase other than `running` (for example `stopped`,
 * `uninitialized` or `process-exited`) or a dead runtime process. A reply
 * without these fields is inconclusive and reports false.
 */
export function nativeRuntimeStatusStopped(status: unknown): boolean {
  return (
    isRecord(status) &&
    ((typeof status.phase === "string" && status.phase !== "running") ||
      status.process_alive === false)
  );
}

/**
 * Read-only check, before a foreground start reserves its startup intent, that
 * the candidate runtime is running. A stopped runtime refuses with the same
 * closed `runtime_not_running` code the runtime itself reports, so the start
 * leaves no retained intent behind (and `ps` keeps reporting `not_started`).
 *
 * This is advisory and racy by nature: the runtime may stop right after the
 * check, and the start then fails and retains its evidence as before. A failed
 * or malformed status request is inconclusive and does not refuse; the start's
 * own runtime requests report any real failure.
 */
export async function refuseStoppedNativeRuntime(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  let status: unknown;
  try {
    status = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.cwd,
      args: ["runtime", "status", "--json"],
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  } catch (error: unknown) {
    if (isNativeRuntimeNotRunning(error)) {
      throw error;
    }
    return;
  }
  if (nativeRuntimeStatusStopped(status)) {
    throw new NativeRuntimeRequestError({
      message:
        "Native runtime is not running; no startup intent was reserved and nothing was started.",
      nativeCode: NATIVE_RUNTIME_NOT_RUNNING,
    });
  }
}
