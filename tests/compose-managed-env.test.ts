import { expect, test } from "bun:test";
import { YAML } from "bun";
import { renderManagedComposeEnvOverride } from "../src/lib/compose-managed-env.ts";

test("managed projection preserves canonical bytes, ordered targets and literal private values", () => {
  const globalEnv = Object.freeze({ BASE: "base", EMPTY: "" });
  const serviceEnv = Object.freeze({
    second: Object.freeze({
      LAST: "last",
      EMPTY: "",
      MULTILINE: "a\nb",
      NUMERIC: "4000",
      PRIVATE: "synthetic-only",
    }),
    first: Object.freeze({ FIRST: "first", PRIVATE: "synthetic-only" }),
    inactive: Object.freeze({ OMITTED: "unused" }),
  });
  const projected = renderManagedComposeEnvOverride({
    targetServices: ["second", "first", "fallback"],
    globalEnv,
    serviceEnv,
  });
  const canonical =
    'services:\n  second:\n    environment:\n      LAST: last\n      EMPTY: ""\n      MULTILINE: "a\\nb"\n      NUMERIC: "4000"\n      PRIVATE: synthetic-only\n  first:\n    environment:\n      FIRST: first\n      PRIVATE: synthetic-only\n  fallback:\n    environment:\n      BASE: base\n      EMPTY: ""\n';
  expect(projected).toBe(canonical);
  expect(YAML.parse(projected ?? "")).toEqual({
    services: {
      second: { environment: serviceEnv.second },
      first: { environment: serviceEnv.first },
      fallback: { environment: globalEnv },
    },
  });
  expect(Object.keys(serviceEnv)).toEqual(["second", "first", "inactive"]);
  expect(Object.keys(serviceEnv.second)).toEqual([
    "LAST",
    "EMPTY",
    "MULTILINE",
    "NUMERIC",
    "PRIVATE",
  ]);
});

test("empty target environments produce no fragment while explicit empty values remain present", () => {
  expect(
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv: {},
    })
  ).toBeNull();
  expect(
    renderManagedComposeEnvOverride({
      targetServices: ["web"],
      globalEnv: {},
      serviceEnv: { web: { EMPTY: "" } },
    })
  ).toBe('services:\n  web:\n    environment:\n      EMPTY: ""\n');
  expect(
    renderManagedComposeEnvOverride({
      targetServices: [],
      globalEnv: { GLOBAL: "unused" },
      serviceEnv: {},
    })
  ).toBeNull();
});
