/**
 * Native foreground owns cancellation and must stop its graph before host tunnels.
 * Retire the legacy signal/re-raise handler immediately, retaining deferred cleanup.
 */
export function adoptNativeLifecycleCleanup(lifecycle: {
  readonly signalCleanup: { readonly dispose: () => void } | null;
  readonly cleanup: (() => Promise<void>) | null;
}): () => Promise<void> {
  lifecycle.signalCleanup?.dispose();
  return async () => {
    await lifecycle.cleanup?.();
  };
}
