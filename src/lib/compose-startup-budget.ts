import { CliUsageError } from "../cli/command.ts";

export const DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS = 90_000;
const MIN_STARTUP_TIMEOUT_MS = 1000;
const MAX_STARTUP_TIMEOUT_MS = 3_600_000;
const INTEGER_TEXT = /^[0-9]+$/;

/** Total detached Compose invocation budget, not a readiness or per-phase guarantee. */
export function resolveComposeStartupTimeoutMs(
  opts: {
    readonly startupTimeoutMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): number {
  const configured = (opts.env ?? process.env).HACK_COMPOSE_STARTUP_TIMEOUT_MS;
  let timeout = opts.startupTimeoutMs;
  if (timeout === undefined) {
    if (configured === undefined) {
      return DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS;
    }
    if (!INTEGER_TEXT.test(configured)) {
      throw invalidBudget();
    }
    timeout = Number(configured);
  }
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_STARTUP_TIMEOUT_MS ||
    timeout > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw invalidBudget();
  }
  return timeout;
}

function invalidBudget(): CliUsageError {
  return new CliUsageError(
    "Compose startup timeout must be an integer from 1000 to 3600000 milliseconds (HACK_COMPOSE_STARTUP_TIMEOUT_MS)"
  );
}
