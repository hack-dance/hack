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
