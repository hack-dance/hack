import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  parseNativeAuthoredControl,
  parseNativeAuthoredReady,
  parseNativeAuthoredReceipt,
  parseNativeAuthoredReview,
} from "./native-authored-graph-protocol.ts";
import type { NativeAuthoredStorageTool } from "./native-authored-storage-tool.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
  readNativeFailureCode,
  rethrowNativeInputFailure,
  writeNativePrivateInput,
} from "./native-runtime-client.ts";

const RUN = /^[a-f0-9]{32}$/;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_INPUT = 256 * 1024;

export type NativeExitDiagnostic = {
  readonly exitCode: number;
  readonly nativeCode?: string;
};

type ProcessOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly privateInput?: Uint8Array;
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onExitDiagnostic?: (diagnostic: NativeExitDiagnostic) => void;
  /** Finite frontend hooks intercept the first stop; failed hooks retain the live owner. */
  readonly beforeStop?: () => Promise<boolean>;
  readonly forceSignal?: AbortSignal;
  readonly onStopFailure?: () => void;
  /** Durable capture in the existing frontend owner, before private input delivery. */
  readonly onGroup?: (group: number) => Promise<void>;
};

/**
 * Keep the graph owner attached to the calling CLI until owned shutdown completes.
 * Startup values travel over stdin only. Readiness is a handshake, not application
 * acceptance; the caller must inspect ownership before publishing a run mapping.
 * Aborted/failed attempts retain native recovery state and are never replayed.
 */
export async function serveNativeProjectGraph(
  opts: ProcessOptions & {
    readonly args: readonly string[];
    readonly restore?: boolean;
    readonly onReady: () => Promise<void>;
  }
): Promise<number> {
  return await serveGraphProcess({
    ...opts,
    command: [
      "graph",
      opts.restore ? "serve-restore" : "serve",
      ...opts.args,
      "--run-id",
      opts.run,
      "--json",
    ],
    readyLimit: 8192,
    strictReady: false,
    onReady: async (value) => {
      if (
        !isRecord(value) ||
        value.kind !== "graph_foreground_ready" ||
        value.run !== opts.run
      ) {
        throw new Error(
          "Native graph readiness identity is invalid or canceled."
        );
      }
      await opts.onReady();
    },
  });
}

/**
 * Native authored source has its own ready/control codec. Authenticate the owner
 * and admitted receipt before the caller can publish a mapping. The callback
 * must recheck its input and `assertRunning` immediately before publication.
 * Completion remains subject to exact native journal inspection by the caller.
 */
export async function serveNativeAuthoredProjectGraph(
  opts: ProcessOptions & {
    readonly sourceFile: string;
    readonly frontendHooks?: boolean;
    readonly storageTool?: NativeAuthoredStorageTool;
    readonly review: NativeAuthoredReview;
    /** Synchronous first-receipt observation before status; grants no publication authority. */
    readonly onReceipt?: (receipt: NativeAuthoredReceipt) => undefined;
    readonly onReady: (
      receipt: NativeAuthoredReceipt,
      assertRunning: () => void,
      refreshRunning: () => Promise<void>,
      publishReady: () => void
    ) => Promise<void>;
  }
): Promise<number> {
  const expected = parseNativeAuthoredReview(opts.review);
  const onReceipt = opts.onReceipt;
  const tool = opts.storageTool;
  const toolArgs = tool
    ? [
        "--storage-witness-tool",
        tool.path,
        "--expect-storage-witness-tool",
        tool.digest,
      ]
    : [];
  if (
    !isAbsolute(opts.sourceFile) ||
    expected.provenance.run !== opts.run ||
    opts.startupTimeoutMs > 300_000
  ) {
    throw new Error(
      "Native authored source selection is invalid; values omitted."
    );
  }
  // Capture the pair before awaiting freshness. Rust independently opens and
  // admits these exact bytes before provider state or a storage effect.
  if (tool) {
    await tool.assertFresh();
  }
  return await serveGraphProcess({
    ...opts,
    command: [
      "graph",
      "native",
      opts.frontendHooks ? "frontend-serve" : "serve",
      "--source-file",
      opts.sourceFile,
      "--expect-review",
      expected.review_id,
      "--timeout-seconds",
      String(Math.ceil(opts.startupTimeoutMs / 1000)),
      ...(opts.privateInput ? ["--environment-stdin"] : []),
      ...toolArgs,
      "--json",
    ],
    readyLimit: 64 * 1024,
    strictReady: true,
    onReady: async (value, interrupted, ownerSignal, publishReady) => {
      const receipt = parseNativeAuthoredReady(value, expected);
      // Give the caller an independent copy so it cannot alter status admission.
      // Retain this membership for cleanup even when current readiness later fails.
      const observed: unknown = onReceipt?.(
        parseNativeAuthoredReceipt(receipt)
      );
      if (observed !== undefined) {
        void Promise.resolve(observed).catch(() => undefined);
        throw new Error(
          "Native receipt observation must be synchronous; values omitted."
        );
      }
      const status = await invokeNativeRuntime({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          "graph",
          "native",
          "control",
          "--run-id",
          opts.run,
          "--action",
          "status",
          "--json",
        ],
        timeoutMs: 45_000,
        signal: ownerSignal,
        boundNativeStatusDrain: true,
      });
      const current = parseNativeAuthoredControl(status, receipt, "status");
      const assertRunning = () => {
        if (interrupted() || !nativeSnapshotReady(current)) {
          throw new Error(
            "Native graph readiness identity is invalid or canceled."
          );
        }
      };
      assertRunning();
      await opts.onReady(
        current.receipt,
        assertRunning,
        async () => {
          const fresh = parseNativeAuthoredControl(
            await invokeNativeRuntime({
              runtime: opts.runtime,
              cwd: opts.projectRoot,
              args: [
                "graph",
                "native",
                "control",
                "--run-id",
                opts.run,
                "--action",
                "status",
                "--json",
              ],
              timeoutMs: 45_000,
              signal: ownerSignal,
              boundNativeStatusDrain: true,
            }),
            receipt,
            "status"
          );
          if (interrupted() || !nativeSnapshotReady(fresh)) {
            throw new Error(
              "Native graph readiness identity changed; values omitted."
            );
          }
        },
        publishReady
      );
    },
  });
}

