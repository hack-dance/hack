import { expect, test } from "bun:test";
import type { NativeProjectPsResult } from "../src/backends/native-project-observe.ts";
import {
  waitForNativeOpenTarget,
  waitForNativeProjectReady,
} from "../src/lib/native-start-wait.ts";
import {
  NATIVE_UP_SCRIPTS_WAIT_BY_DEFAULT,
  nativeUpWaitsForReady,
} from "../src/lib/native-up-wait.ts";

/** A run as `ps` reports it: `warming` (started-observed) or `ready`. */
function ps(
  readiness: "warming" | "ready" | undefined,
  health: string,
  phase = readiness === "warming" ? "started-observed" : "ready-observed"
): NativeProjectPsResult {
  return {
    backend: "native",
    status: "observed",
    run: "r",
    phase,
    ...(readiness ? { readiness } : {}),
    items: [
      { service: "web", state: "running", health, readiness: "healthy" },
      {
        service: "db",
        state: "running",
        health: "healthy",
        readiness: "healthy",
      },
    ],
  } as NativeProjectPsResult;
}

/** Replays `results`, one per read; time advances one second per sleep. */
function clock(results: readonly NativeProjectPsResult[]) {
  let read = 0;
  let time = 0;
  const lines: string[] = [];
  return {
    lines,
    reads: () => read,
    opts: {
      ps: async () => results[Math.min(read++, results.length - 1)]!,
      budgetMs: 3000,
      onWaiting: (line: string) => lines.push(line),
      sleep: async (ms: number) => {
        time += ms;
      },
      now: () => time,
    },
  };
}

test("exec waits once a run is warming, says so once, and goes on when it is ready", async () => {
  const run = clock([
    ps("warming", "starting"),
    ps("warming", "starting"),
    ps("ready", "healthy"),
  ]);
  await waitForNativeProjectReady(run.opts);
  expect(run.lines).toEqual(["waiting for the project to become ready…"]);
  expect(run.reads()).toBe(3);
  // A ready run, or none, does not wait or print.
  const ready = clock([ps("ready", "healthy")]);
  await waitForNativeProjectReady(ready.opts);
  expect(ready.lines).toEqual([]);
});

test("exec gives up at the start budget, naming the warming service, and on a failed start", async () => {
  const slow = clock([ps("warming", "starting")]);
  await expect(waitForNativeProjectReady(slow.opts)).rejects.toThrow(
    "Native project is not ready after 3 s (web: starting); nothing was run."
  );
  const failed = clock([
    ps("warming", "starting"),
    ps(undefined, "none", "stopped-data-retained"),
  ]);
  await expect(waitForNativeProjectReady(failed.opts)).rejects.toThrow(
    "Native project did not become ready (phase stopped-data-retained); nothing was run."
  );
});

test("open waits for its own service's goal and verified publication, then for the route", async () => {
  const published = (result: NativeProjectPsResult, ...services: string[]) =>
    ({
      ...result,
      ports: services.map((service) => ({
        service,
        port: 18_080,
        target: 8080,
        state: "observed",
      })),
    }) as NativeProjectPsResult;
  // db healthy and published: no wait, and nothing printed.
  const db = clock([published(ps("warming", "starting"), "db")]);
  await waitForNativeOpenTarget({ ...db.opts, target: "db" });
  expect(db.lines).toEqual([]);
  // db healthy but its port not verified yet: wait for the publication.
  const unpublished = clock([
    ps("warming", "starting"),
    published(ps("warming", "starting"), "db"),
  ]);
  await waitForNativeOpenTarget({ ...unpublished.opts, target: "db" });
  expect(unpublished.reads()).toBe(2);
  // web warming, then healthy and published; then the route answers on retry.
  const web = clock([
    ps("warming", "starting"),
    published(ps("warming", "healthy"), "web"),
  ]);
  let probes = 0;
  await waitForNativeOpenTarget({
    ...web.opts,
    target: "web",
    probe: async () => {
      probes += 1;
      return probes > 1;
    },
  });
  expect(web.lines).toEqual(["waiting for web to answer…"]);
  expect(probes).toBe(2);
  // A route that never answers stops at the budget.
  const silent = clock([published(ps("warming", "healthy"), "web")]);
  await expect(
    waitForNativeOpenTarget({
      ...silent.opts,
      target: "web",
      probe: async () => false,
    })
  ).rejects.toThrow("the route for web did not answer within 3 s");
  // Never ready: stops at the budget, naming the state.
  const never = clock([ps("warming", "starting")]);
  await expect(
    waitForNativeOpenTarget({ ...never.opts, target: "web" })
  ).rejects.toThrow(
    "Native open stopped waiting: web is not ready after 3 s (starting). Nothing was opened."
  );
});

test("open refuses a target that failed, a replaced run, or a run that ended", async () => {
  const unhealthy = clock([
    ps("warming", "starting"),
    ps("warming", "unhealthy"),
  ]);
  await expect(
    waitForNativeOpenTarget({ ...unhealthy.opts, target: "web" })
  ).rejects.toThrow("Native open refused: web is unhealthy.");
  const replaced = clock([
    ps("warming", "starting"),
    { ...ps("warming", "starting"), run: "other" } as NativeProjectPsResult,
  ]);
  await expect(
    waitForNativeOpenTarget({ ...replaced.opts, target: "web" })
  ).rejects.toThrow("was replaced");
  const ended = clock([
    ps("warming", "starting"),
    ps(undefined, "none", "stopped-data-retained"),
  ]);
  await expect(
    waitForNativeOpenTarget({ ...ended.opts, target: "web" })
  ).rejects.toThrow("the project is not running (phase stopped-data-retained)");
  // A run that is not warming when first seen opens as before, without probing.
  const ready = clock([ps("ready", "healthy")]);
  await waitForNativeOpenTarget({
    ...ready.opts,
    target: "web",
    probe: async () => {
      throw new Error("must not probe a ready run");
    },
  });
  expect(ready.lines).toEqual([]);
});

test("--wait waits; --json and --no-interactive follow one constant", () => {
  expect(
    nativeUpWaitsForReady({ wait: true, json: false, interactive: true })
  ).toBe(true);
  expect(
    nativeUpWaitsForReady({ wait: undefined, json: false, interactive: true })
  ).toBe(false);
  for (const script of [
    { wait: undefined, json: true, interactive: true },
    { wait: undefined, json: false, interactive: false },
  ]) {
    expect(nativeUpWaitsForReady(script)).toBe(
      NATIVE_UP_SCRIPTS_WAIT_BY_DEFAULT
    );
  }
});

test("an observation the wait cannot read decides nothing; the command's own checks do", async () => {
  // Before any warming was seen: proceed, and say nothing.
  const lines: string[] = [];
  await waitForNativeProjectReady({
    ps: async () => {
      throw new Error("observation refused");
    },
    budgetMs: 3000,
    onWaiting: (line) => lines.push(line),
    sleep: async () => undefined,
    now: () => 0,
  });
  expect(lines).toEqual([]);
  // Once the run was seen warming, a failed read is not taken as ready.
  let read = 0;
  await expect(
    waitForNativeProjectReady({
      ps: async () => {
        read += 1;
        if (read === 1) {
          return ps("warming", "starting");
        }
        throw new Error("observation refused");
      },
      budgetMs: 3000,
      onWaiting: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    })
  ).rejects.toThrow("observation refused");
});
