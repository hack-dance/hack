import { expect, test } from "bun:test";
import {
  createNativeComposeStartDeadline,
  DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  DEFAULT_NATIVE_STORAGE_TIMEOUT_MS,
  resolveComposeImageTimeoutMs,
  resolveComposeStartupTimeoutMs,
  resolveNativeStorageTimeoutMs,
} from "../src/lib/compose-startup-budget.ts";

test("startup budget defaults and explicit numeric precedence", () => {
  expect(resolveComposeStartupTimeoutMs({ env: {} })).toBe(
    DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS
  );
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "600000" },
    })
  ).toBe(600_000);
  expect(
    resolveComposeStartupTimeoutMs({
      startupTimeoutMs: 120_000,
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "invalid" },
    })
  ).toBe(120_000);
  for (const value of [1000, 3_600_000]) {
    expect(resolveComposeStartupTimeoutMs({ startupTimeoutMs: value })).toBe(
      value
    );
  }
});

test("startup budget rejects malformed or out-of-bounds settings without echoing input", () => {
  for (const value of [
    "",
    " 1000",
    "1e4",
    "1000.0",
    "+1000",
    "999",
    "3600001",
    "Infinity",
    "private-input",
  ]) {
    expect(() =>
      resolveComposeStartupTimeoutMs({
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: value },
      })
    ).toThrow("integer from 1000 to 3600000");
  }
  for (const value of [
    0,
    -1,
    999,
    3_600_001,
    1000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(() =>
      resolveComposeStartupTimeoutMs({ startupTimeoutMs: value })
    ).toThrow();
  }
});

test("image build/pull budget is separate, defaults to 30 minutes and allows up to 4 hours", () => {
  expect(resolveComposeImageTimeoutMs({ env: {} })).toBe(
    DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS
  );
  expect(DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS).toBe(1_800_000);
  // The startup budget never sizes the image phase, and vice versa.
  expect(
    resolveComposeImageTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000" },
    })
  ).toBe(1_800_000);
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: "14400000" },
    })
  ).toBe(DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS);
  expect(
    resolveComposeImageTimeoutMs({
      env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: "14400000" },
    })
  ).toBe(14_400_000);
  for (const value of ["999", "14400001", "1e6", "private-input"]) {
    expect(() =>
      resolveComposeImageTimeoutMs({
        env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: value },
      })
    ).toThrow("HACK_COMPOSE_IMAGE_TIMEOUT_MS");
  }
});

test("native storage budget is named, finite and independent of the start budget", () => {
  expect(DEFAULT_NATIVE_STORAGE_TIMEOUT_MS).toBe(90_000);
  expect(resolveNativeStorageTimeoutMs({ env: {} })).toBe(
    DEFAULT_NATIVE_STORAGE_TIMEOUT_MS
  );
  // A short start budget never shortens storage carriers, and vice versa.
  expect(
    resolveNativeStorageTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "15000" },
    })
  ).toBe(DEFAULT_NATIVE_STORAGE_TIMEOUT_MS);
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_NATIVE_STORAGE_TIMEOUT_MS: "600000" },
    })
  ).toBe(DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS);
  for (const value of ["1000", "600000"]) {
    expect(
      resolveNativeStorageTimeoutMs({
        env: { HACK_NATIVE_STORAGE_TIMEOUT_MS: value },
      })
    ).toBe(Number(value));
  }
  expect(
    resolveNativeStorageTimeoutMs({
      storageTimeoutMs: 120_000,
      env: { HACK_NATIVE_STORAGE_TIMEOUT_MS: "invalid" },
    })
  ).toBe(120_000);
  for (const value of ["", "999", "600001", "1e5", "+1000", "private-input"]) {
    expect(() =>
      resolveNativeStorageTimeoutMs({
        env: { HACK_NATIVE_STORAGE_TIMEOUT_MS: value },
      })
    ).toThrow(
      "integer from 1000 to 600000 milliseconds (HACK_NATIVE_STORAGE_TIMEOUT_MS)"
    );
  }
  for (const value of [0, 999, 600_001, 1000.5, Number.POSITIVE_INFINITY]) {
    expect(() =>
      resolveNativeStorageTimeoutMs({ storageTimeoutMs: value })
    ).toThrow();
  }
});

function fakeClocks() {
  const clock = { wall: 1_000_000, monotonic: 50 };
  return {
    clock,
    advance(ms: number) {
      clock.wall += ms;
      clock.monotonic += ms;
    },
    options: {
      wallNow: () => clock.wall,
      monotonicNow: () => clock.monotonic,
    },
  };
}

test("start deadline is consumed by start work but not by excluded storage proofs", async () => {
  const { advance, options } = fakeClocks();
  const start = createNativeComposeStartDeadline({
    timeoutMs: 15_000,
    ...options,
  });
  expect(start.deadline()).toBe(1_015_000);
  // Ordinary start work consumes the budget: the deadline does not move.
  advance(4000);
  expect(start.deadline()).toBe(1_015_000);
  // A 40 s storage proof extends the deadline by exactly its own duration.
  const value = await start.excludeStorage(async () => {
    advance(10_000);
    // While the proof runs, its elapsed time already extends the deadline.
    expect(start.deadline()).toBe(1_025_000);
    advance(30_000);
    return "proved";
  });
  expect(value).toBe("proved");
  expect(start.deadline()).toBe(1_055_000);
  advance(1000);
  expect(start.deadline()).toBe(1_055_000);
});

test("rejected and overlapping storage proofs are excluded once and the deadline never moves earlier", async () => {
  const { advance, options } = fakeClocks();
  const start = createNativeComposeStartDeadline({
    timeoutMs: 15_000,
    ...options,
  });
  const failure = new Error("synthetic storage refusal");
  await expect(
    start.excludeStorage(async () => {
      advance(5000);
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(start.deadline()).toBe(1_020_000);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: number[] = [];
  const outer = start.excludeStorage(async () => {
    advance(2000);
    seen.push(start.deadline());
    await start.excludeStorage(async () => {
      advance(3000);
      seen.push(start.deadline());
    });
    seen.push(start.deadline());
    await gate;
    advance(1000);
  });
  release();
  await outer;
  seen.push(start.deadline());
  // Nested proofs overlap: 6 s of wall time is excluded once, not 9 s.
  expect(seen).toEqual([1_022_000, 1_025_000, 1_025_000, 1_026_000]);
});

test("monotonic exclusion ignores wall-clock steps during a storage proof", async () => {
  const { clock, options } = fakeClocks();
  const start = createNativeComposeStartDeadline({
    timeoutMs: 15_000,
    ...options,
  });
  await start.excludeStorage(async () => {
    // The wall clock steps back a minute while 7 s of monotonic time passes.
    clock.wall -= 60_000;
    clock.monotonic += 7000;
  });
  expect(start.deadline()).toBe(1_022_000);
});
