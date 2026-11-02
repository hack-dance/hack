import { onTestFinished } from "bun:test";
import {
  addProcessListener,
  isProcessOnceListener,
} from "./process-once-listeners.ts";

/**
 * Lets a test emit a real process event without reaching listeners it does not
 * own.
 *
 * Every test file shares one Bun process, so `process.emit("SIGINT")` in a
 * test runs every SIGINT listener in that process, including a leftover from
 * another file. {@link withOwnedProcessListeners} removes the listeners that
 * are present, runs the callback, and adds them back afterwards, so the
 * callback sees only the listeners it installs itself.
 *
 * The saved listeners come back however the test ends: when the callback
 * settles, and also when the test times out while the callback is still
 * pending. A timed-out callback never settles its own `finally`, so the
 * restore is also registered with the test (`onTestFinished`) and in a
 * process-wide set that the global-state-guard preload empties before it
 * compares a test's state ({@link restoreUnsettledOwnedProcessListeners}).
 * Without that, another file's listeners would stay removed and the guard
 * would blame the timed-out test for removing them (HACK-1455). Restoring is
 * idempotent: a callback that settles after its test timed out adds nothing a
 * second time. Listeners that the callback is still about to install are its
 * own; it keeps running with the saved listeners back in place.
 *
 * A saved `once` listener comes back as a `once` listener, and a persistent
 * one as persistent (see `tests/helpers/process-once-listeners.ts`).
 * Listeners the callback leaves behind are kept, so the test's own assertions
 * and the global-state guard still see them. Between tests the guarded events
 * normally have no listeners (the guard fails a file that leaves one), so the
 * saved list is normally empty.
 */
export async function withOwnedProcessListeners<T>(
  event: NodeJS.Signals | "exit",
  run: () => Promise<T> | T
): Promise<T> {
  const saved = (process.listeners(event) as Listener[]).map((listener) => ({
    listener,
    once: isProcessOnceListener(event, listener),
  }));
  for (const { listener } of saved) {
    process.removeListener(event, listener);
  }
  let restored = false;
  const restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    unsettled.delete(restore);
    for (const { listener, once } of saved) {
      addProcessListener(event, listener, once);
    }
  };
  unsettled.add(restore);
  try {
    onTestFinished(restore);
  } catch {
    // Outside a running test there is no test to finish; the callback's own
    // settlement below still restores.
  }
  try {
    return await run();
  } finally {
    restore();
  }
}

type Listener = (...args: unknown[]) => void;

/** Restores of callbacks that have not settled yet. */
const unsettled = new Set<() => void>();

/**
 * Puts back the saved listeners of every {@link withOwnedProcessListeners}
 * callback that has not settled, and returns how many it restored. The
 * global-state-guard preload calls this before it compares a test's state,
 * so a test that timed out inside the helper hands other code's listeners
 * back before the comparison.
 */
export function restoreUnsettledOwnedProcessListeners(): number {
  const pending = [...unsettled];
  for (const restore of pending) {
    restore();
  }
  return pending.length;
}
