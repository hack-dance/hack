import { expect, test } from "bun:test";
import { admitNativeHttpProbe } from "../src/backends/native-http-probe-admission.ts";

const valid = {
  port: 3000,
  path: "/",
  interval_ms: 100,
  timeout_ms: 500,
  retries: 3,
  start_period_ms: 0,
};
for (const [field, values] of Object.entries({
  port: [0, 65_536],
  path: ["relative", "/#fragment", "/ space", "/é"],
  interval_ms: [9, 3_600_001],
  timeout_ms: [0, 60_001],
  retries: [0, 120, 1.5],
  start_period_ms: [-1, 3_600_001],
})) {
  for (const value of values) {
    test(`HTTP preflight names invalid ${field}: ${JSON.stringify(value)}`, () => {
      expect(() =>
        admitNativeHttpProbe("web", {
          healthcheck: { "x-hack-http": { ...valid, [field]: value } },
        })
      ).toThrow(`service web field healthcheck.x-hack-http.${field}`);
    });
  }
}
test("HTTP preflight accepts runtime boundary values and command probes", () => {
  for (const probe of [
    valid,
    {
      port: 1,
      path: "/",
      interval_ms: 10,
      timeout_ms: 1,
      retries: 1,
      start_period_ms: 0,
    },
    {
      port: 65_535,
      path: "/".repeat(512),
      interval_ms: 3_600_000,
      timeout_ms: 60_000,
      retries: 100,
      start_period_ms: 3_600_000,
    },
  ]) {
    expect(() =>
      admitNativeHttpProbe("web", { healthcheck: { "x-hack-http": probe } })
    ).not.toThrow();
  }
  expect(() =>
    admitNativeHttpProbe("web", { healthcheck: { test: ["CMD", "true"] } })
  ).not.toThrow();
});
