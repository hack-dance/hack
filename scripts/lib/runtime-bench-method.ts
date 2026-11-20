/**
 * Pure parts of the runtime footprint benchmark's method: how readiness is
 * polled, and what health checks each lane runs for a project. Kept out of the
 * benchmark script so they can be tested without a runtime.
 */

/** How the benchmark waits for a start to become ready. */
export type ReadinessMode = {
  /** Pause between two polls, in milliseconds. */
  readonly pollMs: number;
  /** Check every route at once (true) or one after the other (false). */
  readonly concurrent: boolean;
};

/** The default: every route at once, 20 ms between polls. */
export const EXACT_READINESS: ReadinessMode = { pollMs: 20, concurrent: true };

/**
 * The method before Nov 2026: routes one after the other, 500 ms between
 * polls. It adds up to about half a second to each start sample; keep it only
 * to compare with earlier results.
 */
export const LEGACY_READINESS: ReadinessMode = {
  pollMs: 500,
  concurrent: false,
};

/** True when every check passes; runs them as the mode says. */
export async function allPass(
  checks: readonly (() => Promise<boolean>)[],
  mode: ReadinessMode
): Promise<boolean> {
  if (mode.concurrent) {
    const results = await Promise.all(checks.map((check) => check()));
    return results.every(Boolean);
  }
  for (const check of checks) {
    if (!(await check())) {
      return false;
    }
  }
  return true;
}

/**
 * Polls `isReady` until it answers true or `timeoutMs` passes. Returns the
 * time from the call to the first true answer's completion, or null.
 */
export async function pollUntil(opts: {
  readonly isReady: () => Promise<boolean>;
  readonly mode: ReadinessMode;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<number | null> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const started = now();
  while (now() - started < opts.timeoutMs) {
    if (await opts.isReady()) {
      return now() - started;
    }
    await sleep(opts.mode.pollMs);
  }
  return null;
}

/** One service's health check as a lane runs it. */
export type LaneHealth =
  | { readonly kind: "none" }
  | {
      readonly kind: "engine-command";
      readonly test: string;
      readonly interval: string | null;
      readonly startPeriod: string | null;
      readonly startInterval: string | null;
    }
  | {
      readonly kind: "native-route-probe";
      readonly source: "declared" | "inferred";
      /** Why native probes the route: declared, no check, or a replaced command check. */
      readonly replaces: "nothing" | "command-check";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function routed(service: Record<string, unknown>): boolean {
  return isRecord(service.labels) && typeof service.labels.caddy === "string";
}

function commandHealth(health: Record<string, unknown>): LaneHealth {
  const test = health.test;
  const disabled =
    health.disable === true ||
    (Array.isArray(test) && test[0] === "NONE") ||
    test === undefined;
  if (disabled) {
    return { kind: "none" };
  }
  return {
    kind: "engine-command",
    test: Array.isArray(test) ? test.map(String).join(" ") : String(test),
    interval: text(health.interval),
    startPeriod: text(health.start_period),
    startInterval: text(health.start_interval),
  };
}

/**
 * The health check each service runs on one lane, from the project's Compose
 * file. Compose runs command checks in the engine and ignores `x-hack-http`.
 * Native runs non-routed command checks in its engine too, but probes every
 * routed service's route itself: a declared `x-hack-http` probe, or an
 * inferred `GET /` probe that also replaces a command check. Image health
 * checks (no `healthcheck` key) are not read and show as `none`.
 */
export function laneHealthChecks(opts: {
  readonly compose: unknown;
  readonly lane: "compose" | "native";
}): Record<string, LaneHealth> {
  const services = isRecord(opts.compose) ? opts.compose.services : undefined;
  const result: Record<string, LaneHealth> = {};
  if (!isRecord(services)) {
    return result;
  }
  for (const [name, raw] of Object.entries(services)) {
    const service = isRecord(raw) ? raw : {};
    const health = isRecord(service.healthcheck) ? service.healthcheck : null;
    if (opts.lane === "native" && routed(service)) {
      if (health && "x-hack-http" in health) {
        result[name] = {
          kind: "native-route-probe",
          source: "declared",
          replaces: "nothing",
        };
        continue;
      }
      result[name] = {
        kind: "native-route-probe",
        source: "inferred",
        replaces:
          health && commandHealth(health).kind === "engine-command"
            ? "command-check"
            : "nothing",
      };
      continue;
    }
    result[name] = health ? commandHealth(health) : { kind: "none" };
  }
  return result;
}

/**
 * Services whose health check differs between the two lanes for a reason
 * other than the backend's own route probe: a command check that Compose runs
 * but native replaces. Such a check costs CPU on one lane only.
 */
export function unevenHealthChecks(compose: unknown): string[] {
  const native = laneHealthChecks({ compose, lane: "native" });
  return Object.entries(native)
    .filter(
      ([, health]) =>
        health.kind === "native-route-probe" &&
        health.replaces === "command-check"
    )
    .map(([name]) => name)
    .sort();
}
