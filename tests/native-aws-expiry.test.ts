import { expect, test } from "bun:test";
import {
  NATIVE_AWS_EXPIRY_LEAD_MS,
  nativeAwsExpiryMessage,
  scheduleNativeAwsExpiryWarnings,
} from "../src/backends/native-aws-expiry.ts";

function fakeClock(start: number) {
  let now = start;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimer: (run: () => void, delay: number) => {
        const id = (next += 1);
        pending.set(id, { at: now + delay, run });
        return { id };
      },
      clearTimer: (timer: unknown) => {
        pending.delete((timer as { id: number }).id);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    pending: () => pending.size,
  };
}
const start = Date.parse("2026-09-20T12:00:00Z");
const expiry = new Date(start + 60 * 60_000).toISOString();

test("warns once ten minutes before expiry and once at expiry, value-free", () => {
  const time = fakeClock(start);
  const lines: string[] = [];
  scheduleNativeAwsExpiryWarnings({
    expiry,
    services: 3,
    write: (line) => lines.push(line),
    clock: time.clock,
  });
  time.advance(60 * 60_000 - NATIVE_AWS_EXPIRY_LEAD_MS - 1);
  expect(lines).toEqual([]);
  time.advance(1);
  expect(lines).toEqual([
    nativeAwsExpiryMessage({
      services: 3,
      expiry: Date.parse(expiry),
      expired: false,
    }),
  ]);
  expect(lines[0]).toMatch(
    /^AWS credentials delivered to 3 services expire at \d\d:\d\d; run hack restart to renew\.$/
  );
  time.advance(NATIVE_AWS_EXPIRY_LEAD_MS);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(
    /^AWS credentials delivered to 3 services expired at \d\d:\d\d; run hack restart to renew\.$/
  );
  expect(time.pending()).toBe(0);
});

test("cancellation clears pending warnings and near expiry warns immediately", () => {
  const time = fakeClock(start);
  const lines: string[] = [];
  const cancel = scheduleNativeAwsExpiryWarnings({
    expiry,
    services: 1,
    write: (line) => lines.push(line),
    clock: time.clock,
  });
  expect(time.pending()).toBe(2);
  cancel();
  expect(time.pending()).toBe(0);
  time.advance(2 * 60 * 60_000);
  expect(lines).toEqual([]);
  const soon = fakeClock(start);
  scheduleNativeAwsExpiryWarnings({
    expiry: new Date(start + 5 * 60_000).toISOString(),
    services: 1,
    write: (line) => lines.push(line),
    clock: soon.clock,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("delivered to 1 service expire at");
  soon.advance(5 * 60_000);
  expect(lines).toHaveLength(2);
  for (const invalid of ["not-a-date", ""]) {
    expect(
      scheduleNativeAwsExpiryWarnings({
        expiry: invalid,
        services: 1,
        write: (line) => lines.push(line),
        clock: soon.clock,
      })()
    ).toBeUndefined();
  }
  expect(lines).toHaveLength(2);
});
