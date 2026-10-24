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
 * Listeners the callback leaves behind are kept, so the test's own assertions
 * and the global-state guard still see them. Bun does not expose `once`, so a
 * saved `once` listener comes back as a persistent one. Between tests the
 * guarded events normally have no listeners (the guard fails a file that
 * leaves one), so the saved list is normally empty.
 */
export async function withOwnedProcessListeners<T>(
  event: NodeJS.Signals | "exit",
  run: () => Promise<T> | T
): Promise<T> {
  const saved = process.listeners(event);
  for (const listener of saved) {
    process.removeListener(event, listener);
  }
  try {
    return await run();
  } finally {
    for (const listener of saved) {
      process.on(event, listener);
    }
  }
}
