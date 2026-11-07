/** Lead time for the advance warning before delivered AWS credentials expire. */
export const NATIVE_AWS_EXPIRY_LEAD_MS = 10 * 60_000;
/** Timers above this delay are not scheduled (platform timer limit). */
const MAX_TIMER_MS = 2_147_483_647;

/** Opaque timer handle; unreferenced when the platform supports it. */
type Timer = unknown;
function unref(timer: Timer): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}
export type NativeAwsExpiryClock = {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
};
const SYSTEM_CLOCK: NativeAwsExpiryClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) =>
    clearTimeout(timer as Parameters<typeof clearTimeout>[0]),
};

function clock(expiry: number): string {
  const date = new Date(expiry);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Value-free warning lines for a foreground run whose AWS credentials were
 * delivered once at startup. Only the service count and local expiry time appear.
 */
export function nativeAwsExpiryMessage(opts: {
  readonly services: number;
  readonly expiry: number;
  readonly expired: boolean;
}): string {
  const subject = `AWS credentials delivered to ${opts.services} ${opts.services === 1 ? "service" : "services"}`;
  return opts.expired
    ? `${subject} expired at ${clock(opts.expiry)}; run hack restart to renew.`
    : `${subject} expire at ${clock(opts.expiry)}; run hack restart to renew.`;
}

/**
 * Schedule one warning ten minutes before `expiry` and one at `expiry`. A
 * warning whose time has already passed at scheduling is written immediately
 * (only the most recent one). Timers are unreferenced and the returned function
 * cancels any that have not fired. This changes no ownership or runtime state
 * and does not renew credentials.
 */
export function scheduleNativeAwsExpiryWarnings(opts: {
  readonly expiry: string;
  readonly services: number;
  readonly write: (line: string) => void;
  readonly clock?: NativeAwsExpiryClock;
}): () => void {
  const time = opts.clock ?? SYSTEM_CLOCK;
  const expiry = Date.parse(opts.expiry);
  if (!Number.isFinite(expiry) || opts.services < 1) {
    return () => undefined;
  }
  const timers: Timer[] = [];
  const now = time.now();
  const schedule = (at: number, expired: boolean) => {
    const emit = () =>
      opts.write(
        nativeAwsExpiryMessage({ services: opts.services, expiry, expired })
      );
    const delay = at - now;
    if (delay > MAX_TIMER_MS) {
      return;
    }
    if (delay <= 0) {
      emit();
      return;
    }
    const timer = time.setTimer(emit, delay);
    unref(timer);
    timers.push(timer);
  };
  if (expiry <= now) {
    schedule(expiry, true);
  } else {
    if (expiry - NATIVE_AWS_EXPIRY_LEAD_MS > now) {
      schedule(expiry - NATIVE_AWS_EXPIRY_LEAD_MS, false);
    } else {
      schedule(now, false);
    }
    schedule(expiry, true);
  }
  return () => {
    for (const timer of timers.splice(0)) {
      time.clearTimer(timer);
    }
  };
}
