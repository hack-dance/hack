/**
 * Optional long-poll for `GET /v1/projects` (HACK-2218 R9).
 *
 * Every projects payload carries `state_token`, a digest of its content
 * without the per-response `generated_at` and `profiling` fields. A client that
 * sends `wait=<token>` gets an answer as soon as the token differs. Otherwise
 * the request waits for runtime cache refreshes (Docker events and the daemon's
 * periodic refresh) and recomputes after each one, until the token changes or
 * `wait_timeout_ms` passes. A timeout answers with the unchanged payload, so a
 * client simply asks again. Registry-only changes are seen at the next refresh.
 */
import { createHash } from "node:crypto";

export const PROJECTS_WAIT_DEFAULT_MS = 25_000;
export const PROJECTS_WAIT_MIN_MS = 1000;
export const PROJECTS_WAIT_MAX_MS = 55_000;
/** Concurrent waiters; beyond this a request is answered at once. */
export const PROJECTS_WAIT_MAX_WAITERS = 16;

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const DIGITS = /^\d+$/;

/**
 * Top-level fields that differ between two builds of identical state: the
 * per-response stamp and profile, and refresh timestamps that advance on
 * every periodic refresh even when nothing changed.
 */
const VOLATILE_FIELDS = new Set([
  "generated_at",
  "profiling",
  "state_token",
  "runtime_checked_at",
  "runtime_last_ok_at",
]);

/**
 * Docker's container `status` is humanized text ("Up 12 seconds") that changes
 * on every refresh. The container's `state` and the shared service state and
 * health fields still count.
 */
function stableValue(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "id" in value &&
    "state" in value &&
    "status" in value
  ) {
    const { status: _status, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
}

export function projectsStateToken(payload: object): string {
  const stable = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !VOLATILE_FIELDS.has(key))
  );
  return createHash("sha256")
    .update(JSON.stringify(stable, stableValue))
    .digest("hex")
    .slice(0, 32);
}

export type ProjectsWaitRequest =
  | { readonly kind: "none" }
  | {
      readonly kind: "wait";
      readonly token: string;
      readonly timeoutMs: number;
    }
  | { readonly kind: "invalid"; readonly error: string };

/** Parse `wait` and `wait_timeout_ms`; a timeout without `wait` is invalid. */
export function parseProjectsWait(
  params: URLSearchParams
): ProjectsWaitRequest {
  const token = params.get("wait");
  const timeout = params.get("wait_timeout_ms");
  if (token === null) {
    return timeout === null
      ? { kind: "none" }
      : { kind: "invalid", error: "wait_timeout_requires_wait" };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { kind: "invalid", error: "invalid_wait" };
  }
  if (timeout === null) {
    return { kind: "wait", token, timeoutMs: PROJECTS_WAIT_DEFAULT_MS };
  }
  const value = DIGITS.test(timeout) ? Number(timeout) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < PROJECTS_WAIT_MIN_MS ||
    value > PROJECTS_WAIT_MAX_MS
  ) {
    return { kind: "invalid", error: "invalid_wait_timeout_ms" };
  }
  return { kind: "wait", token, timeoutMs: value };
}

let waiters = 0;

/**
 * Build the payload, then, for a wait request whose token still matches,
 * rebuild after each refresh until it changes, the deadline passes or the
 * client goes away. Always resolves with the latest payload and its token.
 */
export async function resolveProjectsPayload<T extends object>(opts: {
  readonly build: () => Promise<T>;
  readonly wait: ProjectsWaitRequest;
  /** Completed-refresh count, read before each build. */
  readonly refreshGeneration: () => number;
  /**
   * Resolves once a refresh newer than `after` has completed (at once if one
   * already has), at the deadline, or on abort.
   */
  readonly nextRefresh: (opts: {
    readonly after: number;
    readonly signal: AbortSignal;
    readonly deadlineMs: number;
  }) => Promise<void>;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): Promise<T & { readonly state_token: string }> {
  const now = opts.now ?? Date.now;
  // The generation is read before each build, so a refresh that completes
  // while building wakes the next wait at once instead of being missed.
  let seen = opts.refreshGeneration();
  const tokenOf = async () => {
    seen = opts.refreshGeneration();
    const payload = await opts.build();
    return { payload, token: projectsStateToken(payload) };
  };
  let current = await tokenOf();
  if (
    opts.wait.kind !== "wait" ||
    current.token !== opts.wait.token ||
    waiters >= PROJECTS_WAIT_MAX_WAITERS
  ) {
    return { ...current.payload, state_token: current.token };
  }
  const deadlineMs = now() + opts.wait.timeoutMs;
  waiters++;
  try {
    while (!opts.signal.aborted && now() < deadlineMs) {
      await opts.nextRefresh({ after: seen, signal: opts.signal, deadlineMs });
      if (opts.signal.aborted || now() >= deadlineMs) {
        break;
      }
      current = await tokenOf();
      if (current.token !== opts.wait.token) {
        break;
      }
    }
    // A timeout still answers with fresh content: registry changes do not
    // trigger a refresh, so rebuild once rather than resend the first build.
    if (!opts.signal.aborted && current.token === opts.wait.token) {
      current = await tokenOf();
    }
  } finally {
    waiters--;
  }
  return { ...current.payload, state_token: current.token };
}

/** Test seam: current number of waiting requests. */
export function projectsWaiterCount(): number {
  return waiters;
}
