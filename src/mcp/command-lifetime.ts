/** Bound an MCP command's lifetime to its request and timeout. The caller owns
 * a detached process group, including descendants which may retain output pipes.
 */
export function superviseMcpCommand(opts: {
  readonly proc: Bun.Subprocess;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onStop?: (reason: string) => void;
}): { readonly stop: (reason: string) => void; readonly dispose: () => void } {
  let stopped = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-opts.proc.pid, signal);
    } catch {
      opts.proc.kill(signal);
    }
  };
  const stop = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    opts.onStop?.(reason);
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 2000);
  };
  const abort = (): void => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
  opts.signal.addEventListener("abort", abort, { once: true });
  if (opts.signal.aborted) {
    abort();
  }
  return {
    stop,
    dispose: () => {
      if (opts.proc.exitCode === null) {
        stop("interrupted");
      }
      clearTimeout(timer);
      clearTimeout(escalation);
      opts.signal.removeEventListener("abort", abort);
      if (stopped) {
        // The leader can exit before descendants that ignore graceful shutdown.
        signalGroup("SIGKILL");
      }
    },
  };
}
