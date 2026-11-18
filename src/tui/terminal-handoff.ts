/**
 * Handing the terminal to an interactive child (`hack tui`'s `i`).
 *
 * opentui's `suspend()` can fail two ways, and they need different handling:
 * - it throws synchronously, before changing any state, when terminal setup is
 *   unfinished or another transition is pending: the dashboard still owns the
 *   terminal, so it keeps running and the child is not started;
 * - its promise rejects after it has already detached input and mouse
 *   tracking: the dashboard can no longer read keys, so the failure is
 *   rethrown and ends the dashboard through its fatal handler.
 *
 * A completed suspension is always paired with `resume()` once the child
 * ends, whether it succeeded, failed or threw, unless the dashboard was shut
 * down meanwhile. `resume()` failing is rethrown: the terminal state is then
 * unknown.
 */

export type TerminalHandoff = "handed_over" | "not_handed_over";

export async function beginTerminalHandoff(
  suspend: () => Promise<void>
): Promise<TerminalHandoff> {
  let transition: Promise<void>;
  try {
    transition = suspend();
  } catch {
    return "not_handed_over";
  }
  await transition;
  return "handed_over";
}

/**
 * Runs `child` with the terminal handed over. Returns its exit code, or null
 * when the terminal could not be handed over and nothing was started.
 * `handoff: false` runs a child that returns at once (`tmux switch-client`)
 * without touching the renderer.
 */
export async function runWithTerminalHandoff(opts: {
  readonly handoff: boolean;
  readonly suspend: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly child: () => Promise<number>;
  /** False once the dashboard is shutting down; then nothing is resumed. */
  readonly isActive: () => boolean;
  /** Called after a resume, to repaint the dashboard's own state. */
  readonly afterResume?: () => void;
}): Promise<number | null> {
  if (!opts.handoff) {
    return await opts.child();
  }
  if ((await beginTerminalHandoff(opts.suspend)) === "not_handed_over") {
    return null;
  }
  try {
    return await opts.child();
  } finally {
    if (opts.isActive()) {
      await opts.resume();
      opts.afterResume?.();
    }
  }
}
