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
 * Overall subprocess cap (ms) for `docker compose down`.
 * Never drops below the existing 90 s floor, scales above it for larger valid `--timeout`
 * values, and caps at 15 minutes (`MAX_COMPOSE_DOWN_CAP_MS`).
 */
export function resolveComposeDownCapMs(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) {
    return DEFAULT_COMPOSE_DOWN_CAP_MS;
  }
  if (!isValidComposeDownTimeoutSeconds(timeoutSeconds)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `Invalid Compose down timeout: must be an integer from ${MIN_COMPOSE_DOWN_TIMEOUT_SECONDS} to ${MAX_COMPOSE_DOWN_TIMEOUT_SECONDS} seconds.`,
    });
  }
  const scaled =
    timeoutSeconds * COMPOSE_DOWN_CAP_WAVES * 1000 + COMPOSE_DOWN_OVERHEAD_MS;
  return Math.min(
    MAX_COMPOSE_DOWN_CAP_MS,
    Math.max(DEFAULT_COMPOSE_DOWN_CAP_MS, scaled)
  );
}
