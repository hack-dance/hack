import { test as bunTest } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { restoreEnv } from "./env.ts";
import {
  createNativeAuthoredSettlement,
  type NativeAuthoredSettlement,
} from "./native-authored-settlement.ts";

/**
 * Per-case ownership for native fixtures that spawn owners, groups or stop
 * endpoints.
 *
 * Each guarded case gets its own temp roots, settlement targets and
 * environment snapshot. When the case ends, whatever its outcome, its own
 * targets are settled and the environment it changed is restored. The roots
 * are removed only after the case passes and settles; otherwise they are kept
 * for diagnosis and named on stderr. A failed or unsettled case reports its
 * own failure and never latches state that fails later cases in this file or
 * in other files sharing the Bun process.
 *
 * The case context is found through `AsyncLocalStorage`, so a body that
 * outlives its budget keeps writing into its own context, not the next one.
 */
export type NativeFixtureCase = {
  /** Register a temp root this case owns. */
  readonly root: (path: string) => void;
  /** Targets this case may leave behind; settled when the case ends. */
  readonly settlement: NativeAuthoredSettlement;
  /**
   * Snapshot `keys` the first time each is named in this case; the snapshot is
   * restored when the case ends. Returns the values from before the case.
   */
  readonly saveEnv: (
    keys: readonly string[]
  ) => Readonly<Record<string, string | undefined>>;
  /** Record a failure seen in a callback that must not throw; the case then fails. */
  readonly fail: (error: unknown) => void;
};

export type NativeFixtureCases = {
  /** The guarded case running the caller. Throws outside a guarded case. */
  readonly current: () => NativeFixtureCase;
  /**
   * Register a guarded case. `timeoutMs` bounds the body; the Bun timeout adds
   * the settlement budget and a margin, so cleanup always finishes inside it.
   */
  readonly test: (
    name: string,
    body: () => void | Promise<void>,
    timeoutMs?: number
  ) => void;
};

/** Slack between the case's own deadline plus settlement and Bun's timeout. */
export const NATIVE_FIXTURE_BUN_MARGIN_MS = 5000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Await `running` for at most `timeoutMs`. The body cannot be cancelled, so a
 * late rejection is consumed here; it belongs to the case that already failed.
 */
async function withinBudget(
  label: string,
  running: Promise<void>,
  timeoutMs: number
): Promise<void> {
  running.catch(() => undefined);
  const budget = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    budget.reject(
      new Error(
        `${label} case exceeded its ${timeoutMs} ms budget; its body may still be running.`
      )
    );
  }, timeoutMs);
  try {
    await Promise.race([running, budget.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Throw this case's own outcome; roots stay on disk for diagnosis. */
function reportRetained(opts: {
  readonly label: string;
  readonly roots: readonly string[];
  readonly failure: { readonly error: unknown } | undefined;
  readonly unsettled: { readonly error: unknown } | undefined;
}): never {
  if (opts.roots.length > 0) {
    console.error(
      `${opts.label} roots retained for diagnosis: ${opts.roots.join(", ")}`
    );
  }
  if (opts.failure !== undefined) {
    if (opts.unsettled !== undefined) {
      console.error(
        `${opts.label} settlement also unconfirmed: ${message(opts.unsettled.error)}`
      );
    }
    throw opts.failure.error;
  }
  throw new Error(
    `${opts.label} settlement unconfirmed for this case; roots retained. ${message(opts.unsettled?.error)}`,
    { cause: opts.unsettled?.error }
  );
}

export function createNativeFixtureCases(opts: {
  /** Prefix for diagnostics, e.g. "Startup fixture". */
  readonly label: string;
  /** Body budget for cases that do not name their own. */
  readonly defaultTimeoutMs: number;
  /** Time allowed for a case's recorded targets to become absent. */
  readonly settlementBudgetMs: number;
}): NativeFixtureCases {
  const storage = new AsyncLocalStorage<NativeFixtureCase>();
  const current = (): NativeFixtureCase => {
    const value = storage.getStore();
    if (value === undefined) {
      throw new Error(`${opts.label} used outside a guarded case.`);
    }
    return value;
  };
  const runCase = async (
    body: () => void | Promise<void>,
    timeoutMs: number
  ): Promise<void> => {
    const roots: string[] = [];
    const saved = new Map<string, string | undefined>();
    const observed: unknown[] = [];
    const settlement = createNativeAuthoredSettlement();
    const context: NativeFixtureCase = {
      root: (path) => {
        roots.push(path);
      },
      settlement,
      saveEnv: (keys) => {
        for (const key of keys) {
          if (!saved.has(key)) {
            saved.set(key, process.env[key]);
          }
        }
        return Object.fromEntries(keys.map((key) => [key, saved.get(key)]));
      },
      fail: (error) => {
        observed.push(error);
      },
    };
    let failure: { readonly error: unknown } | undefined;
    try {
      await withinBudget(
        opts.label,
        (async () => {
          await storage.run(context, body);
        })(),
        timeoutMs
      );
      if (observed.length > 0) {
        throw observed[0];
      }
    } catch (error) {
      failure = { error };
    }
    // Settle this case's own targets even after a failure, so the next case
    // normally starts without them; a timeout here fails only this case.
    let unsettled: { readonly error: unknown } | undefined;
    try {
      await settlement.settle({ budgetMs: opts.settlementBudgetMs });
    } catch (error) {
      unsettled = { error };
    }
    for (const [key, value] of saved) {
      restoreEnv(key, value);
    }
    if (failure !== undefined || unsettled !== undefined) {
      reportRetained({ label: opts.label, roots, failure, unsettled });
    }
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true }))
    );
  };
  return {
    current,
    test: (name, body, timeoutMs = opts.defaultTimeoutMs) => {
      bunTest(
        name,
        () => runCase(body, timeoutMs),
        timeoutMs + opts.settlementBudgetMs + NATIVE_FIXTURE_BUN_MARGIN_MS
      );
    },
  };
}
