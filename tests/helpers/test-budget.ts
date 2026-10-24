import { DEFAULT_FILE_TIMEOUT_SECONDS } from "../../scripts/test-shard.ts";

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
 *
 * The scale stops at `CASE_TIMEOUT_CEILING_MS`. Hosted CI runs each file under
 * the shard's per-file limit; a case whose budget outlives that limit is
 * reported as a file timeout instead of by name. So the headroom is real only
 * up to the ceiling, and a host loaded past it fails cases by name.
 */
export const TEST_BUDGET_SCALE = 20;

/** Per-file limit of the hosted test shard (`scripts/test-shard.ts`). */
export const SHARD_FILE_TIMEOUT_MS = DEFAULT_FILE_TIMEOUT_SECONDS * 1000;

/**
 * Largest Bun timeout one case may have, its settlement or drain included: a
 * third of the shard's per-file limit. The slowest hosted file (adoption
 * generation, 4m55s-6m57s) plus one case hung for this long still ends inside
 * the 720 s limit, so Bun prints that case's own timeout before the shard
 * stops the file.
 */
export const CASE_TIMEOUT_CEILING_MS = Math.floor(SHARD_FILE_TIMEOUT_MS / 3);

/**
 * Scale the unloaded time a fixture needs to the budget a loaded host needs,
 * never above `ceilingMs` (the case ceiling by default). A file whose Bun
 * timeout adds settlement or drain time to a body budget passes the body's
 * share of the ceiling.
 */
export function testBudgetMs(
  unloadedMs: number,
  opts: { readonly ceilingMs?: number } = {}
): number {
  const ceilingMs = opts.ceilingMs ?? CASE_TIMEOUT_CEILING_MS;
  if (
    !(
      Number.isSafeInteger(unloadedMs) &&
      unloadedMs > 0 &&
      Number.isSafeInteger(ceilingMs) &&
      ceilingMs > 0 &&
      ceilingMs <= CASE_TIMEOUT_CEILING_MS
    )
  ) {
    throw new Error(
      "E_TEST_BUDGET_INVALID: a test budget must be a positive whole number of milliseconds within the case ceiling."
    );
  }
  return Math.min(unloadedMs * TEST_BUDGET_SCALE, ceilingMs);
}

/**
 * Check a composed Bun timeout (a body budget plus settlement, drain or
 * margin) against the case ceiling when the file loads, so a file cannot
 * register a case that would outlive the shard's per-file limit.
 */
export function withinCaseCeilingMs(timeoutMs: number): number {
  if (
    !(
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= CASE_TIMEOUT_CEILING_MS
    )
  ) {
    throw new Error(
      "E_TEST_BUDGET_CEILING: a case timeout must be a positive whole number of milliseconds within the case ceiling."
    );
  }
  return timeoutMs;
}
