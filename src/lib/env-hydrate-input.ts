import { constants, type FileHandle, open } from "node:fs/promises";
import { ClosedCliError } from "./cli-result.ts";
import type { EnvValueStdinSource } from "./env-value-stdin.ts";

/**
 * Batch input for `hack env hydrate`: many `KEY=value` entries read from a
 * non-TTY stdin or from a file, never from argv.
 *
 * Contract:
 * - Input is bounded by {@link ENV_HYDRATE_INPUT_MAX_BYTES}, the size bound of
 *   one env layer. Reading stops as soon as the bound is exceeded.
 * - A TTY stdin is refused before any byte is read.
 * - Parsing is strict and all-or-nothing: one malformed line refuses the
 *   whole input, so a source that lost a value is never half-imported.
 * - Every refusal is a closed, value-free {@link EnvHydrateInputError}. The
 *   message may carry a 1-based line number; it never carries input bytes,
 *   keys, values, the file path or an underlying error.
 *
 * `env` format, one entry per line (`\n` or `\r\n`):
 * - Blank lines and lines whose first non-blank character is `#` are skipped.
 * - An optional `export ` prefix is accepted.
 * - `KEY=value`, where `KEY` matches `^[A-Z_][A-Z0-9_]*$` (spaces around the
 *   key are ignored). An unquoted value is the rest of the line with
 *   surrounding blanks removed; `#` inside it is literal.
 * - `'...'` is literal. `"..."` accepts the escapes `\n`, `\r`, `\t`, `\"` and
 *   `\\`. A quoted value must close on the same line; only blanks or a
 *   `# comment` may follow it.
 * - Empty values and repeated keys are refused. No `${VAR}` expansion.
 *
 * `json` format: one object whose keys match the key pattern and whose values
 * are non-empty strings. Repeated keys are refused, not resolved last-wins.
 */
export const ENV_HYDRATE_INPUT_MAX_BYTES = 1024 * 1024;

export const ENV_HYDRATE_INPUT_FORMATS = ["env", "json"] as const;
export type EnvHydrateInputFormat = (typeof ENV_HYDRATE_INPUT_FORMATS)[number];

export const ENV_HYDRATE_INPUT_REFUSAL_REASONS = [
  "interactive_tty",
  "invalid_format",
  "oversize",
  "read_failed",
  "invalid_utf8",
  "nul_byte",
  "empty",
  "invalid_line",
  "invalid_key",
  "duplicate_key",
  "empty_value",
  "unterminated_quote",
  "invalid_escape",
  "trailing_text",
  "invalid_json",
  "json_not_object",
  "json_value_not_string",
] as const;

export type EnvHydrateInputRefusalReason =
  (typeof ENV_HYDRATE_INPUT_REFUSAL_REASONS)[number];

const NOTHING_WRITTEN = "Nothing was written.";
const NOT_SHOWN = "Input is not shown because it may contain values.";

const REFUSAL_MESSAGES: Readonly<Record<EnvHydrateInputRefusalReason, string>> =
  {
    interactive_tty:
      "hack env hydrate reads entries from piped stdin or --file, but stdin is an interactive terminal. Pipe the entries in or pass --file.",
    invalid_format: 'Invalid --format value. Expected "env" or "json".',
    oversize: `Hydration input exceeds the ${ENV_HYDRATE_INPUT_MAX_BYTES}-byte limit.`,
    read_failed:
      "Could not read the hydration input. The path is not shown because it may contain a value.",
    invalid_utf8: "Hydration input is not valid UTF-8.",
    nul_byte:
      "Hydration input contains a NUL byte, which env values cannot carry.",
    empty: "Hydration input contains no entries.",
    invalid_line: "expected KEY=value.",
    invalid_key: "keys must match ^[A-Z_][A-Z0-9_]*$.",
    duplicate_key: "the key repeats an earlier entry.",
    empty_value: "the value is empty.",
    unterminated_quote: "the quoted value does not close on this line.",
    invalid_escape:
      'unsupported escape in a double-quoted value (use \\n, \\r, \\t, \\" or \\\\).',
    trailing_text: "unexpected text after the closing quote.",
    invalid_json: "Hydration input is not valid JSON.",
    json_not_object:
      "JSON hydration input must be one object mapping keys to values.",
    json_value_not_string: "JSON hydration values must be strings.",
  };

/** Closed refusal for hydration input; the message never carries input. */
export class EnvHydrateInputError extends ClosedCliError {
  readonly reason: EnvHydrateInputRefusalReason;
  /** 1-based line of an `env`-format refusal, or null. */
  readonly line: number | null;

