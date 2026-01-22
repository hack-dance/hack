import { parseDurationMs } from "./duration.ts";

export function parseTimeInput(
  raw: string,
  now: Date = new Date()
): Date | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.toLowerCase() === "now") {
    return new Date(now.getTime());
  }

  const durationMs = parseDurationMs(trimmed);
  if (durationMs) {
    return new Date(now.getTime() - durationMs);
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed);
}
