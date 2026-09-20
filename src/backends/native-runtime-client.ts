import { isAbsolute } from "node:path";

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
  readonly privateInput?: Uint8Array;
}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
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
      stderr: "ignore",
    }
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    if (opts.privateInput && child.stdin && typeof child.stdin !== "number") {
      child.stdin.write(opts.privateInput);
      await child.stdin.end();
    }
    const bytes = await readBoundedOutput(child.stdout);
    const code = await child.exited;
    if (timedOut || code !== 0) {
      throw new Error(
        timedOut
          ? "Native runtime request timed out; inspect owned state before retrying."
          : "Native runtime request failed; inspect owned state before retrying."
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error("Native runtime returned an invalid control response.");
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
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
