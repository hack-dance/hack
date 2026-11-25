/**
 * Time source for a readiness wait. `now` reads the same epoch-millisecond scale as
 * the caller's `deadline`; `sleep` is the backoff between observations. Production
 * uses {@link systemNativeComposeWaitClock}. Tests inject a virtual clock so the
 * order of observations and the deadline does not depend on host load. The clock
 * governs only the aggregate deadline: each Docker probe still runs under its own
 * real-time timeout.
 */
export type NativeComposeWaitClock = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<unknown>;
};

export const systemNativeComposeWaitClock: NativeComposeWaitClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/**
 * Shared readiness loop. Each observation owns a fresh bounded acquisition;
 * the caller supplies the aggregate deadline and retains resource authority.
 */
export async function waitNativeComposeReady<T>(opts: {
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly observe: () => Promise<T | null>;
  readonly ready: (state: T) => boolean;
  readonly failed?: (state: T) => boolean;
  readonly clock?: NativeComposeWaitClock;
}): Promise<T | null> {
  const clock = opts.clock ?? systemNativeComposeWaitClock;
  while (clock.now() < opts.deadline) {
    const state = await opts.observe();
    if (state && opts.failed?.(state)) {
      return null;
    }
    if (state && opts.ready(state)) {
      return state;
    }
    if (opts.signal?.aborted) {
      return null;
    }
    await clock.sleep(500);
  }
  return null;
}
