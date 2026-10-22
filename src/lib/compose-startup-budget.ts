import { CliUsageError } from "../cli/command.ts";

/** Default budget for starting containers and waiting on Compose dependencies. */
export const DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS = 90_000;
/** Default budget for image build/pull and container creation before start. */
export const DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS = 1_800_000;
/**
 * Default budget of one native storage carrier: its dependency check, target
 * observation, helper create/policy/start/response/cleanup and closing proof.
 * It equals the earlier shared start default, so an unset host keeps the same
 * per-carrier bound.
 */
export const DEFAULT_NATIVE_STORAGE_TIMEOUT_MS = 90_000;
export const COMPOSE_STARTUP_TIMEOUT_ENV = "HACK_COMPOSE_STARTUP_TIMEOUT_MS";
export const COMPOSE_IMAGE_TIMEOUT_ENV = "HACK_COMPOSE_IMAGE_TIMEOUT_MS";
export const NATIVE_STORAGE_TIMEOUT_ENV = "HACK_NATIVE_STORAGE_TIMEOUT_MS";
const MIN_TIMEOUT_MS = 1000;
const MAX_STARTUP_TIMEOUT_MS = 3_600_000;
const MAX_IMAGE_TIMEOUT_MS = 14_400_000;
const MAX_NATIVE_STORAGE_TIMEOUT_MS = 600_000;
const INTEGER_TEXT = /^[0-9]+$/;

/**
 * Detached Compose startup runs as two bounded invocations, each in its own
 * owned process group that is terminated (exit 124) when its budget expires:
 * - `images`: `up --no-start` builds or pulls missing images and creates or
 *   recreates containers without starting them. Bounded by
 *   {@link resolveComposeImageTimeoutMs}.
 * - `start`: `up -d --no-build` starts containers and waits for Compose
 *   `depends_on` conditions. Bounded by {@link resolveComposeStartupTimeoutMs}.
 * Image acquisition therefore never consumes the start/dependency-wait budget,
 * while a genuine hang in either phase is still terminated.
 */
export type ComposeStartupPhase = "images" | "start";

/**
 * Budget for the `start` phase of detached Compose startup: container start
 * and dependency waiting. It excludes image build/pull and is not an
 * application readiness guarantee.
 */
