import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
} from "./native-runtime-client.ts";

/** Name a usable next command without turning uncertainty into cleanup authority. */
export function nativeRecoveryGuidance(code: string | undefined): string {
  if (code === "runtime_not_running") {
    return "Run hack ps --json to confirm that the native runtime is stopped.";
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
        message: `${error.message} ${nativeRecoveryGuidance(error.nativeCode)}`,
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
