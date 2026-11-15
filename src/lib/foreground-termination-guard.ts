/**
 * Keep the foreground command's signal owner alive through caller cleanup.
 * The subprocess runner forwards signals while its child is live; this guard
 * records cancellation and requests escalation on a second Ctrl-C, without turning
 * a lifecycle cleanup's re-raised signal into a second child interrupt.
 */
export function installForegroundTerminationGuard(): {
  readonly exitCode: () => 130 | 143 | null;
  readonly force: AbortSignal;
  readonly dispose: () => void;
} {
  let code: 130 | 143 | null = null;
  let interrupts = 0;
  const force = new AbortController();
  const onInterrupt = (): void => {
    code ??= 130;
    interrupts += 1;
    if (interrupts >= 2) {
      force.abort();
    }
  };
  const onTerminate = (): void => {
    code ??= 143;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    exitCode: () => code,
    force: force.signal,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}
