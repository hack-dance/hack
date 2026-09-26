import { expect, test } from "bun:test";
import {
  hasOnlyNativeSupportedLabels,
  nativeBridgeCapacity,
  reviewedNativeRoutes,
} from "../src/backends/native-project-routing.ts";

const labels = {
  caddy: "web.example.com",
  "caddy.reverse_proxy": "{{upstreams 3000}}",
  "caddy.tls": "internal",
};
const healthcheck = {
  "x-hack-http": {
    port: 3000,
    path: "/health",
    interval_ms: 100,
    timeout_ms: 500,
    retries: 3,
    start_period_ms: 0,
  },
};
const spec = { labels, healthcheck };
const service = {
  active: true,
  routing: { port: 3000, hostnames: ["web.example.com"] },
  healthcheck: { disabled: false, native_http: healthcheck["x-hack-http"] },
};
test("supported routing and cache label keys remain bounded without rewriting values", () => {
  expect(
    hasOnlyNativeSupportedLabels({
      ...labels,
      "hack.dependencies.lockfiles": "package-lock.json",
    })
  ).toBe(true);
  expect(
    hasOnlyNativeSupportedLabels(
      Object.entries(labels).map(([key, value]) => `${key}=${value}`)
    )
  ).toBe(true);
  for (const unsupported of [
    { "caddy.header": "X" },
    { caddy_ingress_network: "dev" },
    { other: "value" },
    [1],
  ]) {
    expect(hasOnlyNativeSupportedLabels(unsupported)).toBe(false);
  }
  expect(
    nativeBridgeCapacity({ inactive: spec, active: spec, unrouted: {} })
  ).toBe(2);
  expect(() =>
    nativeBridgeCapacity(
      Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`web${i}`, spec])
      )
    )
  ).toThrow();
});
test("only active reviewed routes receive stable unique slots and matching existing probes", () => {
  const opts = {
    plan: {
      services: { z: service, a: service, off: { ...service, active: false } },
    },
    specs: { z: spec, a: spec, off: spec },
    capacity: 3,
  };
  expect(reviewedNativeRoutes(opts).flags).toEqual([
    "--route-slot",
    "a=0",
    "--route-slot",
    "z=1",
  ]);
  expect([...reviewedNativeRoutes(opts).services]).toEqual(["a", "z"]);
  for (const changed of [
    { labels },
    { labels, healthcheck: { test: ["CMD", "true"] } },
    { ...spec, healthcheck: { "x-hack-http": { port: 3001 } } },
  ]) {
    expect(() =>
      reviewedNativeRoutes({ ...opts, specs: { ...opts.specs, z: changed } })
    ).toThrow();
  }
  expect(() => reviewedNativeRoutes({ ...opts, capacity: 1 })).toThrow();
  expect(() =>
    reviewedNativeRoutes({
      ...opts,
      plan: {
        services: {
          z: { ...service, healthcheck: { native_http: { port: 3001 } } },
        },
      },
    })
  ).toThrow();
  expect(
    reviewedNativeRoutes({
      plan: { services: { web: { active: true } } },
      specs: { web: {} },
      capacity: 0,
    }).flags
  ).toEqual([]);
});
