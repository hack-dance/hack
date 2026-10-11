import { expect, test } from "bun:test";
import { createClosedRefusalRegistry } from "../src/lib/closed-refusal-registry.ts";

const STAGES = ["alpha", "beta"] as const;
const REASONS = ["busy", "stale"] as const;

function registry(firstWins: boolean) {
  return createClosedRefusalRegistry<
    (typeof STAGES)[number],
    (typeof REASONS)[number]
  >({ stages: STAGES, reasons: REASONS, firstWins, label: "Example" });
}

test("registry issues a frozen closed pair and ignores primitive lookups", () => {
  const { lookup, attach } = registry(false);
  const error = new Error("private detail");
  attach(error, { stage: "alpha", reason: "busy" });
  const issued = lookup(error);
  expect(issued).toEqual({ stage: "alpha", reason: "busy" });
  expect(Object.isFrozen(issued)).toBe(true);
  expect(lookup("private detail")).toBeUndefined();
  expect(lookup(null)).toBeUndefined();
  expect(lookup(new Error("other"))).toBeUndefined();
});

test("registry refuses open diagnostics with a fixed value-free message", () => {
  const { lookup, attach } = registry(false);
  const error = new Error("secret");
  const refusals: unknown[] = [
    { stage: "alpha", reason: "busy", detail: "secret" },
    { stage: "alpha" },
    { stage: "gamma", reason: "busy" },
    { stage: "alpha", reason: "slow" },
    {
      get stage() {
        return "alpha";
      },
      reason: "busy",
    },
    "alpha",
    null,
  ];
  for (const diagnostic of refusals) {
    expect(() => attach(error, diagnostic)).toThrow(
      "Example refused; values omitted."
    );
  }
  expect(lookup(error)).toBeUndefined();
});

test("overwrite registry reports the latest boundary", () => {
  const { lookup, attach } = registry(false);
  const error = new Error("x");
  attach(error, { stage: "alpha", reason: "busy" });
  attach(error, { stage: "beta", reason: "stale" });
  expect(lookup(error)).toEqual({ stage: "beta", reason: "stale" });
});

test("first-wins registry keeps the first boundary but still refuses open input", () => {
  const { lookup, attach } = registry(true);
  const error = new Error("x");
  attach(error, { stage: "alpha", reason: "busy" });
  attach(error, { stage: "beta", reason: "stale" });
  expect(lookup(error)).toEqual({ stage: "alpha", reason: "busy" });
  expect(() => attach(error, { stage: "beta" })).toThrow(
    "Example refused; values omitted."
  );
  expect(lookup(error)).toEqual({ stage: "alpha", reason: "busy" });
});

test("retain never throws and skips primitive rejections", () => {
  const { lookup, retain } = registry(false);
  const error = new Error("x");
  expect(() =>
    retain("primitive", { stage: "alpha", reason: "busy" })
  ).not.toThrow();
  expect(() =>
    retain(error, { stage: "nope", reason: "busy" } as never)
  ).not.toThrow();
  expect(lookup(error)).toBeUndefined();
  retain(error, { stage: "beta", reason: "busy" });
  expect(lookup(error)).toEqual({ stage: "beta", reason: "busy" });
});

test("registries are isolated from each other", () => {
  const first = registry(false);
  const second = registry(false);
  const error = new Error("x");
  first.attach(error, { stage: "alpha", reason: "busy" });
  expect(second.lookup(error)).toBeUndefined();
});
