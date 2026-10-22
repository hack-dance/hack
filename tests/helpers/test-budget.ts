/**
 * Harness budgets for load-sensitive tests.
 *
 * A harness budget bounds how long a test waits for its own fixture work:
 * spawning stub engines and compilers, transpiling a child program, or a
 * stub-backed owner operation. It is not a product bound. A passing case
 * finishes as soon as that work does, so a larger budget only lengthens how
 * long a hung case takes to fail. Product bounds under test (an expiring
 * caller deadline, a cancellation latency) keep their own literal values.
 *
 * Each call site names the time its fixture work needs on an unloaded host;
 * `TEST_BUDGET_SCALE` is the headroom for a loaded one. On the M5 at load
 * 15-40, and on the M3 while another suite ran, these fixtures took three to
 * four times their unloaded time and failed at the former literal budgets.
 */
export const TEST_BUDGET_SCALE = 4;

/** Scale the unloaded time a fixture needs to the budget a loaded host needs. */
export function testBudgetMs(unloadedMs: number): number {
  if (!(Number.isSafeInteger(unloadedMs) && unloadedMs > 0)) {
    throw new Error("Test budget refused a non-positive or fractional time.");
  }
  return unloadedMs * TEST_BUDGET_SCALE;
}