/** Match the admitted Rust readiness conditions without starting a monitoring loop. */
function nativeSnapshotReady(
  current: ReturnType<typeof parseNativeAuthoredControl>
): boolean {
  return (
    current.receipt.phase === "ready-observed" &&
    current.receipt.failure === undefined &&
    Object.entries(current.receipt.readiness).every(([name, condition]) => {
      const observation = current.observations?.[name];
      if (
        !observation ||
        observation.state === "dead" ||
        (observation.state === "running" && observation.health === "unhealthy")
      ) {
        return false;
      }
      if (condition === "healthy") {
        return (
          observation.state === "running" && observation.health === "healthy"
        );
      }
      const completed =
        observation.state === "exited" && observation.code === 0;
      return condition === "completed"
        ? completed
        : observation.state === "running" || completed;
    })
  );
}

function assertProcessSelection(opts: ProcessOptions): void {
  if (
    !(RUN.test(opts.run) && Number.isSafeInteger(opts.startupTimeoutMs)) ||
    opts.startupTimeoutMs < 1 ||
    opts.startupTimeoutMs > 600_000 ||
    (opts.privateInput?.byteLength ?? 0) > MAX_INPUT ||
    canceledAtEntry(opts)
  ) {
    throw new Error("Native graph startup input is invalid or canceled.");
  }
}

function canceledAtEntry(opts: ProcessOptions): boolean {
  return opts.signal?.aborted === true || opts.forceSignal?.aborted === true;
}

