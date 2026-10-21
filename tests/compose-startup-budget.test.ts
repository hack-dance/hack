import { expect, test } from "bun:test";
import {
  DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  resolveComposeImageTimeoutMs,
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

test("image build/pull budget is separate, defaults to 30 minutes and allows up to 4 hours", () => {
  expect(resolveComposeImageTimeoutMs({ env: {} })).toBe(
    DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS
  );
  expect(DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS).toBe(1_800_000);
  // The startup budget never sizes the image phase, and vice versa.
  expect(
    resolveComposeImageTimeoutMs({
      env: { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1000" },
    })
  ).toBe(1_800_000);
  expect(
    resolveComposeStartupTimeoutMs({
      env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: "14400000" },
    })
  ).toBe(DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS);
  expect(
    resolveComposeImageTimeoutMs({
      env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: "14400000" },
    })
  ).toBe(14_400_000);
  for (const value of ["999", "14400001", "1e6", "private-input"]) {
    expect(() =>
      resolveComposeImageTimeoutMs({
        env: { HACK_COMPOSE_IMAGE_TIMEOUT_MS: value },
      })
    ).toThrow("HACK_COMPOSE_IMAGE_TIMEOUT_MS");
  }
});
