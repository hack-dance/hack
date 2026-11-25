import { expect, test } from "bun:test";
import { waitNativeComposeReady } from "../src/lib/native-compose-wait-ready.ts";

test("expired aggregate readiness deadline performs no observation", async () => {
  let reads = 0;
  expect(
    await waitNativeComposeReady({
      deadline: Date.now(),
      observe: async () => {
        reads++;
        return { ready: true };
      },
      ready: (state) => state.ready,
    })
  ).toBeNull();
  expect(reads).toBe(0);
});

test("a fresh capture is required for each readiness poll", async () => {
  const observations: number[] = [];
  const result = await waitNativeComposeReady({
    deadline: Date.now() + 2000,
    observe: async () => {
      observations.push(observations.length + 1);
      return { capture: observations.length };
    },
    ready: (state) => state.capture === 2,
  });
  expect(observations).toEqual([1, 2]);
  expect(result).toEqual({ capture: 2 });
});

test("cancellation after an unready capture stops without another poll", async () => {
  const controller = new AbortController();
  let reads = 0;
  expect(
    await waitNativeComposeReady({
      deadline: Date.now() + 2000,
      signal: controller.signal,
      observe: async () => {
        reads++;
        controller.abort("synthetic private reason");
        return { ready: false };
      },
      ready: (state) => state.ready,
    })
  ).toBeNull();
  expect(reads).toBe(1);
});

test("observation failure propagates without another acquisition", async () => {
  let reads = 0;
  await expect(
    waitNativeComposeReady({
      deadline: Date.now() + 2000,
      observe: async () => {
        reads++;
        throw new Error("fixed synthetic observation failure");
      },
      ready: () => true,
    })
  ).rejects.toThrow("fixed synthetic observation failure");
  expect(reads).toBe(1);
});

test("an injected clock alone orders polls against the deadline (HACK-2637)", async () => {
  // Virtual time far behind the wall clock: a loop that read Date.now() would not poll.
  let now = 1000;
  const backoffs: number[] = [];
  const polls: number[] = [];
  const result = await waitNativeComposeReady({
    deadline: 2200,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        backoffs.push(ms);
        now += ms;
      },
    },
    observe: async () => {
      polls.push(now);
      return { ready: false };
    },
    ready: (state) => state.ready,
  });
  expect(result).toBeNull();
  expect(polls).toEqual([1000, 1500, 2000]);
  expect(backoffs).toEqual([500, 500, 500]);
});
