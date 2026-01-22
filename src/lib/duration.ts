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
