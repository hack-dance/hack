import { HackCliError } from "./cli-result.ts";
import { DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS } from "./compose-startup-budget.ts";

/** Minimum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MIN_COMPOSE_DOWN_TIMEOUT_SECONDS = 0;

/** Maximum allowed stop timeout in seconds for `hack down` on the Compose backend. */
export const MAX_COMPOSE_DOWN_TIMEOUT_SECONDS = 600;

/** Project config key in `.hack/hack.config.json` for the Compose `down` stop timeout. */
export const COMPOSE_DOWN_TIMEOUT_CONFIG = "compose.downTimeoutSeconds";

/** Overall `docker compose down` subprocess cap (ms) when neither flag nor config key is set. */
export const DEFAULT_COMPOSE_DOWN_CAP_MS = DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS;

/** Fixed overhead (ms) added above `timeout * runningServices` when scaling the down cap. */
export const COMPOSE_DOWN_OVERHEAD_MS = 30_000;

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
 * Resolve the effective stop timeout (in seconds) for Compose `hack down`.
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
 *
 * - When neither `--timeout` nor `compose.downTimeoutSeconds` is set: exact default cap (90 s).
 * - When one is set: `max(90 s, timeout * runningServiceCount + 30 s)`, with no ceiling below
 *   `timeout * runningServiceCount + 30 s`.
 */
export function resolveComposeDownCapMs(opts?: {
  readonly timeoutSeconds?: number;
  readonly runningServiceCount?: number;
}): number {
  const timeoutSeconds = opts?.timeoutSeconds;
  if (timeoutSeconds === undefined) {
    return DEFAULT_COMPOSE_DOWN_CAP_MS;
  }
  if (!isValidComposeDownTimeoutSeconds(timeoutSeconds)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `Invalid Compose down timeout: must be an integer from ${MIN_COMPOSE_DOWN_TIMEOUT_SECONDS} to ${MAX_COMPOSE_DOWN_TIMEOUT_SECONDS} seconds.`,
    });
  }
  const runningServices = Math.max(
    0,
    Math.trunc(opts?.runningServiceCount ?? 1)
  );
  const scaled =
    timeoutSeconds * runningServices * 1000 + COMPOSE_DOWN_OVERHEAD_MS;
  return Math.max(DEFAULT_COMPOSE_DOWN_CAP_MS, scaled);
}

/** Explicit explanation emitted in text and JSON when the overall down cap ends `docker compose down`. */
export function formatComposeDownCapTimeoutMessage(capMs: number): string {
  const formatted =
    capMs < 1000
      ? `${Math.max(1, Math.round(capMs))}ms`
      : `${Math.round(capMs / 1000)}s`;
  return `docker compose down reached its ${formatted} cap before finishing. Pass --timeout <seconds> or set ${COMPOSE_DOWN_TIMEOUT_CONFIG}, and check services that ignore SIGTERM.`;
}
