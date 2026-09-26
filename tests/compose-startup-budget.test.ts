import { expect, test } from "bun:test";
import {
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  resolveComposeStartupTimeoutMs,
} from "../src/lib/compose-startup-budget.ts";

test("startup budget defaults and explicit numeric precedence", () => {
  expect(resolveComposeStartupTimeoutMs({ env: {} })).toBe(
    DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS
  );
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "600000" },
    })
  ).toBe(600_000);
  expect(
    resolveComposeStartupTimeoutMs({
      startupTimeoutMs: 120_000,
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "invalid" },
    })
  ).toBe(120_000);
  for (const value of [1000, 3_600_000]) {
    expect(resolveComposeStartupTimeoutMs({ startupTimeoutMs: value })).toBe(
      value
    );
  }
});

test("startup budget rejects malformed or out-of-bounds settings without echoing input", () => {
  for (const value of [
    "",
    " 1000",
    "1e4",
    "1000.0",
    "+1000",
    "999",
    "3600001",
    "Infinity",
    "private-input",
  ]) {
    expect(() =>
      resolveComposeStartupTimeoutMs({
        env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: value },
      })
    ).toThrow("integer from 1000 to 3600000");
  }
  for (const value of [
    0,
    -1,
    999,
    3_600_001,
    1000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(() =>
      resolveComposeStartupTimeoutMs({ startupTimeoutMs: value })
    ).toThrow();
  }
});
