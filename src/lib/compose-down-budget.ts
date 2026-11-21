import { HackCliError } from "./cli-result.ts";

/** Minimum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MIN_COMPOSE_DOWN_TIMEOUT_SECONDS = 0;

/** Maximum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MAX_COMPOSE_DOWN_TIMEOUT_SECONDS = 600;

/** Project config key in `.hack/hack.config.json` for the Compose `down` stop timeout. */
export const COMPOSE_DOWN_TIMEOUT_CONFIG = "compose.downTimeoutSeconds";

/** Docker Engine's default stop grace period when `docker compose down --timeout` is omitted. */
export const DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS = 10;

/**
 * Number of reverse-dependency stop levels budgeted into the overall `docker compose down`
 * subprocess cap. Docker Compose stops services in reverse dependency order, so a service
 * that ignores SIGTERM can wait out the full per-container stop timeout once per level.
 */
export const COMPOSE_DOWN_DEPENDENCY_LEVELS = 6;

/**
 * Fixed overhead allowance (ms) on top of per-level stop grace periods for Docker client
 * startup, container removal, and network teardown.
 */
export const COMPOSE_DOWN_OVERHEAD_MS = 30_000;

/**
 * Overall subprocess cap (ms) for `docker compose down` when no stop timeout is configured.
 *
 * Derived from {@link DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS} across
 * {@link COMPOSE_DOWN_DEPENDENCY_LEVELS} reverse-dependency stop waves plus
 * {@link COMPOSE_DOWN_OVERHEAD_MS} of teardown overhead (= 90 s). Kept independent of
 * `DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS` so stop budgets scale with the stop timeout rather
 * than start-up settings.
 */
export const DEFAULT_COMPOSE_DOWN_CAP_MS =
  DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS * COMPOSE_DOWN_DEPENDENCY_LEVELS * 1000 +
  COMPOSE_DOWN_OVERHEAD_MS;

const INTEGER_TEXT = /^[0-9]+$/;

function isValidComposeDownTimeoutSeconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_COMPOSE_DOWN_TIMEOUT_SECONDS &&
    value <= MAX_COMPOSE_DOWN_TIMEOUT_SECONDS
  );
}

/**
 * Parse and validate `--timeout <seconds>` for Compose `hack down`.
 * Unset returns `undefined` (so `docker compose down` is called without `--timeout`).
 * Non-integer or out-of-range values are refused with `E_USAGE`, never clamped.
 */
export function parseComposeDownTimeoutFlag(
  raw: string | undefined
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (INTEGER_TEXT.test(trimmed)) {
    const parsed = Number(trimmed);
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
 * Resolve the effective stop timeout (in seconds) for Compose `hack down`.
 * Precedence: `--timeout` CLI flag > `compose.downTimeoutSeconds` in `.hack/hack.config.json` > unset.
 * Invalid flag values refuse with `E_USAGE`; invalid project config values refuse with
 * `E_CONFIG_INVALID`. Values are never clamped.
 */
export function resolveComposeDownTimeoutSeconds(opts: {
  readonly flagValue?: string;
  readonly projectValue?: number;
}): number | undefined {
  const fromFlag = parseComposeDownTimeoutFlag(opts.flagValue);
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
 * Overall subprocess cap (ms) for `docker compose down`, derived from the stop timeout.
 *
 * Compose stops services in reverse dependency order, so a stack with services that ignore
 * SIGTERM can wait out `stopTimeoutSeconds` once per dependency level before teardown
 * removes containers and networks. Scaling the cap from the configured stop timeout keeps
 * low timeouts bounded tightly while preventing a higher valid `--timeout` (up to 600 s)
 * from being killed prematurely by a fixed 90 s start-up constant.
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
  return (
    timeoutSeconds * COMPOSE_DOWN_DEPENDENCY_LEVELS * 1000 +
    COMPOSE_DOWN_OVERHEAD_MS
  );
}
