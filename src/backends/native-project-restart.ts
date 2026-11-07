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
    options: { readonly cleanedRetry: boolean }
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
 * and data retained, and exits 130 (143 for SIGTERM).
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
    await opts.preflight(run, {
      cleanedRetry: intent?.phase === "cleaned",
    });
    if (opts.stop.signal.aborted && intent?.phase !== "cleaned") {
      opts.progress?.({ phase: "stopped", summary: CANCELED_BEFORE_CLEANUP });
      return opts.stop.interruptedExit();
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
    await context.down();
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
    throw error;
  }
}
