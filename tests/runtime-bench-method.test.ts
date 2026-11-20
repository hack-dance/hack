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
  unknownHealthChecks,
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
  // No test: the engine would use the image's own check. The fixture's images
  // define none (checked with docker image inspect), but the helper cannot know.
  expect(onCompose.api).toEqual({ kind: "image-default" });
  expect(onCompose.web).toEqual({ kind: "image-default" });
  expect(unknownHealthChecks(compose)).toEqual(["api", "web"]);
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
  // api's command check runs on Compose only, and db and cache leave the start
  // settings to the backend: native fills in 250ms and 60s, Compose none.
  expect(unevenHealthChecks(compose)).toEqual(["api", "cache", "db"]);
  expect(laneHealthChecks({ compose, lane: "native" }).db).toMatchObject({
    kind: "engine-command",
    startInterval: "250ms",
    startPeriod: "60s",
  });
  expect(laneHealthChecks({ compose, lane: "compose" }).db).toMatchObject({
    kind: "engine-command",
    startInterval: null,
    startPeriod: null,
  });
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

const ROUTE = {
  caddy: "web.example.hack",
  "caddy.reverse_proxy": "{{upstreams 3000}}",
  "caddy.tls": "internal",
};
const PROBE = {
  port: 3000,
  path: "/health",
  interval_ms: 1000,
  timeout_ms: 1000,
  retries: 3,
  start_period_ms: 30_000,
};

test("each lane's health check follows native review's branches", () => {
  const compose = {
    services: {
      declared: { labels: ROUTE, healthcheck: { "x-hack-http": PROBE } },
      worker: { healthcheck: { "x-hack-http": PROBE } },
      routedOff: {
        labels: ROUTE,
        healthcheck: { disable: true, test: ["CMD", "true"] },
      },
      routedNone: { labels: ROUTE, healthcheck: { test: ["NONE"] } },
      routedEmpty: { labels: ROUTE, healthcheck: { interval: "10s" } },
      off: { healthcheck: { disable: true } },
      none: { healthcheck: { test: ["NONE"] } },
      inherited: { image: "example/with-healthcheck:1" },
    },
  };
  expect(laneHealthChecks({ compose, lane: "native" })).toEqual({
    declared: {
      kind: "native-route-probe",
      source: "declared",
      replaces: "nothing",
    },
    worker: {
      kind: "native-route-probe",
      source: "declared",
      replaces: "nothing",
    },
    routedOff: {
      kind: "native-refuses",
      reason: "a routed service's health check is disabled",
    },
    routedNone: {
      kind: "native-refuses",
      reason: "a routed service's health check is disabled",
    },
    routedEmpty: {
      kind: "native-refuses",
      reason: "a routed service's health check has no test",
    },
    off: { kind: "none" },
    none: { kind: "none" },
    inherited: { kind: "image-default" },
  });
  // Compose ignores the extension field, so a declaration without a test
  // leaves the image's own check in place.
  const onCompose = laneHealthChecks({ compose, lane: "compose" });
  expect(onCompose.declared).toEqual({ kind: "image-default" });
  expect(onCompose.worker).toEqual({ kind: "image-default" });
  expect(onCompose.routedOff).toEqual({ kind: "none" });
  expect(unknownHealthChecks(compose)).toEqual([
    "declared",
    "inherited",
    "routedEmpty",
    "worker",
  ]);
  expect(unevenHealthChecks(compose)).toEqual([]);
  expect(laneHealthChecks({ compose: null, lane: "compose" })).toEqual({});
});

test("route detection reads list-form labels and skips inert declarations", () => {
  const command = { test: ["CMD", "true"], interval: "10s" };
  const compose = {
    services: {
      listed: {
        labels: [
          "caddy=web.example.hack",
          "caddy.reverse_proxy={{upstreams 3000}}",
          "caddy.tls=internal",
        ],
        healthcheck: command,
      },
      inert: {
        labels: { caddy: "docs.example.hack", "caddy.tls": "internal" },
        healthcheck: command,
      },
      inertBare: { labels: ["caddy=docs.example.hack", "caddy.tls=internal"] },
    },
  };
  const onNative = laneHealthChecks({ compose, lane: "native" });
  expect(onNative.listed).toEqual({
    kind: "native-route-probe",
    source: "inferred",
    replaces: "command-check",
  });
  expect(onNative.inert).toMatchObject({ kind: "engine-command" });
  expect(onNative.inertBare).toEqual({ kind: "image-default" });
  // inert's command check leaves the start settings out, so native fills in
  // its defaults and the lanes differ.
  expect(unevenHealthChecks(compose)).toEqual(["inert", "listed"]);
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

/**
 * A fake clock whose request decides its answer when it starts and returns
 * `requestMs` later, like a real round trip: readiness can change while a
 * failing request is still under way.
 */
function fakeClock(opts: { readonly requestMs: number }) {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    request: (readyAt: number) => async () => {
      const answer = now >= readyAt;
      now += opts.requestMs;
      return answer;
    },
  };
}

test("readiness is late by at most the round under way, one poll pause and one round", async () => {
  for (const requestMs of [5, 40]) {
    for (const readyAt of [0, 1, 37, 503, 1990]) {
      const clock = fakeClock({ requestMs });
      const ms = await pollUntil({
        isReady: clock.request(readyAt),
        mode: EXACT_READINESS,
        timeoutMs: 10_000,
        now: clock.now,
        sleep: clock.sleep,
      });
      expect(ms).not.toBeNull();
      expect(ms as number).toBeGreaterThanOrEqual(readyAt);
      expect(ms as number).toBeLessThanOrEqual(
        readyAt + requestMs + 20 + requestMs
      );
    }
  }
  // Ready just after a failing round started: that round, the pause and the
  // next round all count.
  const clock = fakeClock({ requestMs: 40 });
  expect(
    await pollUntil({
      isReady: clock.request(1),
      mode: EXACT_READINESS,
      timeoutMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    })
  ).toBe(100);
  // The legacy mode can be up to half a second late.
  const legacy = fakeClock({ requestMs: 5 });
  expect(
    await pollUntil({
      isReady: legacy.request(10),
      mode: LEGACY_READINESS,
      timeoutMs: 10_000,
      now: legacy.now,
      sleep: legacy.sleep,
    })
  ).toBe(510);
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
