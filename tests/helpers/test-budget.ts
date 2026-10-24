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
 * `TEST_BUDGET_SCALE` is the headroom for a loaded one. These fixtures are
 * spawn-bound (a retained adoption dispatch runs about 750 stub-engine
 * processes; an authored start runs the compiler several times), so their wall
 * time grows faster than the load average. On the M5 at 1-min load 15-40, and
 * on the M3 while another suite ran, they took three to four times their
 * unloaded time. With a second suite plus churn workers, the M5 at load 28-90
 * took more than ten times: one public retained `up` dispatch outlasted a
 * 200 s deadline, and a v7 dispatch case took 146 s even at load 22-50.
 * A deadline a case does not test must not expire first, so the scale keeps
 * twice that headroom.
 */
export const TEST_BUDGET_SCALE = 20;

/** Scale the unloaded time a fixture needs to the budget a loaded host needs. */
export function testBudgetMs(unloadedMs: number): number {
  if (!(Number.isSafeInteger(unloadedMs) && unloadedMs > 0)) {
    throw new Error("Test budget refused a non-positive or fractional time.");
  }
  return unloadedMs * TEST_BUDGET_SCALE;
}
