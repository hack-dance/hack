/**
 * The time limit of a detached native start (HACK-2351).
 *
 * A detached `up` waits for its background owner to report ready. Image
 * builds and loads can take far longer than everything else together, and
 * their length depends on the project and host load, so a fixed window either
 * cuts real progress short or waits far too long for a stuck start. The
 * launcher therefore counts two clocks:
 *
 * - a **budget** for time that is not image work: every phase except
 *   `images`, and `images` too once its heartbeats stop arriving. Each build
 *   and load is a runtime request with its own bound, and the owner reports a
 *   heartbeat while it waits on one, so time spent on that work is not counted.
 * - an absolute **ceiling** on the whole start, which nothing extends.
 *
 * Both are configurable (milliseconds) and never below their minimum. Values
 * are read once per launch; an invalid value refuses rather than falling back.
 */
import { HackCliError } from "./cli-result.ts";

export const NATIVE_DETACHED_START_BUDGET_ENV =
  "HACK_NATIVE_DETACHED_START_TIMEOUT_MS";
export const NATIVE_DETACHED_START_CEILING_ENV =
  "HACK_NATIVE_DETACHED_START_CEILING_MS";
/** The previous fixed window; it now excludes image builds and loads. */
export const DEFAULT_NATIVE_DETACHED_START_BUDGET_MS = 900_000;
export const DEFAULT_NATIVE_DETACHED_START_CEILING_MS = 3_600_000;
/** How often an owner reports that image work is still in flight. */
export const NATIVE_DETACHED_HEARTBEAT_MS = 30_000;
/** Image work without a heartbeat for this long counts against the budget again. */
export const NATIVE_DETACHED_HEARTBEAT_STALE_MS = 120_000;

/** The startup phases an owner reports to its launcher: names only. */
export const NATIVE_DETACHED_START_PHASES = [
  "input",
  "runtime",
  "images",
  "plan",
  "services",
  "dependency-wait",
] as const;
export type NativeDetachedStartPhase =
  | "launching"
  | (typeof NATIVE_DETACHED_START_PHASES)[number];

export function isNativeDetachedStartPhase(
  value: unknown
): value is (typeof NATIVE_DETACHED_START_PHASES)[number] {
  return (
    typeof value === "string" &&
    (NATIVE_DETACHED_START_PHASES as readonly string[]).includes(value)
  );
}

const PHASE_LABEL: Readonly<Record<NativeDetachedStartPhase, string>> = {
  launching: "starting its background owner",
  input: "preparing project input",
  runtime: "starting the native runtime",
  images: "building and loading service images",
  plan: "reviewing the native plan after image work",
  services: "starting services",
  "dependency-wait": "waiting for a host listener",
};

export type NativeDetachedStartLimits = {
  readonly budgetMs: number;
  readonly ceilingMs: number;
};

function positiveMs(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return;
  }
  const value = Number(raw);
  if (!(Number.isSafeInteger(value) && value >= 1000)) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `${name} must be a whole number of milliseconds, at least 1000.`,
    });
  }
  return value;
}

/** The launch's limits; the ceiling is never below the budget. */
export function resolveNativeDetachedStartLimits(
  env: Readonly<Record<string, string | undefined>>
): NativeDetachedStartLimits {
  const budgetMs =
    positiveMs(env, NATIVE_DETACHED_START_BUDGET_ENV) ??
    DEFAULT_NATIVE_DETACHED_START_BUDGET_MS;
  const ceilingMs =
    positiveMs(env, NATIVE_DETACHED_START_CEILING_ENV) ??
    DEFAULT_NATIVE_DETACHED_START_CEILING_MS;
  return { budgetMs, ceilingMs: Math.max(ceilingMs, budgetMs) };
}

export type NativeDetachedStartExpiry = "budget" | "ceiling";

/**
 * The launcher's clocks, on one monotonic clock (`performance.now()`): a wall
 * clock change must neither expire nor extend a start. `observe` records a
 * reported phase (each report of `images` is also a heartbeat); `check`
 * advances the budget by the time since the previous check that was not
 * image work with a fresh heartbeat.
 */
export class NativeDetachedStartDeadline {
  readonly #limits: NativeDetachedStartLimits;
  readonly #startedAt: number;
  readonly #staleMs: number;
  #phase: NativeDetachedStartPhase = "launching";
  #heartbeatAt: number;
  #checkedAt: number;
  #countedMs = 0;

  constructor(opts: {
    readonly limits: NativeDetachedStartLimits;
    readonly now: number;
    readonly heartbeatStaleMs?: number;
  }) {
    this.#limits = opts.limits;
    this.#startedAt = opts.now;
    this.#checkedAt = opts.now;
    this.#heartbeatAt = opts.now;
    this.#staleMs = opts.heartbeatStaleMs ?? NATIVE_DETACHED_HEARTBEAT_STALE_MS;
  }

  get phase(): NativeDetachedStartPhase {
    return this.#phase;
  }

  get countedMs(): number {
    return this.#countedMs;
  }

  observe(phase: NativeDetachedStartPhase, now: number): void {
    this.check(now);
    this.#phase = phase;
    this.#heartbeatAt = now;
  }

  check(now: number): NativeDetachedStartExpiry | undefined {
    // Image work is exempt only until its heartbeat goes stale: of the time
    // since the previous check, count just the part after that point.
    const countedFrom =
      this.#phase === "images"
        ? Math.max(this.#checkedAt, this.#heartbeatAt + this.#staleMs)
        : this.#checkedAt;
    this.#countedMs += Math.max(0, now - countedFrom);
    this.#checkedAt = Math.max(this.#checkedAt, now);
    if (now - this.#startedAt >= this.#limits.ceilingMs) {
      return "ceiling";
    }
    return this.#countedMs >= this.#limits.budgetMs ? "budget" : undefined;
  }

  /** The closed `E_STARTUP_TIMEOUT` refusal: the phase reached and what to run next. */
  timeoutError(expiry: NativeDetachedStartExpiry, now: number): HackCliError {
    const seconds = (ms: number) => Math.round(ms / 1000);
    const limit =
      expiry === "ceiling"
        ? `its ${seconds(this.#limits.ceilingMs)} s ceiling (${NATIVE_DETACHED_START_CEILING_ENV})`
        : `its ${seconds(this.#limits.budgetMs)} s budget for work other than image builds and loads (${NATIVE_DETACHED_START_BUDGET_ENV})`;
    return new HackCliError({
      code: "E_STARTUP_TIMEOUT",
      message: `Native detached startup did not finish: it was ${PHASE_LABEL[this.#phase]} when ${limit} ran out, after ${seconds(now - this.#startedAt)} s. Its background owner was asked to stop and may still be unwinding. Run hack down for this instance next (it waits for that start to end and stops whatever it published), then hack up -d again; to allow longer, raise ${expiry === "ceiling" ? NATIVE_DETACHED_START_CEILING_ENV : NATIVE_DETACHED_START_BUDGET_ENV} (milliseconds).`,
    });
  }
}