  constructor(
    reason: EnvHydrateInputRefusalReason,
    line: number | null = null
  ) {
    const detail = REFUSAL_MESSAGES[reason];
    super(
      line === null
        ? `${detail} ${NOT_SHOWN} ${NOTHING_WRITTEN}`
        : `Hydration input line ${line}: ${detail} ${NOT_SHOWN} ${NOTHING_WRITTEN}`
    );
    this.name = "EnvHydrateInputError";
    this.reason = reason;
    this.line = line;
  }
}

/** Fixed refusal for `--format`; the argument is never echoed. */
export function parseEnvHydrateInputFormat(
  format: string | undefined
): EnvHydrateInputFormat {
  const requested = format?.trim() || "env";
  for (const candidate of ENV_HYDRATE_INPUT_FORMATS) {
    if (candidate === requested) {
      return candidate;
    }
  }
  throw new EnvHydrateInputError("invalid_format");
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function processStdinSource(): EnvValueStdinSource {
  return {
    isTTY: process.stdin.isTTY === true,
    open: () => Bun.stdin.stream(),
  };
}

/**
 * Read and parse one hydration input.
 *
 * @param input.filePath - Absolute path to read instead of stdin. Pipes and
 *   FIFOs (for example `--file <(producer)`) are accepted; directories are not.
 * @param input.stdin - Stdin source; defaults to the process stdin.
 * @returns Validated keys to values, in input order.
 * @throws EnvHydrateInputError for every refusal (closed, value-free).
 */
export async function readEnvHydrateInput(input: {
  readonly format: EnvHydrateInputFormat;
  readonly filePath?: string | null;
  readonly stdin?: EnvValueStdinSource;
  readonly maxBytes?: number;
}): Promise<ReadonlyMap<string, string>> {
  const maxBytes = input.maxBytes ?? ENV_HYDRATE_INPUT_MAX_BYTES;
  const bytes =
    typeof input.filePath === "string"
      ? await readBoundedFile({ path: input.filePath, maxBytes })
      : await readBoundedStdin({
          source: input.stdin ?? processStdinSource(),
          maxBytes,
        });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EnvHydrateInputError("invalid_utf8");
  } finally {
    bytes.fill(0);
  }
  if (text.includes("\0")) {
    throw new EnvHydrateInputError("nul_byte");
  }
  return parseEnvHydrateInput({ text, format: input.format });
}

/** Parse decoded hydration input under the module contract. */
export function parseEnvHydrateInput(input: {
  readonly text: string;
  readonly format: EnvHydrateInputFormat;
}): ReadonlyMap<string, string> {
  const entries =
    input.format === "json"
      ? parseJsonEntries(input.text)
      : parseEnvEntries(input.text);
  if (entries.size === 0) {
    throw new EnvHydrateInputError("empty");
  }
  return entries;
}

function parseEnvEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const body = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed;
    const equals = body.indexOf("=");
    if (equals <= 0) {
      throw new EnvHydrateInputError("invalid_line", lineNumber);
    }
    const key = body.slice(0, equals).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new EnvHydrateInputError("invalid_key", lineNumber);
    }
    if (entries.has(key)) {
      throw new EnvHydrateInputError("duplicate_key", lineNumber);
    }
    const value = parseEnvValue({
      raw: body.slice(equals + 1).trim(),
      lineNumber,
    });
    if (value.length === 0) {
      throw new EnvHydrateInputError("empty_value", lineNumber);
    }
    entries.set(key, value);
  }
  return entries;
}

function parseEnvValue(input: {
  readonly raw: string;
  readonly lineNumber: number;
}): string {
  const quote = input.raw[0];
  if (quote === "'") {
    const close = input.raw.indexOf("'", 1);
    if (close < 0) {
      throw new EnvHydrateInputError("unterminated_quote", input.lineNumber);
    }
    assertOnlyCommentAfter({
      rest: input.raw.slice(close + 1),
      lineNumber: input.lineNumber,
    });
    return input.raw.slice(1, close);
  }
  if (quote === '"') {
    return parseDoubleQuoted(input);
  }
  return input.raw;
}

const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
};

