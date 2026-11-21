import { HackCliError } from "./cli-result.ts";

/** Minimum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MIN_COMPOSE_DOWN_TIMEOUT_SECONDS = 0;

/** Maximum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MAX_COMPOSE_DOWN_TIMEOUT_SECONDS = 600;

/** Project config key in `.hack/hack.config.json` for the Compose `down` stop timeout. */
export const COMPOSE_DOWN_TIMEOUT_CONFIG = "compose.downTimeoutSeconds";

/** Docker Engine's default stop grace period when neither `--timeout` nor `stop_grace_period` is set. */
export const DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS = 10;

/** Floor for the overall `docker compose down` subprocess cap (matches the previous 90 s bound). */
export const DEFAULT_COMPOSE_DOWN_CAP_MS = 90_000;

/** Hard upper bound (ms) for the overall `docker compose down` subprocess cap even at `--timeout 600`. */
export const MAX_COMPOSE_DOWN_CAP_MS = 900_000;

/** Fixed overhead (ms) added above per-wave stop grace periods when scaling the down cap. */
export const COMPOSE_DOWN_OVERHEAD_MS = 30_000;

/** Reverse-dependency stop waves scaled when `--timeout` exceeds the 90 s floor. */
export const COMPOSE_DOWN_CAP_WAVES = 2;

const CANONICAL_NON_NEGATIVE_INT = /^(?:0|[1-9][0-9]*)$/;

function isValidComposeDownTimeoutSeconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_COMPOSE_DOWN_TIMEOUT_SECONDS &&
    value <= MAX_COMPOSE_DOWN_TIMEOUT_SECONDS
  );
}

/**
 * Parse and validate `--timeout <seconds>` for Compose `hack down`.
 * Accepts only canonical base-10 integers `0`..`600` (no whitespace or leading zeros).
 * Unset returns `undefined` so `docker compose down` runs without `--timeout`.
 */
export function parseComposeDownTimeoutFlag(
  raw: string | undefined
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (CANONICAL_NON_NEGATIVE_INT.test(raw)) {
    const parsed = Number(raw);
    if (isValidComposeDownTimeoutSeconds(parsed)) {
      return parsed;
    }
  }
  throw new HackCliError({
    code: "E_USAGE",
    message: `Invalid --timeout value (${JSON.stringify(raw)}): must be an integer from ${MIN_COMPOSE_DOWN_TIMEOUT_SECONDS} to ${MAX_COMPOSE_DOWN_TIMEOUT_SECONDS} seconds.`,
  });
}

/**
 * Resolve the effective stop timeout (in seconds) for Compose `hack down` / `hack restart`.
 * Precedence: CLI `--timeout` > `compose.downTimeoutSeconds` in `.hack/hack.config.json` > unset.
 * Never clamps out-of-range values.
 */
export function resolveComposeDownTimeoutSeconds(opts: {
  readonly flagValue?: string;
  readonly flagTimeoutSeconds?: number;
  readonly projectValue?: number;
}): number | undefined {
  const fromFlag =
    opts.flagTimeoutSeconds ?? parseComposeDownTimeoutFlag(opts.flagValue);
  if (fromFlag !== undefined) {
    return fromFlag;
  }
  if (opts.projectValue === undefined) {
    return undefined;
  }
  if (isValidComposeDownTimeoutSeconds(opts.projectValue)) {
    return opts.projectValue;
  }
  throw new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `Invalid ${COMPOSE_DOWN_TIMEOUT_CONFIG} in .hack/hack.config.json: must be an integer from ${MIN_COMPOSE_DOWN_TIMEOUT_SECONDS} to ${MAX_COMPOSE_DOWN_TIMEOUT_SECONDS} seconds.`,
  });
}

/**
 * Static service stop graph parsed from `.hack/docker-compose.yml` for sizing
 * the overall `docker compose down` subprocess cap.
 */
