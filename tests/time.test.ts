import { expect, test } from "bun:test";

import { parseTimeInput } from "../src/lib/time.ts";

test("parseTimeInput supports durations and now", () => {
  const now = new Date("2025-01-02T03:04:05Z");
  expect(parseTimeInput("now", now)?.toISOString()).toBe(
    "2025-01-02T03:04:05.000Z"
  );
  expect(parseTimeInput("15m", now)?.toISOString()).toBe(
    "2025-01-02T02:49:05.000Z"
  );
});

test("parseTimeInput supports RFC3339 timestamps", () => {
  const parsed = parseTimeInput("2025-01-01T00:00:00Z");
  expect(parsed?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
});

test("parseTimeInput rejects invalid inputs", () => {
  expect(parseTimeInput("not-a-time")).toBeNull();
  expect(parseTimeInput("")).toBeNull();
});
