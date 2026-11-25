import { expect, test } from "bun:test";
import {
  nativeAppendRollback,
  readNativeAppendRollback,
} from "../src/lib/native-append-cancellation.ts";

test("sums the rounded stop grace for each selected service", () => {
  const rollback = nativeAppendRollback({
    plan: {
      services: {
        // The reviewed value of Compose stop_grace_period: 1s250ms.
        worker: { stop_grace_period_nanos: 1_250_000_000 },
        job: { stop_grace_period_nanos: 3_000_000_000 },
        redis: {},
      },
    },
    selected: ["worker", "job", "redis"],
    ready: new Set(),
    owned: new Map(),
  });
  expect(rollback).toEqual({ services: 3, waitMs: 60_000 });
});

test("allows the capped grace for a resumed service and excludes a running one", () => {
  const rollback = nativeAppendRollback({
    plan: {
      services: {
        resumed: { stop_grace_period_nanos: 1_000_000_000 },
        web: { stop_grace_period_nanos: 30_000_000_000 },
        added: { stop_grace_period_nanos: 2_000_000_000 },
      },
    },
    selected: ["web", "resumed", "added"],
    ready: new Set(["web"]),
    owned: new Map([
      ["web", "image"],
      ["resumed", "image"],
    ]),
  });
  expect(rollback).toEqual({ services: 2, waitMs: 77_000 });
});

test("two default-grace workers can take twenty seconds to stop serially", () => {
  const rollback = nativeAppendRollback({
    plan: { services: { "worker-a": {}, "worker-b": {} } },
    selected: ["worker-a", "worker-b"],
    ready: new Set(),
    owned: new Map(),
  });
  expect(rollback).toEqual({ services: 2, waitMs: 65_000 });
  expect(readNativeAppendRollback(rollback)).toEqual(rollback);
});

test("the detached launcher admits the largest bounded serial budget", () => {
  expect(readNativeAppendRollback({ services: 32, waitMs: 1_005_000 })).toEqual(
    {
      services: 32,
      waitMs: 1_005_000,
    }
  );
  expect(
    readNativeAppendRollback({ services: 32, waitMs: 1_005_001 })
  ).toBeUndefined();
});
