import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A deadline for the child processes started within an async scope
 * (HACK-2189). Shared helpers (`exec` and the git probes) bound their own
 * timeout by it, and start nothing once it has passed, so a caller that
 * gives up on a check at its deadline leaves no child running after it.
 * Outside such a scope nothing changes.
 */
const scope = new AsyncLocalStorage<{ readonly deadline: number }>();

/** Runs `run` with every child process it starts ended by `deadline` (epoch ms). */
export async function withProcessDeadline<T>(
  deadline: number,
  run: () => Promise<T>
): Promise<T> {
  const outer = scope.getStore()?.deadline;
  return await scope.run(
    { deadline: outer === undefined ? deadline : Math.min(outer, deadline) },
    run
  );
}

/**
 * The timeout a child process may have: `requested`, capped by the
 * scope's remaining time. Undefined (no limit) only outside a scope with no
 * request; zero or less means the scope's deadline has passed.
 */
export function boundedTimeoutMs(requested?: number): number | undefined {
  const deadline = scope.getStore()?.deadline;
  if (deadline === undefined) {
    return requested;
  }
  const remaining = deadline - Date.now();
  return requested === undefined ? remaining : Math.min(requested, remaining);
}
