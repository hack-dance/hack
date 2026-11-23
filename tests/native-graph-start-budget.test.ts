import { expect, test } from "bun:test";
import {
  DEFAULT_NATIVE_START_TIMEOUT_SECONDS,
  NATIVE_START_TIMEOUT_ENV,
  nativeGraphTimeoutDetail,
  nativeReadinessGoals,
  resolveNativeStartTimeoutSeconds,
  watchNativeStartupStatus,
} from "../src/backends/native-graph-start-budget.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";

/** HACK-2351: the native graph start budget and its timeout detail. */

test("the budget comes from the host variable, then the project, then 300 s, and refuses bad values", () => {
  expect(
    resolveNativeStartTimeoutSeconds({ env: {}, project: undefined })
  ).toBe(DEFAULT_NATIVE_START_TIMEOUT_SECONDS);
  expect(resolveNativeStartTimeoutSeconds({ env: {}, project: 450 })).toBe(450);
  expect(
    resolveNativeStartTimeoutSeconds({
      env: { [NATIVE_START_TIMEOUT_ENV]: "600" },
      project: 450,
    })
  ).toBe(600);
  // The runtime refuses a graph budget above 600 s, so the frontend does too.
  for (const value of ["59", "601", "1800", "1.5", "ten", "-60", "600s"]) {
    expect(() =>
      resolveNativeStartTimeoutSeconds({
        env: { [NATIVE_START_TIMEOUT_ENV]: value },
        project: undefined,
      })
    ).toThrow(NATIVE_START_TIMEOUT_ENV);
  }
  for (const value of [59, 601, Number.NaN]) {
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
    "Not ready after 300 s of the 300 s graph start budget: api (wanted healthy; running, starting), migrate (wanted completed; exited 3), worker (wanted started; not created). Raise native.startTimeoutSeconds or HACK_NATIVE_START_TIMEOUT_SECONDS if they were still starting."
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
  // States, health and goals outside the closed vocabularies are never echoed.
  const closed = nativeGraphTimeoutDetail({
    snapshot: {
      observations: {
        "container:web": { state: "private_token", health: "customer_name" },
      },
    },
    goals: { web: "healthy", api: "private_goal" },
    waitedMs: 1000,
    budgetSeconds: 300,
  });
  expect(closed).toContain("web (wanted healthy; unknown)");
  expect(closed).not.toContain("private");
  expect(closed).not.toContain("customer");
  expect(closed).not.toContain("api");
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

test("a service that exited unsuccessfully has not started, as the runtime judges it", () => {
  // Review finding: only a running container or a clean exit meets `started`.
  expect(
    nativeGraphTimeoutDetail({
      snapshot: {
        observations: {
          "container:worker": { state: "exited", code: 3 },
          "container:job": { state: "exited", code: 0 },
        },
      },
      goals: { worker: "started", job: "started" },
      waitedMs: 300_000,
      budgetSeconds: 300,
    })
  ).toContain(": worker (wanted started; exited 3).");
});

test("the detail says how old the graph status it describes was", () => {
  expect(
    nativeGraphTimeoutDetail({
      snapshot: { observations: {} },
      goals: { web: "started" },
      waitedMs: 300_000,
      budgetSeconds: 300,
      snapshotAgeMs: 4200,
    })
  ).toContain(
    "graph start budget (graph status 4 s before the deadline): web (wanted started; not created)"
  );
});

test("the status watcher keeps a snapshot taken after every service started", async () => {
  // The usual timeout: every container started, one goal unmet. The receipt is
  // then `started-observed`, and that snapshot must still describe the deadline.
  const phases = [
    "preparing",
    "started-observed",
    "cleanup-intent",
    "ready-observed",
  ];
  let read = 0;
  const watcher = watchNativeStartupStatus({
    runtime: {} as never,
    projectRoot: "/unused",
    run: "r",
    intervalMs: 5,
    invoke: async () => {
      const phase = phases[Math.min(read, phases.length - 1)];
      read += 1;
      return { receipt: { phase }, observations: { web: { phase } } };
    },
  });
  try {
    for (let wait = 0; read < phases.length + 1 && wait < 200; wait += 1) {
      await Bun.sleep(5);
    }
  } finally {
    await watcher.stop();
  }
  // Cleanup and ready snapshots never replace the started one.
  expect(watcher.latest()?.snapshot).toEqual({
    receipt: { phase: "started-observed" },
    observations: { web: { phase: "started-observed" } },
  });
});
