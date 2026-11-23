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

/** The one line `up` and `down` print when they recover a pool whose provider exited. */
export const NATIVE_EXITED_RUNTIME_NOTICE =
  "The native runtime's provider had exited while its record still said running; it was recovered with data kept, and this command continues.";

/**
 * HACK-2579: a pool whose provider process exited (killed, crashed, or lost across a
 * sleep) while its record still says `running` reports `process-exited`. `runtime
 * down` and every graph request refuse it (`process_identity_unavailable`), so `up`
 * and `down` first run `runtime recover`, which takes the provider lease, proves the
 * recorded provider dead by its identity and records the pool stopped
 * (`recovered-unclean`), and say so in one line. Any other state, or a status that
 * cannot be read, changes nothing here. True when it recovered.
 */
export async function recoverExitedNativeRuntime(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly notice?: (line: string) => void;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const status = await invoke({
    runtime: opts.runtime,
    cwd: opts.cwd,
    args: ["runtime", "status", "--json"],
    timeoutMs: 30_000,
    signal: opts.signal,
  }).catch(() => undefined);
  if (!(isRecord(status) && status.phase === "process-exited")) {
    return false;
  }
  const recovered = await invoke({
    runtime: opts.runtime,
    cwd: opts.cwd,
    args: ["runtime", "recover", "--json"],
    timeoutMs: 120_000,
    signal: opts.signal,
  });
  if (
    !isRecord(recovered) ||
    typeof recovered.phase !== "string" ||
    recovered.phase === "running" ||
    recovered.phase === "process-exited"
  ) {
    throw new NativeRuntimeRequestError({
      message:
        "Native runtime recovery after an exited provider returned an unexpected state; nothing else was changed.",
    });
  }
  (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
    NATIVE_EXITED_RUNTIME_NOTICE
  );
  return true;
}
