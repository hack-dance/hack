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
      /**
       * No test in the Compose file: the engine uses the image's own
       * `HEALTHCHECK`, if it has one. Not inspected, so unknown.
       */
      readonly kind: "image-default";
    }
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
    }
  | {
      /** Native review refuses this service's health settings; it does not start. */
      readonly kind: "native-refuses";
      readonly reason: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Compose labels in either form (mapping, or `key=value` list) as a map. */
function labelMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const at = item.indexOf("=");
        result[at < 0 ? item : item.slice(0, at)] =
          at < 0 ? "" : item.slice(at + 1);
      }
    }
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      result[key] = String(item);
    }
  }
  return result;
}

/**
 * Routed as native review reads it (runtime-core
 * `project/compose/routing.rs`): `caddy` with `caddy.reverse_proxy`. A
 * `caddy` host without a reverse proxy is an inert declaration and gets no
 * route probe.
 */
function routed(service: Record<string, unknown>): boolean {
  const labels = labelMap(service.labels);
  return "caddy" in labels && "caddy.reverse_proxy" in labels;
}

function disabled(health: Record<string, unknown>): boolean {
  const test = health.test;
  return health.disable === true || (Array.isArray(test) && test[0] === "NONE");
}

/** How the engine runs a `healthcheck` mapping (or its absence). */
function engineHealth(health: Record<string, unknown> | null): LaneHealth {
  if (health === null || health.test === undefined) {
    return health !== null && disabled(health)
      ? { kind: "none" }
      : { kind: "image-default" };
  }
  if (disabled(health)) {
    return { kind: "none" };
  }
  const test = health.test;
  return {
    kind: "engine-command",
    test: Array.isArray(test) ? test.map(String).join(" ") : String(test),
    interval: text(health.interval),
    startPeriod: text(health.start_period),
    startInterval: text(health.start_interval),
  };
}

/**
 * Native's choice, following its Compose review (runtime-core
 * `project/compose/service.rs`): a declared `x-hack-http` probe runs on any
 * service; a routed service with no `healthcheck` key, or with an enabled
 * command check, gets an inferred `GET /` route probe instead; a routed
 * service whose check is disabled is refused; anything else runs in the
 * engine as on Compose.
 */
function nativeHealth(
  service: Record<string, unknown>,
  health: Record<string, unknown> | null
): LaneHealth {
  if (health !== null && "x-hack-http" in health) {
    return {
      kind: "native-route-probe",
      source: "declared",
      replaces: "nothing",
    };
  }
  if (!routed(service)) {
    return engineHealth(health);
  }
  if (health === null) {
    return {
      kind: "native-route-probe",
      source: "inferred",
      replaces: "nothing",
    };
  }
  const engine = engineHealth(health);
  if (engine.kind === "engine-command") {
    return {
      kind: "native-route-probe",
      source: "inferred",
      replaces: "command-check",
    };
  }
  if (engine.kind === "none") {
    return {
      kind: "native-refuses",
      reason: "a routed service's health check is disabled",
    };
  }
  // A `healthcheck` key with no test: native neither infers a probe nor runs
  // one, and its route admission needs one.
  return {
    kind: "native-refuses",
    reason: "a routed service's health check has no test",
  };
}

/**
 * The health check each service runs on one lane, from the project's Compose
 * file alone. Compose runs command checks in the engine and ignores
 * `x-hack-http`; without a test it uses the image's own check, reported as
 * `image-default` because images are not inspected.
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
    result[name] =
      opts.lane === "native"
        ? nativeHealth(service, health)
        : engineHealth(health);
  }
  return result;
}

/** Services whose Compose-lane check comes from the image and was not read. */
export function unknownHealthChecks(compose: unknown): string[] {
  return Object.entries(laneHealthChecks({ compose, lane: "compose" }))
    .filter(([, health]) => health.kind === "image-default")
    .map(([name]) => name)
    .sort();
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
