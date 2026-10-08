/**
 * Shared readiness loop. Each observation owns a fresh bounded acquisition;
 * the caller supplies the aggregate deadline and retains resource authority.
 */
export async function waitNativeComposeReady<T>(opts: {
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly observe: () => Promise<T | null>;
  readonly ready: (state: T) => boolean;
}): Promise<T | null> {
  while (Date.now() < opts.deadline) {
    const state = await opts.observe();
    if (state && opts.ready(state)) {
      return state;
    }
    if (opts.signal?.aborted) {
      return null;
    }
    await Bun.sleep(500);
  }
  return null;
}
