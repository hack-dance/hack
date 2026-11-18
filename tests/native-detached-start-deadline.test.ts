import { expect, test } from "bun:test";
import {
  DEFAULT_NATIVE_DETACHED_START_BUDGET_MS,
  DEFAULT_NATIVE_DETACHED_START_CEILING_MS,
  NATIVE_DETACHED_START_BUDGET_ENV,
  NATIVE_DETACHED_START_CEILING_ENV,
  NativeDetachedStartDeadline,
  resolveNativeDetachedStartLimits,
} from "../src/lib/native-detached-start-deadline.ts";

/** HACK-2351: the detached native start's budget and ceiling. */

test("image work with fresh heartbeats does not count against the budget", () => {
  const deadline = new NativeDetachedStartDeadline({
    limits: { budgetMs: 1000, ceilingMs: 60_000 },
    now: 0,
    heartbeatStaleMs: 300,
  });
  deadline.observe("runtime", 400);
  deadline.observe("images", 600);
  // 10 s of builds, a heartbeat every 200 ms: nothing counted.
  for (let now = 800; now <= 10_600; now += 200) {
    deadline.observe("images", now);
    expect(deadline.check(now)).toBeUndefined();
  }
  expect(deadline.countedMs).toBe(600);
  // Heartbeats stop: within the stale window nothing counts; after it, time
  // counts again from the previous check until the budget runs out.
  expect(deadline.check(10_900)).toBeUndefined();
  expect(deadline.countedMs).toBe(600);
  expect(deadline.check(11_000)).toBeUndefined();
  expect(deadline.countedMs).toBe(700);
  expect(deadline.check(11_300)).toBe("budget");
  expect(deadline.phase).toBe("images");
});

test("every other phase counts, and the ceiling bounds the whole start", () => {
  const counted = new NativeDetachedStartDeadline({
    limits: { budgetMs: 1000, ceilingMs: 60_000 },
    now: 0,
  });
  counted.observe("runtime", 100);
  expect(counted.check(999)).toBeUndefined();
  expect(counted.check(1000)).toBe("budget");

  const ceiling = new NativeDetachedStartDeadline({
    limits: { budgetMs: 1000, ceilingMs: 5000 },
    now: 0,
    heartbeatStaleMs: 300,
  });
  ceiling.observe("images", 100);
  for (let now = 200; now < 5000; now += 200) {
    ceiling.observe("images", now);
    expect(ceiling.check(now)).toBeUndefined();
  }
  expect(ceiling.check(5000)).toBe("ceiling");
});

test("the timeout names the phase reached and the next command", () => {
  const deadline = new NativeDetachedStartDeadline({
    limits: { budgetMs: 900_000, ceilingMs: 3_600_000 },
    now: 0,
  });
  deadline.observe("images", 60_000);
  const budget = deadline.timeoutError("budget", 905_000);
  expect(budget.code).toBe("E_STARTUP_TIMEOUT");
  expect(budget.message).toContain(
    "it was building and loading service images when its 900 s budget for work other than image builds and loads"
  );
  expect(budget.message).toContain("after 905 s");
  expect(budget.message).toContain("Run hack down for this instance next");
  expect(budget.message).toContain(NATIVE_DETACHED_START_BUDGET_ENV);
  const ceiling = deadline.timeoutError("ceiling", 3_600_000);
  expect(ceiling.message).toContain("its 3600 s ceiling");
  expect(ceiling.message).toContain(NATIVE_DETACHED_START_CEILING_ENV);
  expect(
    new NativeDetachedStartDeadline({
      limits: { budgetMs: 1000, ceilingMs: 1000 },
      now: 0,
    }).timeoutError("budget", 1000).message
  ).toContain("it was starting its background owner");
});

test("limits come from the environment, are validated, and the ceiling is never below the budget", () => {
  expect(resolveNativeDetachedStartLimits({})).toEqual({
    budgetMs: DEFAULT_NATIVE_DETACHED_START_BUDGET_MS,
    ceilingMs: DEFAULT_NATIVE_DETACHED_START_CEILING_MS,
  });
  expect(
    resolveNativeDetachedStartLimits({
      [NATIVE_DETACHED_START_BUDGET_ENV]: "1800000",
      [NATIVE_DETACHED_START_CEILING_ENV]: "60000",
    })
  ).toEqual({ budgetMs: 1_800_000, ceilingMs: 1_800_000 });
  for (const value of ["0", "999", "-5", "1.5", "ten", "1e9x"]) {
    expect(() =>
      resolveNativeDetachedStartLimits({
        [NATIVE_DETACHED_START_BUDGET_ENV]: value,
      })
    ).toThrow(NATIVE_DETACHED_START_BUDGET_ENV);
  }
});
