import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "./guards.ts";

export const NATIVE_CONFIG_INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type NativeConfigDiagnostic = {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
};

export type NativeConfigCompileResult =
  | {
      readonly transport_version: 1;
      readonly ok: true;
      readonly plan: Readonly<Record<string, unknown>>;
      readonly semantic_hash: string;
    }
  | {
      readonly transport_version: 1;
      readonly ok: false;
      readonly diagnostics: readonly NativeConfigDiagnostic[];
    };

/** Fixed transport failures never include compiler output or authored values. */
export class NativeConfigCompilerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeConfigCompilerError";
    this.code = code;
  }
}

/** Select a reviewed executable, never download or search PATH for a compiler. */
export function resolveNativeConfigCompilerBinary(
  opts: { readonly override?: string; readonly executablePath?: string } = {}
): string {
  const override = opts.override ?? process.env.HACK_CONFIG_COMPILER_BINARY;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw failure(
        "E_COMPILER_PATH",
        "Compiler override must be an absolute path."
      );
    }
    return override;
  }
  return join(
    dirname(opts.executablePath ?? process.execPath),
    "hack-config-compiler"
  );
}

/** Read only an explicitly selected regular input, with bounded allocation. */
export async function readNativeConfigInput(opts: {
  readonly path: string;
}): Promise<Uint8Array> {
  try {
    const info = await stat(opts.path);
    if (!info.isFile() || info.size > NATIVE_CONFIG_INPUT_LIMIT) {
      throw failure(
        "E_CONFIG_INPUT",
        "Native configuration must be a bounded regular file."
      );
    }
    return await readBounded(
      Bun.file(opts.path).stream(),
      NATIVE_CONFIG_INPUT_LIMIT
    );
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw failure(
      "E_CONFIG_INPUT",
      "Cannot read the selected native configuration."
    );
  }
}

/**
 * Ask the owning Rust compiler to validate and normalize authored JSON. Check the
 * transport handshake before sending input. This boundary forwards no credentials,
 * performs no runtime discovery, and never substitutes another compiler/backend.
 */
export async function compileNativeConfig(opts: {
  readonly input: Uint8Array;
  readonly binary?: string;
  readonly profiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<NativeConfigCompileResult> {
  if (opts.input.byteLength > NATIVE_CONFIG_INPUT_LIMIT) {
    throw failure(
      "E_CONFIG_INPUT",
      "Native configuration exceeds the input budget."
    );
  }
  const binary = opts.binary ?? resolveNativeConfigCompilerBinary();
  if (!isAbsolute(binary)) {
    throw failure("E_COMPILER_PATH", "Compiler path must be absolute.");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw failure(
      "E_COMPILER_BUDGET",
      "Compiler timeout is outside the supported budget."
    );
  }
  const request = { binary, timeoutMs, signal: opts.signal };
  const handshake = await invokeCompiler({ ...request, args: ["--protocol"] });
  const protocol = parseControlJson(handshake.output);
  if (
    handshake.exitCode !== 0 ||
    !isRecord(protocol) ||
    protocol.transport_version !== 1 ||
    protocol.authored_version !== 1 ||
    protocol.plan_version !== 1
  ) {
    throw failure(
      "E_COMPILER_VERSION",
      "Native configuration compiler version mismatch."
    );
  }
  const args = ["compile"];
  for (const profile of opts.profiles ?? []) {
    args.push("--profile", profile);
  }
  const response = await invokeCompiler({
    ...request,
    args,
    input: opts.input,
  });
  return parseCompileResponse(response);
}

async function invokeCompiler(opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly input?: Uint8Array;
  readonly signal?: AbortSignal;
}): Promise<{ readonly output: Uint8Array; readonly exitCode: number }> {
  if (opts.signal?.aborted) {
    throw failure(
      "E_COMPILER_CANCELLED",
      "Native configuration validation was cancelled."
    );
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([opts.binary, ...opts.args], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: opts.input === undefined ? "ignore" : opts.input,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw failure(
      "E_COMPILER_MISSING",
      "Native configuration compiler is unavailable. Install its matching bundle."
    );
  }
  let timedOut = false;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, opts.timeoutMs);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) {
    cancel();
  }
  try {
    const [output, , exitCode] = await Promise.all([
      readBounded(child.stdout, OUTPUT_LIMIT),
      readBounded(child.stderr, STDERR_LIMIT),
      child.exited,
    ]);
    if (cancelled || timedOut) {
      throw failure(
        cancelled ? "E_COMPILER_CANCELLED" : "E_COMPILER_TIMEOUT",
        cancelled
          ? "Native configuration validation was cancelled."
          : "Native configuration compiler timed out."
      );
    }
    return { output, exitCode };
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler request failed."
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw failure(
          "E_COMPILER_BUDGET",
          "Native configuration I/O exceeds its budget."
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseControlJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned invalid JSON."
    );
  }
}

function parseCompileResponse(opts: {
  readonly output: Uint8Array;
  readonly exitCode: number;
}): NativeConfigCompileResult {
  const value = parseControlJson(opts.output);
  if (!isRecord(value) || value.transport_version !== 1) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned an invalid envelope."
    );
  }
  if (
    opts.exitCode === 0 &&
    value.ok === true &&
    isRecord(value.plan) &&
    value.plan.plan_version === 1 &&
    typeof value.semantic_hash === "string" &&
    HASH_PATTERN.test(value.semantic_hash)
  ) {
    return {
      transport_version: 1,
      ok: true,
      plan: value.plan,
      semantic_hash: value.semantic_hash,
    };
  }
  if (
    opts.exitCode === 1 &&
    value.ok === false &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length > 0
  ) {
    const diagnostics = value.diagnostics.map(parseDiagnostic);
    return { transport_version: 1, ok: false, diagnostics };
  }
  throw failure(
    "E_COMPILER_RESPONSE",
    "Native configuration compiler returned an invalid result."
  );
}

function parseDiagnostic(value: unknown): NativeConfigDiagnostic {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.pointer !== "string" ||
    typeof value.message !== "string" ||
    typeof value.line !== "number" ||
    !Number.isSafeInteger(value.line) ||
    value.line < 1 ||
    typeof value.column !== "number" ||
    !Number.isSafeInteger(value.column) ||
    value.column < 1
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned an invalid diagnostic."
    );
  }
  return {
    code: value.code,
    pointer: value.pointer,
    message: value.message,
    line: value.line,
    column: value.column,
  };
}

function failure(code: string, message: string): NativeConfigCompilerError {
  return new NativeConfigCompilerError(code, message);
}
