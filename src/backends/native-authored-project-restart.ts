import { isAbsolute } from "node:path";
import {
  type NativeAuthoredProjectRunScope,
  stopNativeAuthoredProject,
} from "./native-authored-project-run.ts";
import {
  NativeAuthoredProjectStartError,
  serveNativeAuthoredProject,
} from "./native-authored-project-start.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

const RUN = /^[a-f0-9]{32}$/;
const MAX_STARTUP_TIMEOUT_MS = 300_000;
type ServeOptions = Parameters<typeof serveNativeAuthoredProject>[0];

export type NativeAuthoredProjectRestartPhase = "stop" | "start";

/**
 * Fixed diagnostics only. The stop owner's refusal text and arbitrary startup
 * errors never escape; a startup owner's own closed diagnostic is retained as is.
 */
export class NativeAuthoredProjectRestartError extends Error {
  /** `stop`: nothing was restarted and the selected generation is retained. */
  readonly phase: NativeAuthoredProjectRestartPhase;
  readonly canceled: boolean;
  /** Closed startup diagnostic when the fresh owner refused after the proven stop. */
  readonly startup: NativeAuthoredProjectStartError | undefined;

  constructor(opts: {
    readonly phase: NativeAuthoredProjectRestartPhase;
    readonly canceled: boolean;
    readonly startup?: NativeAuthoredProjectStartError;
  }) {
    const startup =
      opts.phase === "start" &&
      opts.startup instanceof NativeAuthoredProjectStartError
        ? opts.startup
        : undefined;
    let message: string;
    if (opts.phase === "stop") {
      message =
        "Native authored restart could not prove the current generation stopped; nothing was restarted and selected state is retained. Values omitted.";
    } else if (startup) {
      message = startup.message;
    } else if (opts.canceled) {
      message =
        "Native authored restart was canceled after the proven stop; nothing was restarted and persistent data is retained. Values omitted.";
    } else {
      message =
        "Native authored restart startup is unconfirmed after the proven stop; inspect native state before retrying. Values omitted.";
    }
    super(message);
    this.phase = opts.phase;
    this.canceled = opts.canceled;
    this.startup = startup;
  }
}

type Dependencies = {
  readonly stop: typeof stopNativeAuthoredProject;
  readonly serve: typeof serveNativeAuthoredProject;
};

export type NativeAuthoredProjectRestartOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  /** Fresh run tag for the generation started after the proven stop. */
  readonly run: string;
  readonly profiles?: readonly string[];
  readonly overlay?: string | null;
  /** Native HTTPS port for the start half's generated runtime metadata URLs. */
  readonly httpsPort?: ServeOptions["httpsPort"];
  /** Budget of each half; the stop half does not lend time to the start half. */
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly forceSignal?: AbortSignal;
  /** Observation between the proven stop and the fresh start; grants no authority. */
  readonly onStopped?: () => undefined;
  readonly onReady?: ServeOptions["onReady"];
  readonly onExitDiagnostic?: ServeOptions["onExitDiagnostic"];
  readonly onHookDiagnostic?: ServeOptions["onHookDiagnostic"];
  /** Execution seam for sequencing controls; the CLI always uses the real owners. */
  readonly dependencies?: Partial<Dependencies>;
};

function captureOptions(
  input: NativeAuthoredProjectRestartOptions
): NativeAuthoredProjectRestartOptions {
  return {
    ...input,
    runtime: { binary: input.runtime.binary, home: input.runtime.home },
    scope: {
      projectRoot: input.scope.projectRoot,
      projectDir: input.scope.projectDir,
      nativeHome: input.scope.nativeHome,
      branch: input.scope.branch,
    },
    profiles: input.profiles === undefined ? undefined : [...input.profiles],
    dependencies: undefined,
  };
}

function validSelection(opts: NativeAuthoredProjectRestartOptions): boolean {
  return (
    process.platform === "darwin" &&
    isAbsolute(opts.runtime.binary) &&
    opts.runtime.home === opts.scope.nativeHome &&
    RUN.test(opts.run) &&
    Number.isSafeInteger(opts.startupTimeoutMs) &&
    opts.startupTimeoutMs >= 1 &&
    opts.startupTimeoutMs <= MAX_STARTUP_TIMEOUT_MS &&
    opts.signal?.aborted !== true &&
    opts.forceSignal?.aborted !== true
  );
}

/**
 * Whole-project restart as owner-mediated stop followed by a fresh foreground up.
 * The stop half is the same authenticated `down` owner: it resolves only after
 * exact Removed and retirement, so nothing starts on refusal, uncertainty or
 * cancellation. The start half reuses the foreground `up` owner with the given
 * selection, so hooks and host processes run again as on `up`. Persistent data is
 * retained across the cycle; no volume or data identity changes.
 */
export async function restartNativeAuthoredProject(
  input: NativeAuthoredProjectRestartOptions
): Promise<number> {
  const deps: Dependencies = {
    stop: input.dependencies?.stop ?? stopNativeAuthoredProject,
    serve: input.dependencies?.serve ?? serveNativeAuthoredProject,
  };
  const opts = captureOptions(input);
  if (!validSelection(opts)) {
    throw new NativeAuthoredProjectRestartError({
      phase: "stop",
      canceled: opts.signal?.aborted === true,
    });
  }
  try {
    await deps.stop({
      scope: opts.scope,
      timeoutMs: opts.startupTimeoutMs,
      signal: opts.signal,
    });
  } catch {
    throw new NativeAuthoredProjectRestartError({
      phase: "stop",
      canceled: opts.signal?.aborted === true,
    });
  }
  // Only a settled stop proves authenticated Removed; a cancellation here starts nothing.
  if (opts.signal?.aborted || opts.forceSignal?.aborted) {
    throw new NativeAuthoredProjectRestartError({
      phase: "start",
      canceled: true,
    });
  }
  opts.onStopped?.();
  try {
    return await deps.serve({
      runtime: opts.runtime,
      scope: opts.scope,
      run: opts.run,
      profiles: opts.profiles,
      overlay: opts.overlay,
      httpsPort: opts.httpsPort,
      startupTimeoutMs: opts.startupTimeoutMs,
      signal: opts.signal,
      forceSignal: opts.forceSignal,
      onReady: opts.onReady,
      onExitDiagnostic: opts.onExitDiagnostic,
      onHookDiagnostic: opts.onHookDiagnostic,
    });
  } catch (error: unknown) {
    const startup =
      error instanceof NativeAuthoredProjectStartError ? error : undefined;
    throw new NativeAuthoredProjectRestartError({
      phase: "start",
      canceled: startup ? startup.canceled : opts.signal?.aborted === true,
      startup,
    });
  }
}
