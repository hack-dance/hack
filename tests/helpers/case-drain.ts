import { test as bunTest } from "bun:test";

/**
 * Case budgets for a test file whose cases share module-level fixture state
 * (temp roots, a stub engine on `PATH`, process environment).
 *
 * Bun's own timeout does not cancel a case body. An abandoned body keeps
 * running, and while the next case runs it can still read the shared globals,
 * spawn through the shared `PATH` and restore environment it saved. Such files
 * used to latch after the first abandoned case and fail every later case.
 *
 * This guard runs each body under its own budget instead, so an overrun fails
 * that case by name. The overrunning body then gets `drainMs` (inside the same
 * case's Bun timeout) to settle; bodies normally end within it, because each
 * owner operation they await has its own caller deadline below `drainMs`.
 *
 * - Settled: the case still fails once with its budget refusal, and the next
 *   case starts normally.
 * - Still running: the shared state stays reserved for that body. `reservedBy`
 *   names it, so the file's `beforeEach` refuses with a closed reason instead
 *   of reusing state the body may still touch, and `afterEach` keeps its roots.
 *   The reservation clears by itself when the body settles, and later cases
 *   run normally again.
 */
export type CaseDrain = {
  /** Register a case: `budgetMs` bounds its body; the Bun timeout adds the drain. */
  readonly test: (
    name: string,
    body: () => void | Promise<void>,
    budgetMs: number
  ) => void;
  /** Run one case body under `budgetMs`, then the drain. Rejects with the case's own outcome. */
  readonly run: (
    name: string,
    body: () => void | Promise<void>,
    budgetMs: number
  ) => Promise<void>;
  /** The Bun timeout for a body budget: budget, drain and margin. */
  readonly bunTimeoutMs: (budgetMs: number) => number;
  /** The case whose body still runs past its budget and drain, if any. */
  readonly reservedBy: () => string | undefined;
  /** Refuse, with a closed reason, while an earlier case's body still runs. */
  readonly requireUnreserved: () => void;
};

/** Slack between a case's budget plus drain and Bun's own timeout. */
export const CASE_DRAIN_BUN_MARGIN_MS = 5000;

type Outcome = "settled" | "overrun";

async function within(running: Promise<void>, ms: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overrun = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve("overrun"), ms);
  });
  try {
    return await Promise.race([
      running.then(
        (): Outcome => "settled",
        (): Outcome => "settled"
      ),
      overrun,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createCaseDrain(opts: {
  /** Prefix for refusals, e.g. "Adoption fixture". */
  readonly label: string;
  /** Time an overrunning body gets to settle before its state stays reserved. */
  readonly drainMs: number;
}): CaseDrain {
  let reservation: { readonly name: string } | undefined;
  const bunTimeoutMs = (budgetMs: number) =>
    budgetMs + opts.drainMs + CASE_DRAIN_BUN_MARGIN_MS;
  const requireUnreserved = () => {
    if (reservation !== undefined) {
      throw new Error(
        `E_TEST_CASE_RESERVED: ${opts.label} case "${reservation.name}" still runs past its budget and drain, so this case did not start; cases start again once it settles.`
      );
    }
  };
  const run = async (
    name: string,
    body: () => void | Promise<void>,
    budgetMs: number
  ): Promise<void> => {
    requireUnreserved();
    const running = (async () => {
      await body();
    })();
    if ((await within(running, budgetMs)) === "settled") {
      await running;
      return;
    }
    const drained = await within(running, opts.drainMs);
    if (drained === "overrun") {
      const held = { name };
      reservation = held;
      running
        .catch(() => undefined)
        .finally(() => {
          if (reservation === held) {
            reservation = undefined;
          }
        });
    }
    throw new Error(
      drained === "settled"
        ? `E_TEST_CASE_BUDGET: ${opts.label} case exceeded its ${budgetMs} ms budget; its body settled within the ${opts.drainMs} ms drain, so later cases start normally.`
        : `E_TEST_CASE_BUDGET: ${opts.label} case exceeded its ${budgetMs} ms budget and its ${opts.drainMs} ms drain; its state stays reserved until its body settles.`
    );
  };
  return {
    test: (name, body, budgetMs) => {
      bunTest(name, () => run(name, body, budgetMs), bunTimeoutMs(budgetMs));
    },
    run,
    bunTimeoutMs,
    reservedBy: () => reservation?.name,
    requireUnreserved,
  };
}
