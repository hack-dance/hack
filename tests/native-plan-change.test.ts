import { expect, test } from "bun:test";
import {
  nativePlanChangeGuidance,
  readNativePlanChange,
} from "../src/backends/native-plan-change.ts";

test("only the exact versioned plan-change diagnostic is read", () => {
  const valid = { version: 1, service: "deps", field: "hostnames" };
  expect(readNativePlanChange(valid)).toEqual({
    service: "deps",
    field: "hostnames",
  });
  for (const value of [
    undefined,
    { ...valid, version: 2 },
    { ...valid, field: "environment" },
    { ...valid, field: "toString" },
    { ...valid, service: "two words" },
    { ...valid, extra: true },
  ]) {
    expect(readNativePlanChange(value)).toBeUndefined();
  }
});

test("retained-run edit refusals get closed, accurate guidance", () => {
  expect(
    nativePlanChangeGuidance("graph_plan_change_unsupported", undefined)
  ).toContain("only routed hostname changes apply to it");
  expect(
    nativePlanChangeGuidance("graph_hostname_change", {
      service: "web",
      field: "hostnames",
    })
  ).toContain("the hostname change (service `web`, routed hostnames)");
  expect(nativePlanChangeGuidance("graph_plan_reconcile", undefined)).toBe(
    "this Compose edit cannot be applied to the retained run. Revert the edit to keep the retained run as admitted, or run `hack down --remove-data` and then `hack up` to apply it with fresh data."
  );
  expect(nativePlanChangeGuidance("graph_budget", undefined)).toBeUndefined();
});
