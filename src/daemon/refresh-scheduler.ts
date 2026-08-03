export type RefreshUrgency = "debounced" | "immediate";

export interface RefreshScheduler {
  request(opts: {
    readonly reason: string;
    readonly urgency: RefreshUrgency;
  }): void;
  stop(): void;
}

type Timer = ReturnType<typeof setTimeout>;

type PendingRefresh = {
  readonly reason: string;
  readonly requestedAtMs: number;
  readonly urgency: RefreshUrgency;
};

export function createRefreshScheduler(opts: {
  readonly refresh: (opts: {
    readonly reason: string;
    readonly forceInspect: boolean;
  }) => Promise<void>;
  readonly debounceMs?: number;
  readonly minIntervalMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly onRequest?: (opts: { readonly coalesced: boolean }) => void;
  readonly onRefreshStart?: () => void;
  readonly onRefreshFinish?: (opts: {
    readonly durationMs: number;
    readonly error: unknown | null;
  }) => void;
}): RefreshScheduler {
  const debounceMs = opts.debounceMs ?? 250;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const now = opts.now ?? Date.now;

  let active = false;
  let lastCompletedAtMs: number | null = null;
  let pending: PendingRefresh | null = null;
  let stopped = false;
  let timer: Timer | null = null;

  function clearTimer(): void {
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  }

  function schedulePending(): void {
    if (stopped || active || !pending) {
      return;
    }

    clearTimer();
    const currentTimeMs = now();
    const earliestByIntervalMs =
      lastCompletedAtMs === null
        ? currentTimeMs
        : lastCompletedAtMs + minIntervalMs;
    const dueAtMs =
      pending.urgency === "immediate"
        ? currentTimeMs
        : Math.max(
            earliestByIntervalMs,
            Math.min(
              pending.requestedAtMs + maxWaitMs,
              currentTimeMs + debounceMs
            )
          );
    const delayMs = Math.max(0, dueAtMs - currentTimeMs);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
  }

  async function drain(): Promise<void> {
    if (stopped || active || !pending) {
      return;
    }

    const request = pending;
    pending = null;
    active = true;
    const startedAtMs = now();
    opts.onRefreshStart?.();
    let error: unknown | null = null;
    try {
      await opts.refresh({
        reason: request.reason,
        forceInspect: request.urgency === "immediate",
      });
    } catch (caught: unknown) {
      error = caught;
    } finally {
      const completedAtMs = now();
      lastCompletedAtMs = completedAtMs;
      active = false;
      opts.onRefreshFinish?.({
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        error,
      });
      schedulePending();
    }
  }

  return {
    request({ reason, urgency }) {
      if (stopped) {
        return;
      }
      const coalesced = active || pending !== null;
      opts.onRequest?.({ coalesced });
      const currentTimeMs = now();
      if (!pending) {
        pending = { reason, requestedAtMs: currentTimeMs, urgency };
      } else if (urgency === "immediate") {
        pending = {
          reason,
          requestedAtMs: pending.requestedAtMs,
          urgency,
        };
      }
      schedulePending();
    },
    stop() {
      stopped = true;
      pending = null;
      clearTimer();
    },
  };
}
