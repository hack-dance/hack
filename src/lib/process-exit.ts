/**
 * How the CLI process ends.
 *
 * A command returns its exit code when its work is done. The process then
 * exits explicitly instead of waiting for the event loop to empty, so a timer,
 * socket or child handle that a command forgot to release cannot hold the
 * prompt (a losing `Bun.sleep` in a `Promise.race` kept `hack up -d` open for
 * up to a second).
 *
 * A command whose work deliberately continues after it returns (a stdio MCP
 * server, a foreground daemon) registers that work with {@link holdProcessUntil};
 * the exit waits for every hold to settle first.
 */

const holds = new Set<Promise<unknown>>();

/**
 * Keeps the process running until `work` settles, even though the command
 * that started it has returned. A rejection is not reported here: the owner
 * of `work` reports its own failures.
 */
export function holdProcessUntil(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined
  );
  holds.add(settled);
  void settled.then(() => holds.delete(settled));
}

/** Resolves once every hold, including ones added while waiting, settled. */
async function waitForHolds(): Promise<void> {
  while (holds.size > 0) {
    await Promise.all([...holds]);
  }
}

/**
 * Ends `stream` and resolves once everything written to it was handed to the
 * OS. Bun reports `writableLength` 0 while a pipe write is still buffered, and
 * a `write("", cb)` callback can fire before earlier data is out, so only
 * `end`'s callback proves the flush (measured: 2 MiB to a pipe arrived whole
 * only with `end`). An error (a reader that went away) also ends the wait:
 * nothing is left to deliver.
 */
async function endStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return;
  }
  await new Promise<void>((resolve) => {
    stream.once("error", () => resolve());
    try {
      stream.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Waits for holds, flushes stdout and stderr, then exits with `exitCode`.
 * `exit` is injectable for tests.
 */
export async function exitWhenDone(
  exitCode: number,
  exit: (code: number) => never = process.exit
): Promise<never> {
  await waitForHolds();
  await Promise.all([endStream(process.stdout), endStream(process.stderr)]);
  return exit(exitCode);
}
