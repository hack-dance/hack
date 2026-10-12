import { CliUsageError } from "../cli/command.ts";

/**
 * Non-argv value input for `hack env add|set --value-stdin`.
 *
 * Contract:
 * - The value is read only from a non-TTY stdin (a pipe, file, or here-doc),
 *   so it never appears in argv, shell history, or process listings. A TTY
 *   stdin is refused before any byte is read; the hidden prompt is the
 *   interactive path.
 * - Input is bounded by {@link ENV_VALUE_STDIN_MAX_BYTES}. Reading stops and
 *   the stream is canceled as soon as the bound is exceeded, so an endless
 *   producer cannot exhaust memory.
 * - Exactly one trailing newline (`\n`, or `\r\n` treated as one newline) is
 *   stripped, so `printf '%s\n' "$v"` and `printf '%s' "$v"` store the same
 *   value. Any further trailing newlines are preserved as part of the value.
 * - Empty input (after that strip), invalid UTF-8, and NUL bytes are refused.
 *
 * Every refusal is a closed, value-free {@link EnvValueStdinError}: messages
 * are fixed strings and never include caller input, byte content, or the
 * underlying read error.
 */
export const ENV_VALUE_STDIN_MAX_BYTES = 64 * 1024;

export const ENV_VALUE_STDIN_REFUSAL_REASONS = [
  "interactive_tty",
  "oversize",
  "empty",
  "invalid_utf8",
  "nul_byte",
  "read_failed",
  "positional_value",
  "missing_key",
] as const;

export type EnvValueStdinRefusalReason =
  (typeof ENV_VALUE_STDIN_REFUSAL_REASONS)[number];

const REFUSAL_MESSAGES: Readonly<Record<EnvValueStdinRefusalReason, string>> = {
  interactive_tty:
    "--value-stdin needs piped input, but stdin is an interactive terminal. Pipe the value from a secret manager or file, or omit --value-stdin to use the hidden prompt. Nothing was stored.",
  oversize: `--value-stdin input exceeds the ${ENV_VALUE_STDIN_MAX_BYTES}-byte limit. Nothing was stored.`,
  empty: "--value-stdin received an empty value. Nothing was stored.",
  invalid_utf8: "--value-stdin input is not valid UTF-8. Nothing was stored.",
  nul_byte:
    "--value-stdin input contains a NUL byte, which env values cannot carry. Nothing was stored.",
  read_failed: "--value-stdin could not read stdin. Nothing was stored.",
  positional_value:
    "--value-stdin cannot be combined with a value argument (including KEY=value). Pass only the key and pipe the value. Nothing was stored.",
  missing_key:
    "--value-stdin requires the key as an argument, for example `hack env add API_TOKEN --secret --value-stdin`. Nothing was stored.",
};

/** Closed refusal for `--value-stdin`; the message never carries input. */
export class EnvValueStdinError extends CliUsageError {
  readonly reason: EnvValueStdinRefusalReason;

  constructor(reason: EnvValueStdinRefusalReason) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "EnvValueStdinError";
    this.reason = reason;
  }
}

/** Where `--value-stdin` reads from. Injected by tests; defaults to process stdin. */
export type EnvValueStdinSource = {
  readonly isTTY: boolean;
  readonly open: () => ReadableStream<Uint8Array>;
};

function processStdinSource(): EnvValueStdinSource {
  return {
    isTTY: process.stdin.isTTY === true,
    open: () => Bun.stdin.stream(),
  };
}

/**
 * Refuse `--value-stdin` argument combinations before reading anything.
 *
 * @param input.hasKey - Whether a key argument was supplied.
 * @param input.hasPositionalValue - Whether a value argument (or a
 *   `KEY=value` spec) was supplied alongside the flag.
 */
export function assertEnvValueStdinUsage(input: {
  readonly hasKey: boolean;
  readonly hasPositionalValue: boolean;
}): void {
  if (input.hasPositionalValue) {
    throw new EnvValueStdinError("positional_value");
  }
  if (!input.hasKey) {
    throw new EnvValueStdinError("missing_key");
  }
}

/**
 * Read one env value from a non-TTY stdin under the module contract.
 *
 * @param input.source - Stdin source; defaults to the process stdin.
 * @param input.maxBytes - Byte bound; defaults to {@link ENV_VALUE_STDIN_MAX_BYTES}.
 * @returns The decoded value with exactly one trailing newline removed.
 * @throws EnvValueStdinError for every refusal (closed, value-free).
 */
export async function readEnvValueFromStdin(
  input: {
    readonly source?: EnvValueStdinSource;
    readonly maxBytes?: number;
  } = {}
): Promise<string> {
  const source = input.source ?? processStdinSource();
  const maxBytes = input.maxBytes ?? ENV_VALUE_STDIN_MAX_BYTES;
  if (source.isTTY) {
    throw new EnvValueStdinError("interactive_tty");
  }

  const bytes = await readBounded({ source, maxBytes });
  const decoded = decodeUtf8(bytes);
  bytes.fill(0);
  if (decoded.includes("\0")) {
    throw new EnvValueStdinError("nul_byte");
  }
  const value = stripOneTrailingNewline(decoded);
  if (value.length === 0) {
    throw new EnvValueStdinError("empty");
  }
  return value;
}

async function readBounded(input: {
  readonly source: EnvValueStdinSource;
  readonly maxBytes: number;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = input.source.open().getReader();
  } catch {
    throw new EnvValueStdinError("read_failed");
  }

  const wipeChunks = (): void => {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  };

  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        wipeChunks();
        throw new EnvValueStdinError("read_failed");
      }
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > input.maxBytes) {
        result.value.fill(0);
        wipeChunks();
        await reader.cancel().catch(() => undefined);
        throw new EnvValueStdinError("oversize");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  wipeChunks();
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    bytes.fill(0);
    throw new EnvValueStdinError("invalid_utf8");
  }
}

/** Remove exactly one trailing `\n` or `\r\n`; leave everything else intact. */
export function stripOneTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}
