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
  removeNativeRestartIntent,
  saveNativeRestartIntent,
  withNativeRestartLock,
} from "./native-project-run.ts";

const DEFAULTS = {
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
  readonly preflight: (run: NativeProjectRun) => Promise<void>;
  readonly down: () => Promise<unknown>;
  readonly start: (options: {
    run: NativeProjectRun;
    onReady: () => Promise<void>;
  }) => Promise<number>;
  readonly recovery?: {
    readonly expectAttempt: string;
    readonly legacyPid?: number;
    readonly verifyEffects: (input: {
      readonly run: NativeProjectRun;
      readonly token: NativeProjectFinalizationToken;
    }) => Promise<void>;
  };
  readonly dependencies?: Partial<typeof DEFAULTS>;
}): Promise<number> {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  return await deps.lock(opts.scope, async (release) => {
    let intent = await deps.pending(opts.scope);
    const current = await deps.load(opts.scope);
    const run = intent?.run ?? current;
    if (!run) {
      throw new Error(
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
      throw new Error("Native restart mapping changed; no cleanup requested.");
    }
    nativeRestartSelection({
      run,
      envName: opts.envName,
      profiles: opts.profiles,
    });
    await opts.preflight(run);
    if (!intent) {
      intent = {
        phase: "prepared",
        run,
        finalization: await deps.capture({ scope: opts.scope, run }),
      };
      await deps.save({ ...opts.scope, intent });
    }
    if (current) {
      await opts.down();
      intent = await deps.cleaned({ ...opts.scope, expected: intent });
    } else if (intent.phase !== "cleaned") {
      throw new Error(
        "Native restart cleanup or down hooks were interrupted; inspect the pending intent before recovery."
      );
    }
    const selected = intent;
    const recovery = opts.recovery;
    if (recovery) {
      await deps.recover({
        scope: opts.scope,
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
    }
    await deps.wait({
      scope: opts.scope,
      run,
      token: selected.finalization,
      timeoutMs: 150_000,
    });
    return await opts.start({
      run,
      onReady: async () => {
        await deps.remove({ ...opts.scope, expected: selected });
        await release();
      },
    });
  });
}
