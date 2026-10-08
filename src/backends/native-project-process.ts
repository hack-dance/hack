import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeAuthoredReceipt,
  type NativeAuthoredReview,
  parseNativeAuthoredControl,
  parseNativeAuthoredReady,
  parseNativeAuthoredReview,
} from "./native-authored-graph-protocol.ts";
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
    readonly review: NativeAuthoredReview;
    readonly onReady: (
      receipt: NativeAuthoredReceipt,
      assertRunning: () => void
    ) => Promise<void>;
  }
): Promise<number> {
  const expected = parseNativeAuthoredReview(opts.review);
  if (
    !isAbsolute(opts.sourceFile) ||
    expected.provenance.run !== opts.run ||
    opts.startupTimeoutMs > 300_000
  ) {
    throw new Error(
      "Native authored source selection is invalid; values omitted."
    );
  }
  return await serveGraphProcess({
    ...opts,
    command: [
      "graph",
      "native",
      "serve",
      "--source-file",
      opts.sourceFile,
      "--expect-review",
      expected.review_id,
      "--timeout-seconds",
      String(Math.ceil(opts.startupTimeoutMs / 1000)),
      ...(opts.privateInput ? ["--environment-stdin"] : []),
      "--json",
    ],
    readyLimit: 64 * 1024,
    strictReady: true,
    onReady: async (value, interrupted, ownerSignal) => {
      const receipt = parseNativeAuthoredReady(value, expected);
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
      });
      const current = parseNativeAuthoredControl(status, receipt, "status");
      const assertRunning = () => {
        if (interrupted() || current.receipt.phase !== "ready-observed") {
          throw new Error(
            "Native graph readiness identity is invalid or canceled."
          );
        }
      };
      assertRunning();
      await opts.onReady(current.receipt, assertRunning);
    },
  });
}

async function serveGraphProcess(
  opts: ProcessOptions & {
    readonly command: readonly string[];
    readonly readyLimit: number;
    readonly strictReady: boolean;
    readonly onReady: (
      value: unknown,
      interrupted: () => boolean,
      ownerSignal: AbortSignal
    ) => Promise<void>;
  }
): Promise<number> {
  if (
    !(RUN.test(opts.run) && Number.isSafeInteger(opts.startupTimeoutMs)) ||
    opts.startupTimeoutMs < 1 ||
    opts.startupTimeoutMs > 600_000 ||
    (opts.privateInput?.byteLength ?? 0) > MAX_INPUT ||
    opts.signal?.aborted
  ) {
    throw new Error("Native graph startup input is invalid or canceled.");
  }
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
  const abort = () => {
    canceled = true;
    owner.abort();
    terminate();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) {
    abort();
  }
  const startupTimer = setTimeout(() => {
    timedOut = true;
    owner.abort();
    terminate();
  }, opts.startupTimeoutMs);
  try {
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
        await opts.onReady(value, interrupted, owner.signal);
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
  }
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
