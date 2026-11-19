/**
 * How long a direct `hack daemon start` waits for the hackd it spawned.
 *
 * hackd is ready when its pid file names a live process and its socket
 * exists. It binds the socket only after it has loaded its extensions and
 * asked the container engine for a first snapshot, so the time to ready
 * grows with a slow CPU and with a reachable Docker. Measured for the
 * compiled Linux x86_64 CLI in a CPU-limited container with Docker reachable
 * (HACK-2371): 0.2 to 0.4 s unconstrained, 1.3 to 1.7 s at a quarter of a
 * core, 2.3 to 2.8 s at 0.15 of a core and 4.2 to 6.2 s at a tenth of a
 * core. The earlier 2 s budget reported a healthy daemon as failed on such
 * machines. The budget is a ceiling, never a delay: the wait returns as soon
 * as hackd is ready, and as soon as the spawned process has exited.
 */
export const DETACHED_START_BUDGET_MS = 20_000;

const POLL_MS = 150;

export type DetachedStartOutcome =
  /** hackd reported ready within the budget. */
  | { readonly kind: "ready"; readonly waitedMs: number }
  /** The spawned process ended and no hackd took over: nothing will come. */
  | { readonly kind: "exited"; readonly waitedMs: number }
  /** Something is still running, but it was not ready when the budget ended. */
  | { readonly kind: "timeout"; readonly waitedMs: number };

/**
 * Waits for a spawned hackd: ready as soon as `isReady` holds, `exited` as
 * soon as the spawned process is gone with no live daemon recorded, and
 * `timeout` only when the budget passes while a process is still alive.
 *
 * `daemonAlive` is whether the pid file names a live process. The launcher
 * that was spawned is normally hackd itself (`exec`), but a wrapper may start
 * hackd as another process and leave; that is not an exit. An exit is
 * confirmed by a second look one poll later, so a hackd that is just writing
 * its pid file is not mistaken for one that never started.
 */
export async function waitForDetachedDaemonStart(opts: {
  readonly isReady: () => Promise<boolean>;
  readonly spawnedExited: () => boolean;
  readonly daemonAlive: () => Promise<boolean>;
  readonly budgetMs?: number;
  readonly pollMs?: number;
  /** Test seams; default to the real clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<DetachedStartOutcome> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? POLL_MS;
  const started = now();
  const deadline = started + (opts.budgetMs ?? DETACHED_START_BUDGET_MS);
  let goneOnce = false;
  for (;;) {
    if (await opts.isReady()) {
      return { kind: "ready", waitedMs: now() - started };
    }
    if (opts.spawnedExited() && !(await opts.daemonAlive())) {
      if (goneOnce) {
        return { kind: "exited", waitedMs: now() - started };
      }
      goneOnce = true;
    } else {
      goneOnce = false;
    }
    if (now() >= deadline) {
      return { kind: "timeout", waitedMs: now() - started };
    }
    await sleep(pollMs);
  }
}
