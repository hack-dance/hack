import {
  NATIVE_EXIT_DRAIN_BOUND_MS,
  readNativeFailureCodes,
} from "./native-runtime-client.ts";

/** Bound only the diagnostic pipe after exit; consumer output owns its own pace. */
export async function readLogFailure(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<number>,
  signal: AbortSignal
) {
  const controller = new AbortController();
  let done = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  void exited.then(() => {
    if (!done) {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
      }, NATIVE_EXIT_DRAIN_BOUND_MS);
    }
  });
  try {
    const failure = await readNativeFailureCodes(stream, controller.signal);
    return expired ? { code: "native_log_exit_drain_timeout" } : failure;
  } finally {
    done = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
