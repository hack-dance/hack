import { expect, test } from "bun:test";
import {
  INSPECT_BUSY_WAIT_MS,
  inspectNativeProjectGraph,
  OBSERVER_BUSY_WAIT_MS,
} from "../src/backends/native-project-inspect.ts";

const opts = {
  runtime: { binary: "/unused", home: "/unused" },
  projectRoot: "/fixture",
  run: "a".repeat(32),
};
test("read-only inspect retries explicit provider contention without replaying cleanup", async () => {
  let calls = 0;
  const result = await inspectNativeProjectGraph({
    ...opts,
    invoke: async (request) => {
      expect(request.args.slice(0, 2)).toEqual(["graph", "inspect"]);
      calls++;
      if (calls === 1) {
        throw new Error(
          "Native runtime request failed (provider_busy); inspect owned state before retrying."
        );
      }
      return { ready: true };
    },
  });
  expect(result).toEqual({ ready: true });
  expect(calls).toBe(2);
});
test("unknown inspection failures are never retried", async () => {
  let calls = 0;
  await expect(
    inspectNativeProjectGraph({
      ...opts,
      invoke: async () => {
        calls++;
        throw new Error("unknown");
      },
    })
  ).rejects.toThrow("unknown");
  expect(calls).toBe(1);
});
test("inspections inside mutating commands outlast contention that ends an observer's budget", async () => {
  const busy = () => {
    throw new Error(
      "Native runtime request failed (provider_busy); inspect owned state before retrying."
    );
  };
  // A holder that keeps the lease longer than the ps/logs budget.
  const contended = (until: number) => async () => {
    if (performance.now() < until) {
      busy();
    }
    return { ready: true };
  };
  const started = performance.now();
  expect(
    await inspectNativeProjectGraph({
      ...opts,
      invoke: contended(started + OBSERVER_BUSY_WAIT_MS + 300),
    })
  ).toEqual({ ready: true });
  expect(performance.now() - started).toBeGreaterThan(OBSERVER_BUSY_WAIT_MS);
  const observer = performance.now();
  await expect(
    inspectNativeProjectGraph({
      ...opts,
      busyWaitMs: OBSERVER_BUSY_WAIT_MS,
      invoke: contended(observer + OBSERVER_BUSY_WAIT_MS + 1000),
    })
  ).rejects.toThrow("provider_busy");
  expect(INSPECT_BUSY_WAIT_MS).toBeGreaterThan(OBSERVER_BUSY_WAIT_MS);
}, 15_000);
test("an aborted caller stops waiting out lease contention", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = inspectNativeProjectGraph({
    ...opts,
    signal: controller.signal,
    invoke: async () => {
      calls++;
      if (calls === 2) {
        controller.abort();
      }
      throw new Error(
        "Native runtime request failed (provider_busy); inspect owned state before retrying."
      );
    },
  });
  await expect(pending).rejects.toThrow("provider_busy");
  expect(calls).toBe(2);
});
