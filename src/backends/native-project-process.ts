import { isRecord } from "../lib/guards.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RUN = /^[a-f0-9]{32}$/;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_INPUT = 256 * 1024;

/**
 * Keep the graph owner attached to the calling CLI until owned shutdown completes.
 * Startup values travel over stdin only. Readiness is a handshake, not application
 * acceptance; the caller must inspect ownership before publishing a run mapping.
 * Aborted/failed attempts retain native recovery state and are never replayed.
 */
export async function serveNativeProjectGraph(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly args: readonly string[];
  readonly privateInput?: Uint8Array;
  readonly startupTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onReady: () => Promise<void>;
}): Promise<number> {
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
      "graph",
      "serve",
      ...opts.args,
      "--run-id",
      opts.run,
      "--json",
    ],
    {
      cwd: opts.projectRoot,
      env: environment,
      stdin: opts.privateInput ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const failureCode = nativeFailureCode(child.stderr);
  let ready = false;
  let canceled = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000);
  };
  const abort = () => {
    canceled = true;
    terminate();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) {
    abort();
  }
  const startupTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, opts.startupTimeoutMs);
  try {
    if (opts.privateInput && child.stdin && typeof child.stdin !== "number") {
      child.stdin.write(opts.privateInput);
      await child.stdin.end();
    }
    ready = await consumeGraphOutput({
      output: child.stdout,
      run: opts.run,
      interrupted: () => canceled || timedOut,
      onReady: async () => {
        await opts.onReady();
        clearTimeout(startupTimer);
      },
    });
    const code = await child.exited;
    const failure = await failureCode;
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
  }
}

async function consumeGraphOutput(opts: {
  readonly output: ReadableStream<Uint8Array>;
  readonly run: string;
  readonly interrupted: () => boolean;
  readonly onReady: () => Promise<void>;
}): Promise<boolean> {
  let ready = false;
  const reader = opts.output.getReader();
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
        if (line.length > 8192) {
          throw new Error(
            "Native graph readiness response exceeded its budget."
          );
        }
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.slice(0, end));
      } catch {
        throw new Error("Native graph readiness response is invalid.");
      }
      if (
        !isRecord(value) ||
        value.kind !== "graph_foreground_ready" ||
        value.run !== opts.run ||
        opts.interrupted()
      ) {
        throw new Error(
          "Native graph readiness identity is invalid or canceled."
        );
      }
      await opts.onReady();
      ready = true;
      line = "";
    }
  } finally {
    reader.releaseLock();
  }
  return ready;
}

/** Only the native structured error code leaves this boundary, never stderr messages. */
async function nativeFailureCode(
  stream: ReadableStream<Uint8Array>
): Promise<string | undefined> {
  const reader = stream.getReader();
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
      return value.code;
    }
  } catch {
    return;
  } finally {
    reader.releaseLock();
  }
}