function parseDoubleQuoted(input: {
  readonly raw: string;
  readonly lineNumber: number;
}): string {
  let value = "";
  for (let index = 1; index < input.raw.length; index += 1) {
    const char = input.raw[index];
    if (char === '"') {
      assertOnlyCommentAfter({
        rest: input.raw.slice(index + 1),
        lineNumber: input.lineNumber,
      });
      return value;
    }
    if (char === "\\") {
      const escaped = DOUBLE_QUOTE_ESCAPES[input.raw[index + 1] ?? ""];
      if (escaped === undefined) {
        throw new EnvHydrateInputError("invalid_escape", input.lineNumber);
      }
      value += escaped;
      index += 1;
      continue;
    }
    value += char;
  }
  throw new EnvHydrateInputError("unterminated_quote", input.lineNumber);
}

function assertOnlyCommentAfter(input: {
  readonly rest: string;
  readonly lineNumber: number;
}): void {
  const rest = input.rest.trim();
  if (rest.length > 0 && !rest.startsWith("#")) {
    throw new EnvHydrateInputError("trailing_text", input.lineNumber);
  }
}

function parseJsonEntries(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvHydrateInputError("invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EnvHydrateInputError("json_not_object");
  }
  // JSON.parse silently keeps the last of repeated keys; refuse them instead,
  // as the env format does.
  if (hasDuplicateTopLevelJsonKey(text)) {
    throw new EnvHydrateInputError("duplicate_key");
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new EnvHydrateInputError("invalid_key");
    }
    if (typeof value !== "string") {
      throw new EnvHydrateInputError("json_value_not_string");
    }
    if (value.length === 0) {
      throw new EnvHydrateInputError("empty_value");
    }
    entries.set(key, value);
  }
  return entries;
}

/**
 * Whether the top-level object in `text` names one key twice. `text` must
 * already be valid JSON whose root is an object: the scan only tracks string
 * boundaries and nesting depth, and decodes each depth-1 key with JSON.parse
 * so escaped spellings of one key compare equal.
 */
function hasDuplicateTopLevelJsonKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = closingJsonQuoteIndex(text, index);
      // expectKey is set only at depth 1, after `{` or `,`, and in valid JSON
      // the next string there is the key.
      if (expectKey) {
        const key = String(JSON.parse(text.slice(index, end + 1)));
        if (seen.has(key)) {
          return true;
        }
        seen.add(key);
        expectKey = false;
      }
      index = end;
      continue;
    }
    depth += jsonDepthChange(char);
    // Only the root opens depth 1, and the caller checked it is an object.
    if (depth === 1 && (char === "{" || char === ",")) {
      expectKey = true;
    }
  }
  return false;
}

/** Index of the quote closing the JSON string that opens at `start`. */
function closingJsonQuoteIndex(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index;
}

function jsonDepthChange(char: string | undefined): number {
  if (char === "{" || char === "[") {
    return 1;
  }
  if (char === "}" || char === "]") {
    return -1;
  }
  return 0;
}

async function readBoundedStdin(input: {
  readonly source: EnvValueStdinSource;
  readonly maxBytes: number;
}): Promise<Uint8Array> {
  if (input.source.isTTY) {
    throw new EnvHydrateInputError("interactive_tty");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = input.source.open().getReader();
  } catch {
    throw new EnvHydrateInputError("read_failed");
  }
  try {
    while (true) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        wipe(chunks);
        throw new EnvHydrateInputError("read_failed");
      }
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      chunks.push(result.value);
      if (total > input.maxBytes) {
        wipe(chunks);
        await reader.cancel().catch(() => undefined);
        throw new EnvHydrateInputError("oversize");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks, total);
}

async function readBoundedFile(input: {
  readonly path: string;
  readonly maxBytes: number;
}): Promise<Uint8Array> {
  let file: FileHandle;
  try {
    file = await open(input.path, constants.O_RDONLY);
  } catch {
    throw new EnvHydrateInputError("read_failed");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const stats = await file.stat().catch(() => null);
    if (stats === null || stats.isDirectory()) {
      throw new EnvHydrateInputError("read_failed");
    }
    while (true) {
      const chunk = new Uint8Array(64 * 1024);
      let bytesRead: number;
      try {
        ({ bytesRead } = await file.read(chunk, 0, chunk.byteLength, null));
      } catch {
        chunk.fill(0);
        wipe(chunks);
        throw new EnvHydrateInputError("read_failed");
      }
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
      if (total > input.maxBytes) {
        chunk.fill(0);
        wipe(chunks);
        throw new EnvHydrateInputError("oversize");
      }
    }
  } finally {
    await file.close().catch(() => undefined);
  }
  return concat(chunks, total);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  wipe(chunks);
  return out;
}

function wipe(chunks: readonly Uint8Array[]): void {
  for (const chunk of chunks) {
    chunk.fill(0);
  }
}
