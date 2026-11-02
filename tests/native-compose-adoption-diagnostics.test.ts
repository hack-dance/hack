import { expect, test } from "bun:test";
import { errorResultFromUnknown, HackCliError } from "../src/lib/cli-result.ts";
import {
  attachLegacyComposeOrderedRefusal,
  legacyComposeOrderedError,
  legacyComposeOrderedRefusal,
} from "../src/lib/native-compose-adoption-diagnostics.ts";

test("closed refusal details survive owned wrapping without copying arbitrary error properties", () => {
  const inner = legacyComposeOrderedError({
    diagnostic: { stage: "ordered-observation", reason: "probe" },
    message: "private-inner-canary",
  });
  const detail = legacyComposeOrderedRefusal(inner);
  expect(detail).toEqual({ stage: "ordered-observation", reason: "probe" });
  expect(Object.isFrozen(detail)).toBe(true);
  const outer = new Error("fixed redacted refusal");
  if (!detail) {
    throw new Error("missing diagnostic");
  }
  attachLegacyComposeOrderedRefusal(outer, detail);
  expect(legacyComposeOrderedRefusal(outer)).toEqual(detail);
  expect(JSON.stringify(legacyComposeOrderedRefusal(outer))).not.toContain(
    "private-inner-canary"
  );
});

test("issuing diagnostics rejects extra keys, inherited values and getters without executing them", () => {
  let reads = 0;
  const getter = Object.defineProperty({ reason: "shape" }, "stage", {
    enumerable: true,
    get: () => {
      reads += 1;
      return "ordered-observation";
    },
  });
  for (const diagnostic of [
    {
      stage: "ordered-observation",
      reason: "shape",
      secret: "private-secret-canary",
    },
    {
      stage: "ordered-observation",
      reason: "shape",
      [Symbol("private")]: true,
    },
    getter,
    Object.create({ stage: "ordered-observation", reason: "shape" }),
    { stage: "ordered-observation", reason: "job-failed" },
    { stage: "constructor", reason: "shape" },
  ]) {
    const error = new Error("fixed");
    expect(() => attachLegacyComposeOrderedRefusal(error, diagnostic)).toThrow(
      "values omitted"
    );
    expect(legacyComposeOrderedRefusal(error)).toBeUndefined();
  }
  expect(reads).toBe(0);
});

test("public JSON envelope receives only the captured stage/reason pair", () => {
  const source = { stage: "ordered-observation", reason: "shape" };
  const error = new Error("fixed");
  attachLegacyComposeOrderedRefusal(error, source);
  source.reason = "private-mutated-canary";
  const result = errorResultFromUnknown({
    error: new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "fixed",
      detail: { legacy_adoption_refusal: legacyComposeOrderedRefusal(error) },
    }),
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message: "fixed",
      detail: {
        legacy_adoption_refusal: {
          stage: "ordered-observation",
          reason: "shape",
        },
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-mutated-canary");
});

test("forged, inherited and accessor-bearing errors cannot forge diagnostics or execute getters", () => {
  let reads = 0;
  const issued = legacyComposeOrderedError({
    diagnostic: { stage: "ordered-scheduler", reason: "job-failed" },
    message: "fixed",
  });
  const accessor = Object.defineProperty(new Error("private-error"), "detail", {
    get: () => {
      reads += 1;
      throw new Error("private-getter");
    },
  });
  for (const error of [
    null,
    "private-error",
    { ...issued },
    Object.create(issued),
    accessor,
    { stage: "ordered-scheduler", reason: "job-failed" },
  ]) {
    expect(legacyComposeOrderedRefusal(error)).toBeUndefined();
  }
  expect(reads).toBe(0);
});
