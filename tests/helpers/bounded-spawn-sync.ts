/**
 * Synchronous spawns for tests, always with a time bound (HACK-2247).
 *
 * A synchronous spawn blocks the event loop, so Bun's per-test timeout cannot
 * fire while it waits. A child that never finishes, including one that hangs
 * before it starts (seen on macOS when the system policy daemon stalled), then
 * holds the whole test file forever. Every synchronous spawn in `tests/` and
 * `scripts/check-*.ts` therefore passes a `timeout`; `tests/sync-spawn-bound.test.ts`
 * enforces that for new call sites.
 *
 * Limit: the child is killed with SIGKILL at the bound and the spawn then
 * waits for the kernel to reap it. A process the kernel cannot kill (stuck in
 * an uninterruptible wait) can still hold the call.
 */

/** Default bound for one fixture command. Callers pass a smaller one when they can. */
export const SYNC_SPAWN_DEFAULT_TIMEOUT_MS = 30_000;

/** Error thrown when a bounded synchronous spawn hits its bound. */
export class SyncSpawnTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(opts: { readonly command: string; readonly timeoutMs: number }) {
    super(
      `${opts.command} did not finish within ${opts.timeoutMs} ms and was killed (a child that never starts or never exits; see HACK-2247).`
    );
    this.name = "SyncSpawnTimeoutError";
    this.command = opts.command;
    this.timeoutMs = opts.timeoutMs;
  }
}

/** The command's name for messages: the executable and at most two arguments. */
export function describeCommand(cmd: readonly string[]): string {
  const shown = cmd.slice(0, 3).join(" ");
  return cmd.length > 3 ? `${shown} …` : shown;
}

/**
 * `Bun.spawnSync` with a bound: kills the child with SIGKILL after `timeout`
 * ms (default {@link SYNC_SPAWN_DEFAULT_TIMEOUT_MS}) and throws
 * {@link SyncSpawnTimeoutError} naming the command. Any other result,
 * including a non-zero exit, is returned unchanged for the caller to assert.
 */
export function spawnSyncBounded<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "pipe",
>(
  cmd: readonly string[],
  options: Omit<
    Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>,
    "killSignal"
  > = {}
): Bun.SyncSubprocess<Out, Err> {
  const timeoutMs = options.timeout ?? SYNC_SPAWN_DEFAULT_TIMEOUT_MS;
  const result = Bun.spawnSync([...cmd], {
    ...options,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout === true) {
    throw new SyncSpawnTimeoutError({
      command: describeCommand(cmd),
      timeoutMs,
    });
  }
  return result;
}
