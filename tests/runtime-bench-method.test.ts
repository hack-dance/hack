import { expect, test } from "bun:test";
import { join } from "node:path";
import { YAML } from "bun";

import {
  allPass,
  EXACT_READINESS,
  LEGACY_READINESS,
  laneHealthChecks,
  pollUntil,
  unevenHealthChecks,
} from "../scripts/lib/runtime-bench-method.ts";

const FIXTURE = join(import.meta.dir, "../scripts/fixtures/runtime-bench");

async function fixtureCompose(path: string): Promise<unknown> {
  return YAML.parse(await Bun.file(join(FIXTURE, path)).text());
}

test("the benchmark fixture runs the same health checks on both lanes", async () => {
  const compose = await fixtureCompose(".hack/docker-compose.yml");
  expect(unevenHealthChecks(compose)).toEqual([]);
  const engine = {
    kind: "engine-command",
    interval: "10s",
    startPeriod: "30s",
    startInterval: "250ms",
  };
  const onCompose = laneHealthChecks({ compose, lane: "compose" });
  expect(onCompose.db).toMatchObject(engine);
  expect(onCompose.cache).toMatchObject(engine);
  expect(onCompose.api).toEqual({ kind: "none" });
  expect(onCompose.web).toEqual({ kind: "none" });
  const onNative = laneHealthChecks({ compose, lane: "native" });
  expect(onNative.db).toEqual(onCompose.db);
  expect(onNative.cache).toEqual(onCompose.cache);
  for (const name of ["api", "web"]) {
    expect(onNative[name]).toEqual({
      kind: "native-route-probe",
      source: "inferred",
      replaces: "nothing",
    });
  }
});

test("the version 1 fixture is reported as not like for like", async () => {
  const compose = await fixtureCompose("legacy/docker-compose.v1.yml");
  expect(unevenHealthChecks(compose)).toEqual(["api"]);
  expect(laneHealthChecks({ compose, lane: "compose" }).api).toMatchObject({
    kind: "engine-command",
    interval: "5s",
  });
  expect(laneHealthChecks({ compose, lane: "native" }).api).toEqual({
    kind: "native-route-probe",
    source: "inferred",
    replaces: "command-check",
  });
});

test("a declared native probe and disabled checks are read as such", () => {
  const compose = {
    services: {
      web: {
        labels: { caddy: "web.hack" },
        healthcheck: { "x-hack-http": { port: 3000, path: "/" } },
      },
      off: { healthcheck: { disable: true, test: ["CMD", "true"] } },
      none: { healthcheck: { test: ["NONE"] } },
    },
  };
  expect(laneHealthChecks({ compose, lane: "native" })).toEqual({
    web: {
      kind: "native-route-probe",
      source: "declared",
      replaces: "nothing",
    },
    off: { kind: "none" },
    none: { kind: "none" },
  });
  // Compose ignores the extension field and has no test to run.
  expect(laneHealthChecks({ compose, lane: "compose" }).web).toEqual({
    kind: "none",
  });
  expect(unevenHealthChecks(compose)).toEqual([]);
  expect(laneHealthChecks({ compose: null, lane: "compose" })).toEqual({});
});

test("concurrent readiness starts every route check at once", async () => {
  const started: number[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const check = (index: number) => async () => {
    started.push(index);
    await gate;
    return true;
  };
  const result = allPass([check(0), check(1)], EXACT_READINESS);
  await Bun.sleep(0);
  expect(started).toEqual([0, 1]);
  release();
  expect(await result).toBe(true);
});

test("legacy readiness checks routes one after the other and stops at a failure", async () => {
  const calls: number[] = [];
  const check = (index: number, answer: boolean) => async () => {
    calls.push(index);
    return answer;
  };
  expect(
    await allPass([check(0, false), check(1, true)], LEGACY_READINESS)
  ).toBe(false);
  expect(calls).toEqual([0]);
  expect(
    await allPass([check(2, true), check(3, false)], EXACT_READINESS)
  ).toBe(false);
});

function fakeClock(opts: { readonly requestMs: number }) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    request: (readyAt: number) => async () => {
      now += opts.requestMs;
      return now >= readyAt;
    },
  };
}

test("readiness is reported within one poll of the moment it happened", async () => {
  for (const readyAt of [0, 37, 503, 1990]) {
    const clock = fakeClock({ requestMs: 5 });
    const ms = await pollUntil({
      isReady: clock.request(readyAt),
      mode: EXACT_READINESS,
      timeoutMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThanOrEqual(readyAt);
    expect(ms as number).toBeLessThanOrEqual(readyAt + 20 + 5);
  }
  // The legacy mode can be up to half a second late.
  const clock = fakeClock({ requestMs: 5 });
  const late = await pollUntil({
    isReady: clock.request(10),
    mode: LEGACY_READINESS,
    timeoutMs: 10_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  expect(late).toBe(510);
});

test("readiness gives up at the timeout", async () => {
  const clock = fakeClock({ requestMs: 5 });
  expect(
    await pollUntil({
      isReady: async () => {
        await clock.sleep(5);
        return false;
      },
      mode: EXACT_READINESS,
      timeoutMs: 200,
      now: clock.now,
      sleep: clock.sleep,
    })
  ).toBeNull();
});
