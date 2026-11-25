import { isRecord } from "./guards.ts";

// Match the native graph's admitted StopTimeout range and whole-second rounding.
const NATIVE_APPEND_MAX_STOP_SECONDS = 30;
const NATIVE_APPEND_ROLLBACK_MARGIN_MS = 5000;
const DEFAULT_STOP_SECONDS = 10;
export const NATIVE_APPEND_DEFAULT_WAIT_MS =
  DEFAULT_STOP_SECONDS * 1000 + NATIVE_APPEND_ROLLBACK_MARGIN_MS;

export interface NativeAppendRollback {
  readonly services: number;
  readonly waitMs: number;
}

export function nativeAppendRollback(opts: {
  readonly plan: unknown;
  readonly selected: readonly string[];
  readonly ready: ReadonlySet<string>;
  readonly owned: ReadonlyMap<string, string>;
}): NativeAppendRollback {
  const plan =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  const added = opts.selected.filter((name) => !opts.ready.has(name));
  let seconds = 0;
  for (const name of added) {
    // A resumed container still has its original engine config. The receipt
    // does not carry its StopTimeout, so allow the full admitted grace.
    if (opts.owned.has(name)) {
      seconds = NATIVE_APPEND_MAX_STOP_SECONDS;
      break;
    }
    const service = plan[name];
    const nanos = isRecord(service) ? service.stop_grace_period_nanos : null;
    const grace =
      typeof nanos === "number" && Number.isSafeInteger(nanos) && nanos >= 0
        ? Math.min(
            NATIVE_APPEND_MAX_STOP_SECONDS,
            Math.ceil(nanos / 1_000_000_000)
          )
        : DEFAULT_STOP_SECONDS;
    seconds = Math.max(seconds, grace);
  }
  return {
    services: added.length,
    waitMs: seconds * 1000 + NATIVE_APPEND_ROLLBACK_MARGIN_MS,
  };
}

export function readNativeAppendRollback(
  value: unknown
): NativeAppendRollback | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { services, waitMs } = value;
  if (
    typeof services === "number" &&
    Number.isSafeInteger(services) &&
    services >= 0 &&
    services <= 32 &&
    typeof waitMs === "number" &&
    Number.isSafeInteger(waitMs) &&
    waitMs >= NATIVE_APPEND_ROLLBACK_MARGIN_MS &&
    waitMs <=
      NATIVE_APPEND_MAX_STOP_SECONDS * 1000 + NATIVE_APPEND_ROLLBACK_MARGIN_MS
  ) {
    return { services, waitMs };
  }
  return undefined;
}

export function nativeAppendRollbackMessage(count: number): string {
  return `Cancelling, rolling back ${count} service${count === 1 ? "" : "s"}…`;
}
