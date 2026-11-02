import { expect, test } from "bun:test";
import {
  CASE_DRAIN_BUN_MARGIN_MS,
  createCaseDrain,
} from "./helpers/case-drain.ts";

const BUDGET_MS = 40;
const DRAIN_MS = 200;
/**
 * For a case whose body must settle inside a wait: a passing case ends as soon
 * as the body does, so this length only has to outlast a pause on a loaded host.
 */
const UNHURRIED_MS = 30_000;
const UNHURRIED_CASE_TIMEOUT_MS = UNHURRIED_MS + 5000;

test(
  "a case that overruns its budget but settles within the drain fails once and leaves later cases free",
  async () => {
    const cases = createCaseDrain({ label: "Fixture", drainMs: UNHURRIED_MS });
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
  },
  UNHURRIED_CASE_TIMEOUT_MS
);

test("a case still running past its drain reserves shared state only until its body settles", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  const release = Promise.withResolvers<void>();
  await expect(
    cases.run("hung", () => release.promise, BUDGET_MS)
  ).rejects.toThrow(
    /^E_TEST_CASE_BUDGET: Fixture case exceeded .*the next case waits/
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

test(
  "the next case waits for a reserving body and starts once it settles",
  async () => {
    const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
    const release = Promise.withResolvers<void>();
    await expect(
      cases.run("slow", () => release.promise, BUDGET_MS)
    ).rejects.toThrow(/^E_TEST_CASE_BUDGET/);
    setTimeout(() => release.resolve(), 50);
    await cases.awaitUnreserved(UNHURRIED_MS);
    expect(cases.reservedBy()).toBeUndefined();
    let ran = false;
    await cases.run(
      "next",
      () => {
        ran = true;
      },
      BUDGET_MS
    );
    expect(ran).toBe(true);
  },
  UNHURRIED_CASE_TIMEOUT_MS
);

test("after one wait runs out, later cases refuse at once until the body settles", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  const release = Promise.withResolvers<void>();
  await expect(
    cases.run("hung", () => release.promise, BUDGET_MS)
  ).rejects.toThrow(/^E_TEST_CASE_BUDGET/);
  const started = performance.now();
  await expect(cases.awaitUnreserved(BUDGET_MS)).rejects.toThrow(
    /^E_TEST_CASE_RESERVED: Fixture case "hung"/
  );
  expect(performance.now() - started).toBeGreaterThanOrEqual(BUDGET_MS - 5);
  // By event order, not elapsed time: a refusal that does not wait settles in
  // microtasks, before any timer, however long a loaded host pauses here.
  const first = await Promise.race([
    cases.awaitUnreserved(DRAIN_MS).then(
      () => "returned",
      (error: Error) => error.message
    ),
    Bun.sleep(0).then(() => "a timer fired first"),
  ]);
  expect(first).toMatch(/^E_TEST_CASE_RESERVED/);
  release.resolve();
  await Bun.sleep(0);
  await cases.awaitUnreserved(DRAIN_MS);
  expect(cases.reservedBy()).toBeUndefined();
});

test(
  "a direct reservation holds like an overrun, refuses a second one and clears when its body settles",
  async () => {
    const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
    const release = Promise.withResolvers<void>();
    cases.reserve("held", release.promise);
    expect(cases.reservedBy()).toBe("held");
    expect(() => cases.reserve("second", Promise.resolve())).toThrow(
      /^E_TEST_CASE_RESERVED: Fixture case "held"/
    );
    expect(cases.reservedBy()).toBe("held");
    release.resolve();
    await cases.awaitUnreserved(UNHURRIED_MS);
    expect(cases.reservedBy()).toBeUndefined();
  },
  UNHURRIED_CASE_TIMEOUT_MS
);

test("awaiting with no reservation returns at once", async () => {
  const cases = createCaseDrain({ label: "Fixture", drainMs: DRAIN_MS });
  await cases.awaitUnreserved(DRAIN_MS);
  expect(cases.reservedBy()).toBeUndefined();
});
