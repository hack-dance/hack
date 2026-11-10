/**
 * Keep the foreground command's signal owner alive through caller cleanup.
 * The subprocess runner forwards signals while its child is live; this guard
 * only records cancellation, so repeated signals cannot abort cleanup or turn
 * a lifecycle cleanup's re-raised signal into a second child interrupt.
 */
export function installForegroundTerminationGuard(): {
  readonly exitCode: () => 130 | 143 | null;
  readonly dispose: () => void;
} {
  let code: 130 | 143 | null = null;
  const onInterrupt = (): void => {
    code ??= 130;
  };
  const onTerminate = (): void => {
    code ??= 143;
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    exitCode: () => code,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    },
  };
}