async function serveGraphProcess(
  opts: ProcessOptions & {
    readonly command: readonly string[];
    readonly readyLimit: number;
    readonly strictReady: boolean;
    readonly onReady: (
      value: unknown,
      interrupted: () => boolean,
      ownerSignal: AbortSignal,
      publishReady: () => void
    ) => Promise<void>;
  }
): Promise<number> {
  assertProcessSelection(opts);
  const environment: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  const child = Bun.spawn(
    [
      opts.runtime.binary,
      "--candidate-root",
      opts.runtime.home,
      ...opts.command,
    ],
    {
      cwd: opts.projectRoot,
      env: environment,
      stdin: opts.privateInput ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: opts.beforeStop !== undefined,
    }
  );
  // Descendants may inherit a pipe after the owned receiver exits. Its exit,
  // not unrelated writers' EOF, bounds draining; final graph inspection remains
  // the caller's authority for cleanup, regardless of a successful exit code.
  const drain = new AbortController();
  const owner = new AbortController();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  void child.exited.then(() => {
    owner.abort();
    drainTimer = setTimeout(() => drain.abort(), 250);
  });
  const failureCode = readNativeFailureCode(child.stderr, drain.signal);
  let ready = false;
  let canceled = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    // Native cleanup permits a 120-second control request, including graceful stops.
    // Keep the owner alive through that budget before last-resort termination.
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 130_000);
  };
  const stopFailure = () => {
    try {
      void Promise.resolve(opts.onStopFailure?.()).catch(() => undefined);
    } catch {
      /* observation only */
    }
  };
  let stopping: Promise<void> | undefined;
  const force = () => {
    canceled = true;
    owner.abort();
    terminate();
  };
  const abort = () => {
    if (!(ready && opts.beforeStop)) {
      force();
      return;
    }
    if (stopping) {
      return;
    }
    stopping = (async () => {
      try {
        if (await opts.beforeStop?.()) {
          terminate();
        } else {
          stopFailure();
        }
      } catch {
        stopFailure();
      }
    })();
  };
  opts.forceSignal?.addEventListener("abort", force, { once: true });
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) {
    abort();
  }
  if (opts.forceSignal?.aborted) {
    force();
  }
  const startupTimer = setTimeout(() => {
    timedOut = true;
    owner.abort();
    terminate();
  }, opts.startupTimeoutMs);
  try {
    await opts.onGroup?.(child.pid);
    const inputFailure = await writeNativePrivateInput(
      child.stdin,
      opts.privateInput
    );
    ready = await consumeGraphOutput({
      output: child.stdout,
      signal: drain.signal,
      readyLimit: opts.readyLimit,
      strictReady: opts.strictReady,
      interrupted: () =>
        canceled ||
        timedOut ||
        inputFailure !== undefined ||
        (opts.strictReady && child.exitCode !== null),
      onReady: async (value, interrupted) => {
        await opts.onReady(value, interrupted, owner.signal, () => {
          if (interrupted()) {
            throw new Error(
              "Native graph publication interrupted; values omitted."
            );
          }
          ready = true;
          clearTimeout(startupTimer);
        });
        ready = true;
        clearTimeout(startupTimer);
      },
    });
    const code = await child.exited;
    const failure = await failureCode;
    rethrowNativeInputFailure(inputFailure, {
      interrupted: timedOut || canceled,
      code,
      nativeCode: failure,
    });
    if (timedOut || canceled || !ready) {
      throw new Error(
        `Native graph startup was interrupted or failed${failure ? ` (${failure})` : ""}; inspect owned state before retrying.`
      );
    }
    return code;
  } finally {
    clearTimeout(startupTimer);
    opts.signal?.removeEventListener("abort", abort);
    opts.forceSignal?.removeEventListener("abort", force);
    await stopping;
    if (child.exitCode === null) {
      terminate();
      await child.exited;
    }
    if (killTimer) {
      clearTimeout(killTimer);
    }
    const exitCode = await child.exited;
    const nativeCode = await failureCode;
    clearTimeout(drainTimer);
    drain.abort();
    try {
      opts.onExitDiagnostic?.({
        exitCode,
        ...(nativeCode ? { nativeCode } : {}),
      });
    } catch {
      // Observation must never replace the startup result or cleanup authority.
    }
    if (opts.beforeStop) {
      await requireGroupAbsent(child.pid);
    }
  }
}

/** An attached finite-hook owner must not retire while its captured detached group is present.
 * Unknown permission or lifetime is a refusal, never a signal to a later/reused group.
 */
async function requireGroupAbsent(group: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(-group, 0);
    } catch (error) {
      if (isRecord(error) && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    "Native foreground child group settlement is unknown; values omitted."
  );
}

async function consumeGraphOutput(opts: {
  readonly output: ReadableStream<Uint8Array>;
  readonly signal: AbortSignal;
  readonly readyLimit: number;
  readonly strictReady: boolean;
  readonly interrupted: () => boolean;
  readonly onReady: (
    value: unknown,
    interrupted: () => boolean
  ) => Promise<void>;
}): Promise<boolean> {
  let ready = false;
  const reader = opts.output.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  opts.signal.addEventListener("abort", cancel, { once: true });
  if (opts.signal.aborted) {
    cancel();
  }
  let total = 0;
  let line = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > MAX_OUTPUT) {
        throw new Error("Native graph control output exceeded its budget.");
      }
      if (ready) {
        continue;
      }
      line += decoder.decode(chunk.value, { stream: true });
      const end = line.indexOf("\n");
      if (end < 0) {
        if (readyFrameSize(line, opts.strictReady) > opts.readyLimit) {
          throw new Error(
            "Native graph readiness response exceeded its budget."
          );
        }
        continue;
      }
      if (
        opts.strictReady &&
        Buffer.byteLength(line.slice(0, end)) > opts.readyLimit
      ) {
        throw new Error("Native graph readiness response exceeded its budget.");
      }
      await acceptGraphReady({ ...opts, line: line.slice(0, end) });
      ready = true;
      line = "";
    }
  } finally {
    opts.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return ready;
}

function readyFrameSize(line: string, strict: boolean): number {
  return strict ? Buffer.byteLength(line) : line.length;
}

async function acceptGraphReady(opts: {
  readonly line: string;
  readonly strictReady: boolean;
  readonly interrupted: () => boolean;
  readonly onReady: (
    value: unknown,
    interrupted: () => boolean
  ) => Promise<void>;
}): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(opts.line);
  } catch {
    throw new Error("Native graph readiness response is invalid.");
  }
  if (opts.interrupted()) {
    throw new Error("Native graph readiness identity is invalid or canceled.");
  }
  await opts.onReady(value, opts.interrupted);
  if (opts.strictReady && opts.interrupted()) {
    throw new Error("Native graph readiness identity is invalid or canceled.");
  }
}
