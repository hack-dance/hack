import { expect, test } from "bun:test";
import { DEFAULT_FILE_TIMEOUT_SECONDS } from "../scripts/test-shard.ts";
import {
  CASE_TIMEOUT_CEILING_MS,
  SHARD_FILE_TIMEOUT_MS,
  TEST_BUDGET_SCALE,
  testBudgetMs,
  withinCaseCeilingMs,
} from "./helpers/test-budget.ts";

test("the case ceiling follows the hosted shard's per-file limit", () => {
  expect(SHARD_FILE_TIMEOUT_MS).toBe(DEFAULT_FILE_TIMEOUT_SECONDS * 1000);
  // The slowest hosted file took up to 417 s; it plus one hung case must end
  // before the shard stops the file, so Bun names that case.
  expect(417_000 + CASE_TIMEOUT_CEILING_MS).toBeLessThan(SHARD_FILE_TIMEOUT_MS);
});

test("test budgets scale the unloaded time and stop at the ceiling", () => {
  expect(testBudgetMs(250)).toBe(250 * TEST_BUDGET_SCALE);
  expect(testBudgetMs(1_000_000)).toBe(CASE_TIMEOUT_CEILING_MS);
  expect(testBudgetMs(1_000_000, { ceilingMs: 10_000 })).toBe(10_000);
  expect(testBudgetMs(100, { ceilingMs: 10_000 })).toBe(
    Math.min(100 * TEST_BUDGET_SCALE, 10_000)
  );
});

test("test budgets refuse invalid times and ceilings above the case ceiling", () => {
  for (const unloadedMs of [0, -1, 1.5, Number.NaN]) {
    expect(() => testBudgetMs(unloadedMs)).toThrow(/^E_TEST_BUDGET_INVALID/);
  }
  expect(() =>
    testBudgetMs(1000, { ceilingMs: CASE_TIMEOUT_CEILING_MS + 1 })
  ).toThrow(/^E_TEST_BUDGET_INVALID/);
});

test("a composed case timeout must fit the case ceiling", () => {
  expect(withinCaseCeilingMs(CASE_TIMEOUT_CEILING_MS)).toBe(
    CASE_TIMEOUT_CEILING_MS
  );
  expect(() => withinCaseCeilingMs(CASE_TIMEOUT_CEILING_MS + 1)).toThrow(
    /^E_TEST_BUDGET_CEILING/
  );
  expect(() => withinCaseCeilingMs(0)).toThrow(/^E_TEST_BUDGET_CEILING/);
});
