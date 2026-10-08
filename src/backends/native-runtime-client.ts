import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeStopFailure,
  nativeStopFailureSummary,
  readNativeStopFailures,
} from "./native-stop-diagnostics.ts";

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const NATIVE_RUN = /^[a-f0-9]{32}$/;
interface NativeFailure {
  readonly code: string;
  readonly causeCode?: string;
  readonly stopFailures?: readonly NativeStopFailure[];
}

/** Structured native codes remain safe to inspect without exposing subprocess diagnostics. */
export class NativeRuntimeRequestError extends Error {
  readonly nativeCode: string | undefined;
  readonly nativeCauseCode: string | undefined;
  readonly nativeStopFailures: readonly NativeStopFailure[] | undefined;

  constructor(opts: {
    readonly message: string;
    readonly nativeCode?: string;
    readonly nativeCauseCode?: string;
    readonly nativeStopFailures?: readonly NativeStopFailure[];
  }) {
    super(opts.message);
    this.nativeCode = opts.nativeCode;
    this.nativeCauseCode = opts.nativeCauseCode;
    this.nativeStopFailures = opts.nativeStopFailures;
  }
}

export interface NativeRuntimeSelection {
  readonly binary: string;
  readonly home: string;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_INPUT_BYTES = 256 * 1024;
const SYSTEM_ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"];

/** Explicit candidate selection never redirects installed v4 or starts Docker. */
export function resolveNativeRuntimeSelection(
  env: Readonly<Record<string, string | undefined>> = process.env
): NativeRuntimeSelection | null {
  if (env.HACK_RUNTIME_BACKEND !== "native") {
    return null;
  }
  const binary = env.HACK_NATIVE_BINARY;
  const home = env.HACK_NATIVE_HOME;
  if (!(binary && home && isAbsolute(binary) && isAbsolute(home))) {
    throw new Error(
      "Native runtime requires absolute HACK_NATIVE_BINARY and HACK_NATIVE_HOME paths."
    );
  }
  return { binary, home };
}

/**
 * Bounded one-shot control requests. Private input travels only over stdin;
 * subprocess diagnostics are omitted because they can contain application data.
 * A failed or timed-out mutation has an uncertain outcome and is never replayed.
 */
export async function invokeNativeRuntime(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly privateInput?: Uint8Array;
  /** Graph exec and run-service return command exit status alongside JSON. */
  readonly serviceExecResponse?: boolean;
  /** Native authored status must finish when its owned child exits or admission is canceled. */
  readonly boundNativeStatusDrain?: boolean;
  /** Native source planning and journal inspection also bind pipe lifetime to their owned read child. */
  readonly boundNativeAuthoredReadDrain?: boolean;
}): Promise<unknown> {
  if (opts.signal?.aborted) {
    throw new NativeRuntimeRequestError({
      message:
        "Native runtime request was canceled before admission; no request was started.",
    });
  }
  const timeoutMs = opts.timeoutMs ?? 180_000;
  if (
    !(
      validExecResponseSelection(opts.args, opts.serviceExecResponse) &&
      validNativeStatusDrainSelection(opts.args, opts.boundNativeStatusDrain) &&
      validNativeAuthoredReadDrainSelection(
        opts.args,
        opts.boundNativeAuthoredReadDrain,
        opts.privateInput !== undefined
      ) &&
      Number.isSafeInteger(timeoutMs)
    ) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000 ||
    (opts.privateInput?.byteLength ?? 0) > MAX_PRIVATE_INPUT_BYTES
  ) {
    throw new Error("Native runtime request exceeds its input or time budget.");
  }
  const env: Record<string, string> = {};
  for (const key of SYSTEM_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const child = Bun.spawn(
    [opts.runtime.binary, "--candidate-root", opts.runtime.home, ...opts.args],
    {
      cwd: opts.cwd,
      env,
      stdin: opts.privateInput ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const drain =
    opts.boundNativeStatusDrain || opts.boundNativeAuthoredReadDrain
      ? new AbortController()
      : undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  if (drain) {
    void child.exited.then(() => {
      drainTimer = setTimeout(() => drain.abort(), 250);
    });
  }
  const failureDetails = readNativeFailure(child.stderr, drain?.signal);
  let timedOut = false;
  let canceled = false;
  const cancel = () => {
    canceled = true;
    drain?.abort();
    child.kill("SIGKILL");
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) {
    cancel();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    drain?.abort();
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const inputFailure = await writeNativePrivateInput(
      child.stdin,
      opts.privateInput
    );
    const bytes = await readBoundedOutput(child.stdout, drain?.signal);
    const code = await child.exited;
    const failure = await failureDetails;
    if (canceled) {
      throw new NativeRuntimeRequestError({
        message:
          "Native runtime request was canceled; its outcome may be uncertain. No request was replayed.",
      });
    }
    rethrowNativeInputFailure(inputFailure, {
      interrupted: timedOut,
      code,
      nativeCode: failure?.code,
    });
    return completionResponse(
      bytes,
      code,
      timedOut,
      failure,
      opts.serviceExecResponse
    );
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    clearTimeout(drainTimer);
    drain?.abort();
  }
}

function validNativeStatusDrainSelection(
  args: readonly string[],
  selected?: boolean
): boolean {
  return (
    !selected ||
    (args.length === 8 &&
      args[0] === "graph" &&
      args[1] === "native" &&
      args[2] === "control" &&
      args[3] === "--run-id" &&
      NATIVE_RUN.test(args[4] ?? "") &&
      args[5] === "--action" &&
      args[6] === "status" &&
      args[7] === "--json")
  );
}

function validNativeAuthoredReadDrainSelection(
  args: readonly string[],
  selected: boolean | undefined,
  privateInput: boolean
): boolean {
  return (
    !selected ||
    (!privateInput &&
      args.length === 6 &&
      args[0] === "graph" &&
      args[1] === "native" &&
      args[5] === "--json" &&
      ((args[2] === "plan" &&
        args[3] === "--source-file" &&
        isAbsolute(args[4] ?? "")) ||
        (args[2] === "inspect" &&
          args[3] === "--run-id" &&
          NATIVE_RUN.test(args[4] ?? ""))))
  );
}

function nativeFailureMessage(failure: NativeFailure | undefined): string {
  const code = failure
    ? ` (${failure.code}${failure.causeCode ? `: ${failure.causeCode}` : ""})`
    : "";
  return `Native runtime request failed${code}; inspect owned state before retrying.${nativeStopFailureSummary(failure?.stopFailures)}`;
}

function completionResponse(
  bytes: Uint8Array,
  code: number,
  timedOut: boolean,
  failure: NativeFailure | undefined,
  serviceExecResponse?: boolean
): unknown {
  if (serviceExecResponse && !timedOut && !failure) {
    return parseExecCompletion(bytes, code);
  }
  if (timedOut || code !== 0 || (serviceExecResponse && failure)) {
    throw new NativeRuntimeRequestError({
      message: timedOut
        ? "Native runtime request timed out; inspect owned state before retrying."
        : nativeFailureMessage(failure),
      nativeCode: timedOut ? undefined : failure?.code,
      nativeCauseCode: timedOut ? undefined : failure?.causeCode,
      nativeStopFailures: timedOut ? undefined : failure?.stopFailures,
    });
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Native runtime returned an invalid control response.");
  }
}

function validExecResponseSelection(
  args: readonly string[],
  selected?: boolean
): boolean {
  if (!selected) {
    return true;
  }
  const separator = args.indexOf("--");
  return (
    args[0] === "graph" &&
    ["exec", "run-service"].includes(args[1] ?? "") &&
    separator > 2 &&
    args.slice(2, separator).includes("--json")
  );
}

function parseExecCompletion(bytes: Uint8Array, code: number): unknown {
  let execResult: unknown;
  try {
    execResult = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* Refuse below without echoing output. */
  }
  if (
    isRecord(execResult) &&
    Number.isInteger(execResult.exit_code) &&
    execResult.exit_code === code &&
    code >= 0 &&
    code <= 255 &&
    typeof execResult.stdout_base64 === "string" &&
    typeof execResult.stderr_base64 === "string" &&
    typeof execResult.truncated === "boolean"
  ) {
    return execResult;
  }
  throw new Error(
    "Native exec returned an invalid or inconsistent completion response; command effects may have occurred."
  );
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      total += chunk.byteLength;
      if (total > MAX_OUTPUT_BYTES) {
        throw new Error(
          "Native runtime control response exceeds its output budget."
        );
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Only bounded native error codes leave this boundary, never stderr messages. */
async function readNativeFailure(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<NativeFailure | undefined> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes <= 8192) {
        text += decoder.decode(result.value, { stream: true });
      }
    }
    if (bytes > 8192) {
      return;
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (
      isRecord(value) &&
      typeof value.code === "string" &&
      ERROR_CODE.test(value.code)
    ) {
      return {
        code: value.code,
        ...(["graph_one_off_failed", "graph_owner_recovery"].includes(
          value.code
        ) &&
        typeof value.cause_code === "string" &&
        ERROR_CODE.test(value.cause_code)
          ? { causeCode: value.cause_code }
          : {}),
        ...(["engine_protocol", "engine_rejected", "engine_not_found"].includes(
          value.code === "graph_owner_recovery" &&
            typeof value.cause_code === "string"
            ? value.cause_code
            : value.code
        )
          ? { stopFailures: readNativeStopFailures(value.stop_failures) }
          : {}),
      };
    }
  } catch {
    return;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function readNativeFailureCode(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<string | undefined> {
  return (await readNativeFailure(stream, signal))?.code;
}

/** Capture delivery failure while the caller drains and reaps the receiver, never replaying input. */
export async function writeNativePrivateInput(
  sink: Pick<Bun.FileSink, "write" | "end"> | number | null | undefined,
  input: Uint8Array | undefined
): Promise<{ error: unknown } | undefined> {
  if (!(input && sink) || typeof sink === "number") {
    return;
  }
  try {
    sink.write(input);
    await sink.end();
  } catch (error) {
    return { error };
  }
}

/** Only a confirmed receiver rejection or interruption supersedes a delivery error. */
export function rethrowNativeInputFailure(
  failure: { error: unknown } | undefined,
  result: { interrupted: boolean; code: number; nativeCode: string | undefined }
): void {
  if (
    failure &&
    !result.interrupted &&
    !(result.code !== 0 && result.nativeCode)
  ) {
    throw failure.error;
  }
}