export function resolveComposeStartupTimeoutMs(
  opts: {
    readonly startupTimeoutMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): number {
  return resolveBudget({
    explicit: opts.startupTimeoutMs,
    configured: (opts.env ?? process.env)[COMPOSE_STARTUP_TIMEOUT_ENV],
    fallback: DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
    max: MAX_STARTUP_TIMEOUT_MS,
    invalid: () =>
      new CliUsageError(
        `Compose startup timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_STARTUP_TIMEOUT_MS} milliseconds (${COMPOSE_STARTUP_TIMEOUT_ENV})`
      ),
  });
}

/** Budget for the `images` phase: image build/pull and container creation. */
export function resolveComposeImageTimeoutMs(
  opts: {
    readonly imageTimeoutMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): number {
  return resolveBudget({
    explicit: opts.imageTimeoutMs,
    configured: (opts.env ?? process.env)[COMPOSE_IMAGE_TIMEOUT_ENV],
    fallback: DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
    max: MAX_IMAGE_TIMEOUT_MS,
    invalid: () =>
      new CliUsageError(
        `Compose image build/pull timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_IMAGE_TIMEOUT_MS} milliseconds (${COMPOSE_IMAGE_TIMEOUT_ENV})`
      ),
  });
}

/**
 * Budget of one native storage carrier (one fresh helper proof session), from
 * `HACK_NATIVE_STORAGE_TIMEOUT_MS`. It is separate from the start budget:
 * storage preparation, enrollment and every storage proof use it, never
 * `HACK_COMPOSE_STARTUP_TIMEOUT_MS`. Each Docker probe inside a carrier keeps its
 * own fixed 10-15 s cap, and an exhausted carrier refuses with the closed
 * `storage-budget` effect reason. It grants nothing and relaxes no check.
 */
export function resolveNativeStorageTimeoutMs(
  opts: {
    readonly storageTimeoutMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): number {
  return resolveBudget({
    explicit: opts.storageTimeoutMs,
    configured: (opts.env ?? process.env)[NATIVE_STORAGE_TIMEOUT_ENV],
    fallback: DEFAULT_NATIVE_STORAGE_TIMEOUT_MS,
    max: MAX_NATIVE_STORAGE_TIMEOUT_MS,
    invalid: () =>
      new CliUsageError(
        `Native storage timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_NATIVE_STORAGE_TIMEOUT_MS} milliseconds (${NATIVE_STORAGE_TIMEOUT_ENV})`
      ),
  });
}

/**
 * Whole-phase cap on storage time excluded from one `up`/`restart` start
 * deadline. Each guard storage proof is bounded per carrier by
 * `HACK_NATIVE_STORAGE_TIMEOUT_MS` (S), and a phase runs up to (5B+3) guard
 * proofs for B builds, each with one carrier per enrolled volume (V). Without
 * a cap the excluded total is finite, at most (5B+3) x V x S, but it grows with
 * the build and volume counts and can reach hours: 4 builds and 3 volumes
 * allow 69 carriers, about 1.7 hours at the 90 s default and 11.5 hours at the
 * 600 s maximum. The excluded total may therefore not exceed
 * {@link NATIVE_STORAGE_EXCLUSION_MULTIPLE} x S or
 * {@link MAX_NATIVE_STORAGE_EXCLUSION_MS}, whichever is smaller: 24 minutes at
 * the 90 s default and 1 hour from S = 225 s up. Ordinary proofs take a small
 * fraction of S, so the cap only stops a phase whose proofs keep running near
 * their per-proof budget.
 */
export const NATIVE_STORAGE_EXCLUSION_MULTIPLE = 16;
/** Absolute ceiling of excluded storage time in one start phase (1 hour). */
export const MAX_NATIVE_STORAGE_EXCLUSION_MS = 3_600_000;

/** Excluded storage time one start phase may use for a per-carrier budget S. */
export function nativeComposeStorageExclusionCapMs(
  storageTimeoutMs: number
): number {
  return Math.min(
    NATIVE_STORAGE_EXCLUSION_MULTIPLE * storageTimeoutMs,
    MAX_NATIVE_STORAGE_EXCLUSION_MS
  );
}

/**
 * Closed, value-free refusal once a start phase has spent its whole-phase
 * storage exclusion cap. Its effect reason is `storage-budget`; it grants
 * nothing and relaxes no check.
 */
export class NativeStorageTotalBudgetError extends Error {
  constructor() {
    super(
      "Native storage proofs exhausted the whole-phase storage budget; values omitted."
    );
    this.name = "NativeStorageTotalBudgetError";
  }
}

/**
 * Start deadline of a native `up`/`restart` workload phase (image builds,
 * container start, readiness and route verification), bounded by
 * `HACK_COMPOSE_STARTUP_TIMEOUT_MS`. Storage proofs that pre-spawn guards run
 * inside this phase are bounded by their own `HACK_NATIVE_STORAGE_TIMEOUT_MS`
 * carriers instead: their monotonic elapsed time extends this deadline rather
 * than consuming it. Only each carrier proof (carrier creation and witness
 * verification) is excluded; a guard's freshness checks and saved-state reads
 * around it consume the start budget. Overlapping exclusions count once, a
 * rejected proof still counts as excluded time, and the deadline never moves
 * earlier.
 *
 * The excluded total is capped by
 * {@link nativeComposeStorageExclusionCapMs}: the deadline moves at most that
 * far, a proof that would start at or past the cap is refused before it runs,
 * and a proof that ends past it refuses the phase with
 * {@link NativeStorageTotalBudgetError} (a failed proof keeps its own error).
 * The phase therefore ends within the start budget, plus the cap, plus at
 * most one in-flight guard proof, which is itself bounded per carrier.
 */
export function createNativeComposeStartDeadline(opts: {
  readonly timeoutMs: number;
  /** Per-carrier storage budget S, from {@link resolveNativeStorageTimeoutMs}. */
  readonly storageTimeoutMs: number;
  /** Wall clock that callers compare the deadline with; defaults to `Date.now`. */
  readonly wallNow?: () => number;
  /** Monotonic clock that measures excluded storage time. */
  readonly monotonicNow?: () => number;
}): {
  readonly deadline: () => number;
  readonly excludeStorage: <T>(work: () => Promise<T>) => Promise<T>;
} {
  const wallNow = opts.wallNow ?? Date.now;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const capMs = nativeComposeStorageExclusionCapMs(opts.storageTimeoutMs);
  const base = wallNow() + opts.timeoutMs;
  let excluded = 0;
  let active = 0;
  let since = 0;
  const spent = () =>
    excluded + (active > 0 ? Math.max(0, monotonicNow() - since) : 0);
  return {
    deadline: () => base + Math.min(capMs, spent()),
    excludeStorage: async (work) => {
      if (spent() >= capMs) {
        throw new NativeStorageTotalBudgetError();
      }
      if (active === 0) {
        since = monotonicNow();
      }
      active += 1;
      let value: Awaited<ReturnType<typeof work>>;
      try {
        value = await work();
      } finally {
        active -= 1;
        if (active === 0) {
          excluded += Math.max(0, monotonicNow() - since);
        }
      }
      if (spent() > capMs) {
        throw new NativeStorageTotalBudgetError();
      }
      return value;
    },
  };
}

function resolveBudget(opts: {
  readonly explicit: number | undefined;
  readonly configured: string | undefined;
  readonly fallback: number;
  readonly max: number;
  readonly invalid: () => CliUsageError;
}): number {
  let timeout = opts.explicit;
  if (timeout === undefined) {
    if (opts.configured === undefined) {
      return opts.fallback;
    }
    if (!INTEGER_TEXT.test(opts.configured)) {
      throw opts.invalid();
    }
    timeout = Number(opts.configured);
  }
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_TIMEOUT_MS ||
    timeout > opts.max
  ) {
    throw opts.invalid();
  }
  return timeout;
}

export interface ComposeStartupBudgets {
  readonly startupTimeoutMs: number;
  readonly imageTimeoutMs: number;
}

const PHASE_LABEL: Readonly<Record<ComposeStartupPhase, string>> = {
  images: "image build/pull and container creation",
  start: "start and dependency wait",
};

/** One-line summary of both detached phases and their effective budgets. */
export function describeComposeStartupBudgets(
  budgets: ComposeStartupBudgets
): string {
  return `${PHASE_LABEL.images} (budget ${budgets.imageTimeoutMs} ms, ${COMPOSE_IMAGE_TIMEOUT_ENV}), then ${PHASE_LABEL.start} (budget ${budgets.startupTimeoutMs} ms, ${COMPOSE_STARTUP_TIMEOUT_ENV})`;
}

export interface ComposeStartupFailure {
  readonly code: "E_COMPOSE_FAILED" | "E_STARTUP_TIMEOUT";
  readonly message: string;
  readonly phase: ComposeStartupPhase;
  readonly budgetMs: number;
  readonly budgetEnv: string;
}

/**
 * Map a detached Compose exit code to the CLI failure contract. Exit 124 is
 * the owned process-group deadline; its message names the phase that hit it,
 * the effective budget, and the host variable that raises it.
 */
export function composeStartupFailure(opts: {
  readonly code: number;
  readonly action: string;
  readonly phase: ComposeStartupPhase;
  readonly budgets: ComposeStartupBudgets;
}): ComposeStartupFailure {
  const images = opts.phase === "images";
  const budgetMs = images
    ? opts.budgets.imageTimeoutMs
    : opts.budgets.startupTimeoutMs;
  const budgetEnv = images
    ? COMPOSE_IMAGE_TIMEOUT_ENV
    : COMPOSE_STARTUP_TIMEOUT_ENV;
  const phaseLabel = PHASE_LABEL[opts.phase];
  if (opts.code !== 124) {
    return {
      code: "E_COMPOSE_FAILED",
      message: `${opts.action} failed (exit ${opts.code}) during Compose ${phaseLabel}`,
      phase: opts.phase,
      budgetMs,
      budgetEnv,
    };
  }
  const message = images
    ? `${opts.action} exceeded its Compose image build/pull budget of ${budgetMs} ms (phase: ${phaseLabel}). Raise it with ${budgetEnv}=<ms> on the host invocation (max ${MAX_IMAGE_TIMEOUT_MS}); it is separate from ${COMPOSE_STARTUP_TIMEOUT_ENV}. The Compose process group was terminated before this attempt started containers; containers may have been created or recreated but not started. Inspect hack ps before retrying.`
    : `${opts.action} exceeded its detached Compose startup budget of ${budgetMs} ms (phase: ${phaseLabel}). Raise it with ${budgetEnv}=<ms> on the host invocation (max ${MAX_STARTUP_TIMEOUT_MS}). The Compose process group was terminated; inspect hack ps and hack logs before retrying. Containers may still be running. Image build/pull is not counted against this budget, and it does not cover lifecycle hooks or application readiness.`;
  return {
    code: "E_STARTUP_TIMEOUT",
    message,
    phase: opts.phase,
    budgetMs,
    budgetEnv,
  };
}
