import { expect, test } from "bun:test";
import {
  CASE_DRAIN_BUN_MARGIN_MS,
  createCaseDrain,
} from "./helpers/case-drain.ts";

const BUDGET_MS = 40;
const DRAIN_MS = 200;

test("a case that overruns its budget but settles within the drain fails once and leaves later cases free", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  let finished = false;
  await expect(
    cases.run(
      "slow",
      async () => {
        await Bun.sleep(BUDGET_MS + 60);
        finished = true;
      },
      BUDGET_MS
    )
  ).rejects.toThrow(/^E_TEST_CASE_BUDGET: Fixture case exceeded .*settled/);
  // The run returns only after the overrunning body settled.
  expect(finished).toBe(true);
  expect(cases.reservedBy()).toBeUndefined();
  expect(() => cases.requireUnreserved()).not.toThrow();
  let ran = false;
  await cases.run(
    "next",
    () => {
      ran = true;
    },
    BUDGET_MS
  );
  expect(ran).toBe(true);
});

test("a case still running past its drain reserves shared state only until its body settles", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  const release = Promise.withResolvers<void>();
  await expect(
    cases.run("hung", () => release.promise, BUDGET_MS)
  ).rejects.toThrow(
    /^E_TEST_CASE_BUDGET: Fixture case exceeded .*stays reserved/
  );
  expect(cases.reservedBy()).toBe("hung");
  expect(() => cases.requireUnreserved()).toThrow(
    /^E_TEST_CASE_RESERVED: Fixture case "hung" still runs/
  );
  let ran = false;
  await expect(
    cases.run(
      "while-hung",
      () => {
        ran = true;
      },
      BUDGET_MS
    )
  ).rejects.toThrow(/^E_TEST_CASE_RESERVED/);
  expect(ran).toBe(false);
  release.resolve();
  await Bun.sleep(0);
  expect(cases.reservedBy()).toBeUndefined();
  await cases.run(
    "after",
    () => {
      ran = true;
    },
    BUDGET_MS
  );
  expect(ran).toBe(true);
});

test("a case that fails within its budget reports its own error and reserves nothing", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  await expect(
    cases.run(
      "fails",
      () => {
        throw new Error("own failure");
      },
      BUDGET_MS
    )
  ).rejects.toThrow("own failure");
  expect(cases.reservedBy()).toBeUndefined();
});

test("a hung body that later rejects still clears its reservation", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  const release = Promise.withResolvers<void>();
  await expect(
    cases.run("hung", () => release.promise, BUDGET_MS)
  ).rejects.toThrow(/^E_TEST_CASE_BUDGET/);
  release.reject(new Error("late failure"));
  await Bun.sleep(0);
  expect(cases.reservedBy()).toBeUndefined();
});

test("the Bun timeout covers the budget, the drain and the margin", () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  expect(cases.bunTimeoutMs(BUDGET_MS)).toBe(
    BUDGET_MS + DRAIN_MS + CASE_DRAIN_BUN_MARGIN_MS
  );
});