export type ComposeStopGraph = {
  readonly defined: ReadonlySet<string>;
  readonly serviceGraceMs: ReadonlyMap<string, number>;
  readonly dependsOn: ReadonlyMap<string, readonly string[]>;
};

/**
 * Compute the longest sequential stop-grace chain (ms) across a Compose dependency graph.
 * Compose stops dependents before their dependencies and stops independent siblings in parallel.
 * When `--timeout` (`timeoutSeconds`) is set, it overrides every service's `stop_grace_period`.
 * Falls back to summing all service grace periods if a dependency cycle is present.
 */
export function computeComposeDownCriticalPathMs(opts: {
  readonly graph: ComposeStopGraph;
  readonly timeoutSeconds?: number;
}): number {
  const { graph, timeoutSeconds } = opts;
  if (graph.defined.size === 0) {
    return (timeoutSeconds ?? DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS) * 1000;
  }
  const graceFor = (service: string): number =>
    timeoutSeconds !== undefined
      ? timeoutSeconds * 1000
      : (graph.serviceGraceMs.get(service) ??
        DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS * 1000);

  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  let sawCycle = false;

  const visit = (service: string): number => {
    const cached = memo.get(service);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(service)) {
      sawCycle = true;
      return 0;
    }
    visiting.add(service);
    let deepestDep = 0;
    for (const dep of graph.dependsOn.get(service) ?? []) {
      if (!graph.defined.has(dep)) {
        continue;
      }
      deepestDep = Math.max(deepestDep, visit(dep));
    }
    visiting.delete(service);
    const total = graceFor(service) + deepestDep;
    memo.set(service, total);
    return total;
  };

  let criticalMs = 0;
  for (const service of graph.defined) {
    criticalMs = Math.max(criticalMs, visit(service));
  }
  if (sawCycle) {
    let sumMs = 0;
    for (const service of graph.defined) {
      sumMs += graceFor(service);
    }
    return sumMs;
  }
  return criticalMs;
}

/**
 * Overall subprocess cap (ms) for `docker compose down`.
 *
 * Keeps the 90 s floor (`DEFAULT_COMPOSE_DOWN_CAP_MS`), derives required wait time from
 * the project's actual Compose dependency stop chain and per-service `stop_grace_period`
 * (or explicit `--timeout` override) plus 30 s overhead when the Compose graph is available,
 * and bounds the total cap at 15 minutes (`MAX_COMPOSE_DOWN_CAP_MS`).
 */
export function resolveComposeDownCapMs(
  timeoutSeconds?: number,
  opts?: { readonly graph?: ComposeStopGraph }
): number {
  if (
    timeoutSeconds !== undefined &&
    !isValidComposeDownTimeoutSeconds(timeoutSeconds)
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `Invalid Compose down timeout: must be an integer from ${MIN_COMPOSE_DOWN_TIMEOUT_SECONDS} to ${MAX_COMPOSE_DOWN_TIMEOUT_SECONDS} seconds.`,
    });
  }
  if (opts?.graph && opts.graph.defined.size > 0) {
    const criticalMs = computeComposeDownCriticalPathMs({
      graph: opts.graph,
      timeoutSeconds,
    });
    const required = criticalMs + COMPOSE_DOWN_OVERHEAD_MS;
    return Math.min(
      MAX_COMPOSE_DOWN_CAP_MS,
      Math.max(DEFAULT_COMPOSE_DOWN_CAP_MS, required)
    );
  }
  if (timeoutSeconds === undefined) {
    return DEFAULT_COMPOSE_DOWN_CAP_MS;
  }
  const scaled =
    timeoutSeconds * COMPOSE_DOWN_CAP_WAVES * 1000 + COMPOSE_DOWN_OVERHEAD_MS;
  return Math.min(
    MAX_COMPOSE_DOWN_CAP_MS,
    Math.max(DEFAULT_COMPOSE_DOWN_CAP_MS, scaled)
  );
}
