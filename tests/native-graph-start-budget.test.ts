import { expect, test } from "bun:test";
import {
  DEFAULT_NATIVE_START_TIMEOUT_SECONDS,
  NATIVE_START_TIMEOUT_ENV,
  nativeGraphTimeoutDetail,
  nativeReadinessGoals,
  resolveNativeStartTimeoutSeconds,
} from "../src/backends/native-graph-start-budget.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";

/** HACK-2351: the native graph start budget and its timeout detail. */

test("the budget comes from the host variable, then the project, then 300 s, and refuses bad values", () => {
  expect(
    resolveNativeStartTimeoutSeconds({ env: {}, project: undefined })
  ).toBe(DEFAULT_NATIVE_START_TIMEOUT_SECONDS);
  expect(resolveNativeStartTimeoutSeconds({ env: {}, project: 900 })).toBe(900);
  expect(
    resolveNativeStartTimeoutSeconds({
      env: { [NATIVE_START_TIMEOUT_ENV]: "1200" },
      project: 900,
    })
  ).toBe(1200);
  for (const value of ["59", "1801", "1.5", "ten", "-60", "600s"]) {
    expect(() =>
      resolveNativeStartTimeoutSeconds({
        env: { [NATIVE_START_TIMEOUT_ENV]: value },
        project: undefined,
      })
    ).toThrow(NATIVE_START_TIMEOUT_ENV);
  }
  for (const value of [59, 1801, Number.NaN]) {
    expect(() =>
      resolveNativeStartTimeoutSeconds({ env: {}, project: value })
    ).toThrow("native.startTimeoutSeconds in .hack/hack.config.json");
  }
});

test("readiness goals are read from the --ready arguments", () => {
  expect(
    nativeReadinessGoals([
      "--ready",
      "web=healthy",
      "--other",
      "x",
      "--ready",
      "migrate=completed",
      "--ready",
    ])
  ).toEqual({ web: "healthy", migrate: "completed" });
});

const snapshot = {
  observations: {
    "container:api": { state: "running", health: "starting" },
    "container:db": { state: "running", health: "healthy" },
    "container:migrate": { state: "exited", code: 3 },
    "container:web": { state: "running" },
  },
};

test("the timeout detail names each service that missed its goal, what it was doing and for how long", () => {
  expect(
    nativeGraphTimeoutDetail({
      snapshot,
      goals: {
        web: "started",
        db: "healthy",
        api: "healthy",
        migrate: "completed",
        worker: "started",
      },
      waitedMs: 300_400,
      budgetSeconds: 300,
    })
  ).toBe(
    "Not ready after 300 s of the 300 s graph start budget: api (wanted healthy; running, starting), migrate (wanted completed; exited 3), worker (wanted started; no container). Raise native.startTimeoutSeconds or HACK_NATIVE_START_TIMEOUT_SECONDS if they were still starting."
  );
  // Every goal reached: nothing to add to the runtime's own message.
  expect(
    nativeGraphTimeoutDetail({
      snapshot,
      goals: { web: "started", db: "healthy" },
      waitedMs: 1,
      budgetSeconds: 300,
    })
  ).toBeUndefined();
});

test("the timeout detail stays within the runtime-failure envelope and admits only closed values", () => {
  const goals = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`service-${index}`, "healthy"])
  );
  const detail = nativeGraphTimeoutDetail({
    snapshot: {},
    goals: {
      ...goals,
      "bad name\nwith newline": "started",
    },
    waitedMs: 600_000,
    budgetSeconds: 600,
  });
  expect(detail).toBeDefined();
  expect(detail?.length).toBeLessThanOrEqual(400);
  expect(detail).toMatch(/^[\x20-\x7e]+$/);
  expect(detail).toContain("more service(s)");
  expect(detail).not.toContain("bad name");
  // A state outside the fixed vocabulary is never echoed.
  expect(
    nativeGraphTimeoutDetail({
      snapshot: {
        observations: { "container:web": { state: "Weird State!" } },
      },
      goals: { web: "healthy" },
      waitedMs: 1000,
      budgetSeconds: 300,
    })
  ).toContain("web (wanted healthy; unknown)");
});

/** Where the parsed record came from; only used in messages. */
const CONFIG = "/project/.hack/hack.config.json";

test("native.startTimeoutSeconds is read from the project config; a non-integer stays refusable", () => {
  expect(
    parseProjectConfigRecord({ native: { startTimeoutSeconds: 900 } }, CONFIG)
      .native
  ).toEqual({ startTimeoutSeconds: 900 });
  expect(
    parseProjectConfigRecord({ native: { startTimeoutSeconds: "900" } }, CONFIG)
      .native?.startTimeoutSeconds
  ).toBeNaN();
  expect(
    parseProjectConfigRecord({ native: {} }, CONFIG).native
  ).toBeUndefined();
  expect(parseProjectConfigRecord({}, CONFIG).native).toBeUndefined();
});
