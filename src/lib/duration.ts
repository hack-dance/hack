import { CliUsageError } from "../cli/command.ts";

const INTEGER_TEXT = /^[0-9]+$/;
const DURATION_PATTERN = /^(\d+)\s*([smhdw])$/i;

export function parseDurationMs(input: string): number | null {
  const raw = input.trim();
  const match = raw.match(DURATION_PATTERN);
  if (!match) {
    return null;
  }

  const numRaw = match[1];
  const unitRaw = match[2]?.toLowerCase();
  if (!(numRaw && unitRaw)) {
    return null;
  }

  const n = Number.parseInt(numRaw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }

  let unitMs: number | null;
  if (unitRaw === "s") {
    unitMs = 1000;
  } else if (unitRaw === "m") {
    unitMs = 60_000;
  } else if (unitRaw === "h") {
    unitMs = 3_600_000;
  } else if (unitRaw === "d") {
    unitMs = 86_400_000;
  } else if (unitRaw === "w") {
    unitMs = 604_800_000;
  } else {
    unitMs = null;
  }

  if (unitMs === null) {
    return null;
  }

  const ms = n * unitMs;
  return Number.isFinite(ms) ? ms : null;
}

const HOURS_PER_UNIT: Readonly<Record<string, number>> = { d: 24, w: 168 };

/**
 * A `--since`/`--until` value in the form `docker logs` accepts. Hack's
 * durations allow `d` and `w`, which Docker (Go durations) does not, so
 * `2d` becomes `48h` and `1w` `168h`; `10 m` becomes `10m`. Anything else
 * (a timestamp, a Go duration such as `1h30m`) is passed unchanged.
 */
export function dockerLogsTime(input: string): string {
  const raw = input.trim();
  const match = raw.match(DURATION_PATTERN);
  if (!(match?.[1] && match[2])) {
    return raw;
  }
  const unit = match[2].toLowerCase();
  const hours = HOURS_PER_UNIT[unit];
  return hours === undefined
    ? `${match[1]}${unit}`
    : `${Number.parseInt(match[1], 10) * hours}h`;
}

/** Shortest deadline accepted from a millisecond override variable. */
export const MIN_TIMEOUT_OVERRIDE_MS = 1000;

/**
 * Resolve a millisecond deadline from an environment override.
 *
 * Unset uses `fallback`. A set value must be an integer from
 * {@link MIN_TIMEOUT_OVERRIDE_MS} to `max`; anything else is refused with a
 * fixed {@link CliUsageError} that names the variable and the range and never
 * repeats the supplied text.
 */
export function resolveTimeoutOverrideMs(input: {
  readonly name: string;
  readonly fallback: number;
  readonly max: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): number {
  const raw = (input.env ?? process.env)[input.name];
  if (raw === undefined) {
    return input.fallback;
  }
  const parsed = INTEGER_TEXT.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_TIMEOUT_OVERRIDE_MS ||
    parsed > input.max
  ) {
    throw new CliUsageError(
      `${input.name} must be an integer from ${MIN_TIMEOUT_OVERRIDE_MS} to ${input.max} milliseconds.`
    );
  }
  return parsed;
}
