import {
  createNativeForegroundDownHooks,
  type NativeDownHookOutcome,
  nativeForegroundStopFailure,
} from "./native-project-down-hooks.ts";
import type { NativeProjectRunScope } from "./native-project-run.ts";

/**
 * Stop requests of a native foreground `up`. The first SIGINT/SIGTERM (or the
 * caller's signal) aborts `signal`; a second one, or the caller's force
 * signal, also aborts `force`, which cancels a running down hook and forces
 * the graph owner to stop.
 */
export function nativeForegroundStopSignals(opts: {
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
}) {
  const controller = new AbortController();
  const force = new AbortController();
  let interruptedExit = 130;
  const cancel = () => (controller.signal.aborted ? force : controller).abort();
  const terminate = () => {
    interruptedExit = 143;
    cancel();
  };
  const forced = () => {
    controller.abort();
    force.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", terminate);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  opts.forceSignal?.addEventListener("abort", forced, { once: true });
  return {
    controller,
    force: force.signal,
    interruptedExit: () => interruptedExit,
    /** Apply stop requests that predate registration. */
    admitPending: () => {
      if (opts.signal?.aborted) {
        cancel();
      }
      if (opts.forceSignal?.aborted) {
        forced();
      }
    },
    dispose: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", terminate);
      opts.signal?.removeEventListener("abort", cancel);
      opts.forceSignal?.removeEventListener("abort", forced);
    },
  };
}

/** Shown while the first stop waits for a concurrent `hack down`'s hook. */
export const NATIVE_DOWN_BEFORE_WAIT =
  "Another hack down is running down.before; waiting for it before stopping the graph. Press Ctrl-C again to force the stop.";

export type NativeForegroundStopCommands = {
  readonly before: (signal: AbortSignal) => Promise<number>;
  readonly after: (signal: AbortSignal) => Promise<number>;
};

/**
 * Down hooks of one foreground generation, matching `hack down` on Compose:
 * on the first stop request of a ready graph `down.before` runs, then graph
 * cleanup, lifecycle-process retirement and `down.after`, each recorded in
 * the value-free journal so a later `hack down` neither skips nor reruns them.
 */
export function createNativeForegroundStop(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: string;
  readonly commands: NativeForegroundStopCommands;
  readonly force: AbortSignal;
  readonly journal?: typeof createNativeForegroundDownHooks;
  /** Where the wait for another stop's `down.before` is announced. */
  readonly notice?: (message: string) => void;
}) {
  const notice =
    opts.notice ?? ((message: string) => process.stderr.write(`${message}\n`));
  const journal = (opts.journal ?? createNativeForegroundDownHooks)({
    scope: opts.scope,
    run: opts.run,
  });
  const canceled = () => opts.force.aborted;
  let before: NativeDownHookOutcome = "skipped";
  let refusal: unknown;
  return {
    /**
     * Graph-owner options: run `down.before` (or await a concurrent
     * `hack down`'s running one) before the owner is asked to stop.
     * The owner runs in its own process group so the terminal's interrupt
     * reaches only this frontend. A failed hook still stops the graph because
     * the user asked to exit; final graph inspection stays the cleanup
     * authority, as without hooks.
     */
    serve: {
      forceSignal: opts.force,
      requireGroupSettlement: false,
      beforeStop: async () => {
        try {
          before = await journal.before(
            () => opts.commands.before(opts.force),
            canceled,
            () => notice(NATIVE_DOWN_BEFORE_WAIT)
          );
        } catch (error) {
          refusal = error;
        }
        return true;
      },
    },
    owe: journal.owe,
    /**
     * After confirmed graph cleanup and lifecycle-process retirement, before
     * the frontend's finalization acknowledgement: run this generation's owed
     * `down.after`. Resolves to the stop's failure to report, if any.
     */
    finish: async (graphCleanupConfirmed: boolean): Promise<unknown> => {
      if (refusal !== undefined) {
        return refusal;
      }
      const after = graphCleanupConfirmed
        ? await journal
            .after(() => opts.commands.after(opts.force), canceled)
            .catch((error: unknown) => error)
        : "skipped";
      return nativeForegroundStopFailure({ before, after });
    },
  };
}
export type NativeForegroundStop = ReturnType<
  typeof createNativeForegroundStop
>;
