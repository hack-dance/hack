import { ClosedCliError } from "../lib/cli-result.ts";
import {
  captureNativeProjectFinalization,
  type NativeProjectFinalizationToken,
  recoverNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "./native-project-finalization.ts";
import { nativeRestartSelection } from "./native-project-restart-preflight.ts";
import {
  completeNativeRestartCleanup,
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  type NativeRestartIntent,
  removeNativeRestartIntent,
  saveNativeRestartIntent,
  withNativeRestartLock,
} from "./native-project-run.ts";
import { NativeStartupCanceledError } from "./native-project-start.ts";
import { NativeRuntimeRequestError } from "./native-runtime-client.ts";

/**
 * Stop requests of a native restart until its new foreground `up` installs its
 * own (see `nativeForegroundStopSignals`). Without these, a first Ctrl-C during
 * preflight, cleanup or the early start was either ignored (a SIGINT inherited
 * as ignored, as in a background job) or ended the frontend mid-restart.
 */
export function nativeRestartStopSignals() {
  const controller = new AbortController();
  let interruptedExit = 130;
  const interrupt = () => controller.abort();
  const terminate = () => {
    if (!controller.signal.aborted) {
      interruptedExit = 143;
    }
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let disposed = false;
  return {
    signal: controller.signal,
    interruptedExit: () => interruptedExit,
    dispose: () => {
      if (!disposed) {
        disposed = true;
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      }
    },
  };
}
export type NativeRestartStopSignals = ReturnType<
  typeof nativeRestartStopSignals
>;

/** Progress lines of a canceled restart, matching an interrupted foreground `up`. */
export type NativeRestartStopProgress =
  | { readonly phase: "stopping" }
  | { readonly phase: "stopped"; readonly summary: string };

const STOPPED =
  "Native project stopped; owned cleanup confirmed. Named volumes and the stopped run mapping are kept for the next hack up.";
const CANCELED_BEFORE_CLEANUP =
  "Native restart canceled before cleanup; nothing was stopped.";
const INTERRUPTED_STOP =
  "Native restart was interrupted before it could confirm the old run's stop; data is retained and the restart is still pending. Run hack restart to finish it; hack up refuses until then.";
const CANCELED_PENDING =
  "Native restart canceled before cleanup; nothing more was stopped. The interrupted restart is still pending: run hack restart to finish it with the retained data.";

const DEFAULTS = {
  signals: nativeRestartStopSignals,
  load: loadNativeProjectRun,
  pending: loadNativeRestartIntent,
  save: saveNativeRestartIntent,
  cleaned: completeNativeRestartCleanup,
  remove: removeNativeRestartIntent,
  lock: withNativeRestartLock,
  capture: captureNativeProjectFinalization,
  recover: recoverNativeProjectFinalization,
  wait: waitNativeProjectFinalization,
};

/** Replace an unchanged graph only after both backend and frontend owners finish cleanup. */
export async function restartNativeProject(opts: {
  readonly scope: NativeProjectRunScope;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly preflight: (
    run: NativeProjectRun,
    options: {
      readonly cleanedRetry: boolean;
      /**
       * A saved `prepared` intent is being resumed: its stop of the old run
       * was interrupted (HACK-1953), so the old run may still be active, or
       * already stopped by its own owner. Preflight must accept either and
       * confirm a stopped graph from fresh observations.
       */
      readonly preparedRetry: boolean;
    }
  ) => Promise<void>;
  readonly down: () => Promise<unknown>;
  readonly start: (options: {
    run: NativeProjectRun;
    onReady: () => Promise<void>;
    /** Aborted by a stop request that arrived before the start took over. */
    signal: AbortSignal;
    /**
     * Called once the start's own stop handling is installed; later stop
     * requests belong to it, so the restart's handlers are removed.
     */
    onStopSignals: () => void;
    /**
     * The start reports that its own stop handling received a stop request. A
     * start that then returns stopped its new run with confirmed cleanup.
     */
    onStopRequested: () => void;
  }) => Promise<number>;
  /**
   * Stop lines for a restart canceled before its new run started; a cancel
   * after that is reported by the start itself.
   */
  readonly progress?: (event: NativeRestartStopProgress) => void;
  readonly recovery?: {
    readonly expectAttempt: string;
    readonly legacyPid?: number;
    readonly verifyEffects: (input: {
      readonly run: NativeProjectRun;
      readonly token: NativeProjectFinalizationToken;
    }) => Promise<void>;
    readonly retirePublisher: (run: NativeProjectRun) => Promise<void>;
  };
  readonly dependencies?: Partial<typeof DEFAULTS>;
}): Promise<number> {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  const stop = deps.signals();
  try {
    return await restartUnderLock({ ...opts, deps, stop });
  } finally {
    stop.dispose();
  }
}

type RestartOptions = Parameters<typeof restartNativeProject>[0];
type RestartContext = RestartOptions & {
  readonly deps: typeof DEFAULTS;
  readonly stop: NativeRestartStopSignals;
  /** Prints the "stopping" line once, as soon as the old run's cleanup is committed. */
  readonly reportStopping: () => void;
  /** Set once the new start owns stop requests; the restart then ignores them. */
  readonly handOff: () => void;
};

/**
 * The first stop request cancels the restart at the next safe point: before
 * cleanup nothing is stopped; once cleanup has begun it runs to completion and
 * the new run is not started; after the start takes over, the start stops its
 * own run as an interrupted `up` does. Every path ends with the graph stopped
 * and data retained, and exits 130 (143 for SIGTERM). If the stop itself was
 * lost to the interrupt, its `prepared` intent stays and the next restart
 * resumes it from whatever state the old owner reached (HACK-1953).
 */
async function restartUnderLock(
  opts: RestartOptions & {
    readonly deps: typeof DEFAULTS;
    readonly stop: NativeRestartStopSignals;
  }
): Promise<number> {
  let stopping = false;
  let cleanupStarted = false;
  let handedOff = false;
  const reportStopping = () => {
    if (!stopping) {
      stopping = true;
      opts.progress?.({ phase: "stopping" });
    }
  };
  opts.stop.signal.addEventListener(
    "abort",
    () => {
      if (cleanupStarted && !handedOff) {
        reportStopping();
      }
    },
    { once: true }
  );
  const context: RestartContext = {
    ...opts,
    reportStopping,
    handOff: () => {
      handedOff = true;
      opts.stop.dispose();
    },
  };
  return await opts.deps.lock(opts.scope, async (release) => {
    const { run, intent, current } = await selectRestart(context);
    const canceledBeforeCleanup = (exit = opts.stop.interruptedExit()) => {
      opts.progress?.({
        phase: "stopped",
        summary: intent ? CANCELED_PENDING : CANCELED_BEFORE_CLEANUP,
      });
      return exit;
    };
    try {
      await opts.preflight(run, {
        cleanedRetry: intent?.phase === "cleaned",
        preparedRetry: intent?.phase === "prepared",
      });
    } catch (error) {
      // Preflight stops nothing; a request it lost to this interrupt (for
      // example a runtime child that shared the terminal's process group)
      // ends the restart as canceled, not as a failure.
      const interruptedExit = restartInterruptedExit(error, opts.stop);
      if (interruptedExit !== undefined && intent?.phase !== "cleaned") {
        return canceledBeforeCleanup(interruptedExit);
      }
      throw error;
    }
    if (opts.stop.signal.aborted && intent?.phase !== "cleaned") {
      return canceledBeforeCleanup();
    }
    cleanupStarted = true;
    if (opts.stop.signal.aborted) {
      reportStopping();
    }
    const selected = await cleanOldRun({ context, run, intent, current });
    return await startOrStop({ context, run, selected, release });
  });
}

async function selectRestart(context: RestartContext): Promise<{
  readonly run: NativeProjectRun;
  readonly intent: NativeRestartIntent | null | undefined;
  readonly current: NativeProjectRun | null | undefined;
}> {
  const { deps } = context;
  const intent = await deps.pending(context.scope);
  const current = await deps.load(context.scope);
  const run = intent?.run ?? current;
  if (!run) {
    throw new ClosedCliError(
      "Native restart has no existing run; use hack up for initial startup."
    );
  }
  if (
    current &&
    (current.run !== run.run ||
      current.planId !== run.planId ||
      current.owner !== run.owner ||
      current.namespace !== run.namespace)
  ) {
    throw new ClosedCliError(
      "Native restart mapping changed; no cleanup requested."
    );
  }
  nativeRestartSelection({
    run,
    envName: context.envName,
    profiles: context.profiles,
  });
  if (!current && intent && intent.phase !== "cleaned") {
    throw interruptedCleanup();
  }
  return { run, intent, current };
}

function interruptedCleanup(): Error {
  return new ClosedCliError(
    "Native restart cleanup or down hooks were interrupted; inspect the pending intent before recovery."
  );
}

/** Stop the old run (or resume a cleaned intent) and wait for its frontend's finalizers. */
async function cleanOldRun(opts: {
  readonly context: RestartContext;
  readonly run: NativeProjectRun;
  readonly intent: NativeRestartIntent | null | undefined;
  readonly current: NativeProjectRun | null | undefined;
}): Promise<NativeRestartIntent> {
  const { context, run, current } = opts;
  const { deps } = context;
  let intent = opts.intent;
  if (!intent) {
    intent = {
      phase: "prepared",
      run,
      finalization: await deps.capture({ scope: context.scope, run }),
    };
    await deps.save({ ...context.scope, intent });
  }
  if (current) {
    try {
      await context.down();
    } catch (error) {
      // The stop's outcome is uncertain, so the prepared intent stays. It is
      // the exact selection the next `hack restart` resumes (whether the old
      // owner is still running or has stopped itself), never a fresh start.
      if (restartInterruptedExit(error, context.stop) !== undefined) {
        context.reportStopping();
        throw new ClosedCliError(INTERRUPTED_STOP);
      }
      throw error;
    }
    intent = await deps.cleaned({ ...context.scope, expected: intent });
  } else if (intent.phase !== "cleaned") {
    throw interruptedCleanup();
  }
  const selected = intent;
  const recovery = context.recovery;
  if (recovery) {
    await deps.recover({
      scope: context.scope,
      run,
      token: selected.finalization,
      expectAttempt: recovery.expectAttempt,
      legacyPid: recovery.legacyPid,
      verifyEffects: async () =>
        await recovery.verifyEffects({
          run,
          token: selected.finalization,
        }),
    });
    await recovery.retirePublisher(run);
  }
  await deps.wait({
    scope: context.scope,
    run,
    token: selected.finalization,
    timeoutMs: 150_000,
  });
  return selected;
}

/** The frontend's first observed stop wins; a child can report its signal before that handler runs. */
function restartInterruptedExit(
  error: unknown,
  stop: NativeRestartStopSignals
): number | undefined {
  if (stop.signal.aborted) {
    return stop.interruptedExit();
  }
  if (error instanceof NativeRuntimeRequestError && error.stopSignal) {
    return error.stopSignal === "SIGTERM" ? 143 : 130;
  }
  return undefined;
}

/** Start the new run, or end as a stopped project when a stop request came first. */
async function startOrStop(opts: {
  readonly context: RestartContext;
  readonly run: NativeProjectRun;
  readonly selected: NativeRestartIntent;
  readonly release: () => Promise<void>;
}): Promise<number> {
  const { context, run, selected } = opts;
  const { deps, stop } = context;
  // The old run is stopped and finalized; a canceled restart ends here as an
  // ordinary stopped project, so the next `hack up` resumes its retained data.
  const canceled = async () => {
    await deps.remove({ ...context.scope, expected: selected });
    context.reportStopping();
    context.progress?.({ phase: "stopped", summary: STOPPED });
    return stop.interruptedExit();
  };
  if (stop.signal.aborted) {
    return await canceled();
  }
  let handedOff = false;
  let stopRequested = false;
  let removed = false;
  try {
    const code = await context.start({
      run,
      signal: stop.signal,
      onStopSignals: () => {
        handedOff = true;
        context.handOff();
      },
      onStopRequested: () => {
        stopRequested = true;
      },
      onReady: async () => {
        await deps.remove({ ...context.scope, expected: selected });
        removed = true;
        await opts.release();
      },
    });
    // Stopped by request before it became ready: the new start confirmed its own
    // cleanup, so the project is simply stopped and `hack up` resumes it.
    if (stopRequested && !removed) {
      await deps.remove({ ...context.scope, expected: selected });
    }
    return code;
  } catch (error) {
    // Before the hand-off the start has run no hook and launched no service of
    // the new run, so a refusal caused by this cancel leaves the old run stopped.
    if (stop.signal.aborted && !handedOff) {
      return await canceled();
    }
    // After the hand-off, a stop request the start confirmed it honored before
    // requesting any service (its cleanup completed): the old run stays stopped and
    // nothing new was admitted. Any other failure keeps the pending restart.
    if (
      handedOff &&
      error instanceof NativeStartupCanceledError &&
      error.beforeServices
    ) {
      await deps.remove({ ...context.scope, expected: selected });
      context.reportStopping();
      context.progress?.({ phase: "stopped", summary: STOPPED });
      return error.interruptedExit;
    }
    throw error;
  }
}
