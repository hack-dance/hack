import { expect, test } from "bun:test";

import { createRefreshScheduler } from "../src/daemon/refresh-scheduler.ts";

test("refresh scheduler coalesces an event storm into one bounded follow-up", async () => {
  let releaseFirstRefresh = (): void => {};
  const firstRefresh = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });
  const calls: Array<{ reason: string; forceInspect: boolean }> = [];
  const scheduler = createRefreshScheduler({
    debounceMs: 2,
    minIntervalMs: 2,
    maxWaitMs: 10,
    refresh: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        await firstRefresh;
      }
    },
  });

  for (let index = 0; index < 100; index += 1) {
    scheduler.request({ reason: "event", urgency: "debounced" });
  }
  await waitFor({ predicate: () => calls.length === 1 });
  for (let index = 0; index < 100; index += 1) {
    scheduler.request({ reason: "event", urgency: "debounced" });
  }
  releaseFirstRefresh();
  await waitFor({ predicate: () => calls.length === 2 });
  await Bun.sleep(20);

  expect(calls).toEqual([
    { reason: "event", forceInspect: false },
    { reason: "event", forceInspect: false },
  ]);
  scheduler.stop();
});

test("immediate refresh upgrades pending event work and forces inspection", async () => {
  const calls: Array<{ reason: string; forceInspect: boolean }> = [];
  const scheduler = createRefreshScheduler({
    debounceMs: 20,
    minIntervalMs: 20,
    maxWaitMs: 40,
    refresh: async (request) => {
      calls.push(request);
    },
  });

  scheduler.request({ reason: "event", urgency: "debounced" });
  scheduler.request({ reason: "interval", urgency: "immediate" });
  await waitFor({ predicate: () => calls.length === 1 });

  expect(calls).toEqual([{ reason: "interval", forceInspect: true }]);
  scheduler.stop();
});

async function waitFor(opts: {
  readonly predicate: () => boolean;
  readonly timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const startedAtMs = Date.now();
  while (!opts.predicate()) {
    if (Date.now() - startedAtMs > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(1);
  }
}
