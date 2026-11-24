import {
  type invokeNativeRuntime,
  NATIVE_PROVIDER_PIN_MESSAGE,
  NativeRuntimeRequestError,
} from "./native-runtime-client.ts";

const FRESH_NATIVE_HOME_GUIDANCE =
  "To start independently, use a separate project checkout and keep this home for its data. Follow the fresh native home instructions at https://github.com/hack-dance/hack/blob/next/docs/versions/v5/native/setup.md#manual-homes";

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
    return `Run hack ps --json to inspect the retained state. ${FRESH_NATIVE_HOME_GUIDANCE}`;
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
