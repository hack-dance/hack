import { isRecord } from "./guards.ts";

/**
 * Parse newline-delimited JSON ("JSON Lines") into records, ignoring malformed lines.
 *
 * This is useful for Docker's `--format json` outputs where each line is a JSON object.
 */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) {
        out.push(value);
      }
    } catch {
      // ignore bad lines
    }
  }
  return out;
}
