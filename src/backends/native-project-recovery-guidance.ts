import {
  type invokeNativeRuntime,
  NATIVE_PROVIDER_PIN_MESSAGE,
  NativeRuntimeRequestError,
} from "./native-runtime-client.ts";

/**
 * The explicit cross-pool-stop dead-owner cleanup (`graph recover-cleanup`). Its
 * `prepare` admits a failed or unfinished fresh start (`failed-retained`,
 * `preparing`) and an owner that died during its own stop (`cleanup-intent`);
 * it refuses a restore or restart in progress (`restoring`, `restarting`).
 */
export const NATIVE_DEAD_OWNER_CLEANUP_GUIDANCE =
  "When no other project uses this native home, follow the explicit dead-owner cleanup at https://github.com/hack-dance/hack/blob/next/docs/guides/native-candidate.md#explicit-cleanup-after-a-dead-foreground-owner, which keeps the data in this home.";

/**
 * The next step after the runtime could not prove a same-boot recovery of an
 * exited owner (HACK-2097). A lost frontend's owner stops on its own, so the
 * common case is an owner still finishing that stop: rerunning the same command
 * then recovers it. Once the owner has exited, this boot cannot recover the run;
 * the explicit cleanup covers only the phases its `prepare` admits.
 */
const LIVE_OWNER_RECOVERY_GUIDANCE = `Data and evidence are kept. Run hack ps --json: while the run's foreground owner is still running or stopping, wait for it to exit, then run hack down --recover again. If it still refuses after the owner exited, the run cannot be recovered in this boot. A start that failed or never finished, or an owner that died during its own stop, is recovered across a pool stop: ${NATIVE_DEAD_OWNER_CLEANUP_GUIDANCE} An owner that died while restoring or restarting a retained run has no supported retirement; keep this home and its receipts.`;

/** Name a usable next command without turning uncertainty into cleanup authority. */
export function nativeRecoveryGuidance(code: string | undefined): string {
  if (code === "provider_pin_changed") {
    return NATIVE_PROVIDER_PIN_MESSAGE;
  }
  if (code === "runtime_not_running") {
    // Follows the runtime's own sentence, which says only that it did not connect: a
    // pool that is booting or quiescing may still run containers (HACK-2420).
    return "Run hack ps --json to see whether the native runtime is stopped, starting or stopping. Once it is stopped, hack up starts the project again and hack down --recover cleans up a run whose owner exited.";
  }
  if (code === "publisher_identity_unconfirmed") {
    return "Recovery waits for the process holding the recorded publisher PID to exit when its identity cannot be confirmed. After it exits, rerun hack down --recover.";
  }
  if (code === "graph_live_owner_recovery") {
    return LIVE_OWNER_RECOVERY_GUIDANCE;
  }
  if (code === "provider_busy" || code === "native_request_timeout") {
    return "Run hack down --recover to retry this run's cleanup with data retained.";
  }
  return "Run hack ps --json to inspect this run's retained state.";
}

/** Preserve structured failures while giving every retaining-down request a next action. */
export function withNativeRecoveryGuidance(
  invoke: typeof invokeNativeRuntime
): typeof invokeNativeRuntime {
  return async (request) => {
    try {
      return await invoke(request);
    } catch (error) {
      if (!(error instanceof NativeRuntimeRequestError)) {
        throw error;
      }
      throw new NativeRuntimeRequestError({
        message:
          error.nativeCode === "provider_pin_changed"
            ? `Native runtime request failed (provider_pin_changed); ${NATIVE_PROVIDER_PIN_MESSAGE}`
            : `${error.message} ${nativeRecoveryGuidance(error.nativeCode)}`,
        nativeCode: error.nativeCode,
        nativeCauseCode: error.nativeCauseCode,
        nativeMessage: error.nativeMessage,
        nativeService: error.nativeService,
        nativeStopFailures: error.nativeStopFailures,
        stopSignal: error.stopSignal,
      });
    }
  };
}
