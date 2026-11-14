/** Compose dotenv syntax and interpolation. All inputs/results may be private. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ENTRY =
  /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:([=:])[ \t]*(.*))?$/;
const COMMENT = /[ \t]+#.*$/;
const OPERATOR = /^(?::)?[-+?]/;
const BOM = /^\uFEFF/;
const ESCAPE_SEQUENCE = /\\(?:[abcfnrtv$"\\]|0\d{0,3})/g;
const OCTAL = /^[0-7]{3}$/;
const MAX_BYTES = 256 * 1024;
const MAX_LINES = 4096;
const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  $: "$$",
};

export type ComposeEnvLookup = (name: string) => string | undefined;
/** The destination assignment, never a name extracted from its private value. */
export type ComposeEnvEntry = { readonly key: string; readonly line: number };

/** All syntactic source names, including unselected words, without reading values. */
export function composeEnvironmentReferences(
  text: string
): ReadonlySet<string> {
  const result = new Set<string>();
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== "$") {
      continue;
    }
    if (text[cursor + 1] === "$") {
      cursor += 1;
      continue;
    }
    const begin = cursor + (text[cursor + 1] === "{" ? 2 : 1);
    const name = NAME.exec(text.slice(begin))?.[0];
    if (name !== undefined) {
      result.add(name);
    }
  }
  return result;
}

/** Closed failures never include the input, an authored error word or values. */
export class NativeEnvSyntaxError extends Error {
  readonly line?: number;
  constructor(line?: number) {
    super(
      `Invalid or unresolved Compose environment input${line === undefined ? "" : ` at line ${line}`}; values omitted.`
    );
    this.line = line;
  }
}
function invalid(): never {
  throw new NativeEnvSyntaxError();
}

function braced(
  text: string,
  begin: number,
  depth: number
): { readonly body: string; readonly next: number } {
  let nesting = 1;
  let cursor = begin;
  while (cursor < text.length) {
    if (text.startsWith("$$", cursor)) {
      cursor += 2;
      continue;
    }
    if (text.startsWith("${", cursor)) {
      nesting += 1;
      if (depth + nesting > 4) {
        return invalid();
      }
      cursor += 2;
      continue;
    }
    if (text[cursor] === "}") {
      nesting -= 1;
      if (nesting === 0) {
        return { body: text.slice(begin, cursor), next: cursor + 1 };
      }
    }
    cursor += 1;
  }
  return invalid();
}

function expression(opts: {
  readonly body: string;
  readonly lookup: ComposeEnvLookup;
  readonly expand: (word: string) => string;
  readonly onMissing?: (name: string) => void;
}): string {
  const name = NAME.exec(opts.body)?.[0];
  if (name === undefined) {
    return invalid();
  }
  const suffix = opts.body.slice(name.length);
  const value = opts.lookup(name);
  if (suffix === "") {
    if (value === undefined) {
      opts.onMissing?.(name);
    }
    return value ?? "";
  }
  const operator = OPERATOR.exec(suffix)?.[0];
  if (operator === undefined) {
    return invalid();
  }
  const present =
    value !== undefined && (!operator.startsWith(":") || value !== "");
  const kind = operator.at(-1);
  if (kind === "?" && !present) {
    return invalid();
  }
  if ((kind === "-" && !present) || (kind === "+" && present)) {
    return opts.expand(suffix.slice(operator.length));
  }
  return kind === "+" ? "" : (value ?? "");
}

function unbraced(opts: {
  readonly text: string;
  readonly cursor: number;
  readonly lookup: ComposeEnvLookup;
  readonly onMissing?: (name: string) => void;
}): { readonly value: string; readonly next: number } {
  const name = NAME.exec(opts.text.slice(opts.cursor))?.[0];
  if (name === undefined) {
    return { value: "$", next: opts.cursor };
  }
  const value = opts.lookup(name);
  if (value === undefined) {
    opts.onMissing?.(name);
  }
  return { value: value ?? "", next: opts.cursor + name.length };
}

/**
 * Compose operators, including unset versus empty, nested words and $$ escaping.
 * The caller owns the lookup boundary; no ambient environment is consulted here.
 */
export function interpolateComposeEnvironment(opts: {
  readonly text: string;
  readonly lookup: ComposeEnvLookup;
  readonly onMissing?: (name: string) => void;
}): string {
  let remaining = MAX_BYTES;
  function expand(text: string, depth: number): string {
    if (depth > 4 || Buffer.byteLength(text) > MAX_BYTES) {
      return invalid();
    }
    let result = "";
    let cursor = 0;
    function append(value: string): void {
      remaining -= Buffer.byteLength(value);
      if (remaining < 0 || value.includes("\0")) {
        invalid();
      }
      result += value;
    }
    while (cursor < text.length) {
      const dollar = text.indexOf("$", cursor);
      if (dollar < 0) {
        append(text.slice(cursor));
        break;
      }
      append(text.slice(cursor, dollar));
      cursor = dollar + 1;
      if (text[cursor] === "$") {
        append("$");
        cursor += 1;
        continue;
      }
      if (text[cursor] === "{") {
        if (depth >= 4) {
          return invalid();
        }
        const found = braced(text, cursor + 1, depth);
        append(
          expression({
            body: found.body,
            lookup: opts.lookup,
            onMissing: opts.onMissing,
            expand: (word) => expand(word, depth + 1),
          })
        );
        cursor = found.next;
        continue;
      }
      const found = unbraced({
        text,
        cursor,
        lookup: opts.lookup,
        onMissing: opts.onMissing,
      });
      append(found.value);
      cursor = found.next;
    }
    return result;
  }
  return expand(opts.text, 0);
}

/** Match compose-go's escape pass after escaped quote delimiters are removed. */
function doubleQuotedEscapes(value: string): string {
  return value.replace(ESCAPE_SEQUENCE, (match) => {
    if (match.startsWith("\\0")) {
      const digits = match.slice(2);
      return OCTAL.test(digits)
        ? String.fromCharCode(Number.parseInt(digits, 8))
        : `\\${digits}`;
    }
    const key = match[1] ?? "";
    return Object.hasOwn(ESCAPES, key) ? (ESCAPES[key] ?? match) : match;
  });
}

/** Preserve escape pairs until the Compose double-quote escape pass. */
function quotedCharacter(opts: {
  readonly char: string;
  readonly quote: string | undefined;
  readonly escaped: boolean;
}): { readonly text: string; readonly escaped: boolean } {
  if (opts.char === "\\" && !opts.escaped) {
    return { text: "", escaped: true };
  }
  return {
    text:
      opts.escaped && opts.char !== opts.quote ? `\\${opts.char}` : opts.char,
    escaped: false,
  };
}

/** Read a possibly multiline quoted dotenv value, with Compose quote escaping. */
function quoted(opts: {
  readonly lines: readonly string[];
  readonly start: number;
  readonly value: string;
}): { readonly value: string; readonly end: number } {
  const quote = opts.value[0];
  let decoded = "";
  let rest = opts.value.slice(1);
  let position = 0;
  let index = opts.start;
  let escaped = false;
  for (;;) {
    const ch = rest[position];
    if (ch === undefined) {
      index += 1;
      if (index >= opts.lines.length) {
        return invalid();
      }
      decoded += escaped ? "\\\n" : "\n";
      escaped = false;
      rest = opts.lines[index] ?? "";
      position = 0;
      continue;
    }
    if (ch === quote && !escaped) {
      const tail = rest.slice(position + 1).trim();
      if (tail !== "" && !tail.startsWith("#")) {
        return invalid();
      }
      return {
        value: quote === '"' ? doubleQuotedEscapes(decoded) : decoded,
        end: index,
      };
    }
    const next = quotedCharacter({ char: ch, quote, escaped });
    decoded += next.text;
    escaped = next.escaped;
    position += 1;
  }
}

function dotenvValue(opts: {
  readonly raw: boolean;
  readonly line: string;
  readonly value: string;
  readonly lines: readonly string[];
  readonly start: number;
  readonly lookup: ComposeEnvLookup;
  readonly onMissing?: (name: string) => void;
}): { readonly value: string; readonly end: number } {
  if (opts.raw) {
    const equals = opts.line.indexOf("=");
    if (equals < 0) {
      return invalid();
    }
    return { value: opts.line.slice(equals + 1), end: opts.start };
  }
  if (opts.value[0] !== "'" && opts.value[0] !== '"') {
    return {
      value: interpolateComposeEnvironment({
        text: opts.value.replace(COMMENT, "").trimEnd(),
        lookup: opts.lookup,
        onMissing: opts.onMissing,
      }),
      end: opts.start,
    };
  }
  const decoded = quoted(opts);
  return {
    value:
      opts.value[0] === "'"
        ? decoded.value
        : interpolateComposeEnvironment({
            text: decoded.value,
            lookup: opts.lookup,
            onMissing: opts.onMissing,
          }),
    end: decoded.end,
  };
}

function inheritBareFileName(opts: {
  readonly key: string;
  readonly lookup: ComposeEnvLookup;
  readonly values: Map<string, string>;
  readonly onUnresolved?: (name: string) => void;
}): void {
  const inherited = opts.lookup(opts.key);
  if (inherited !== undefined) {
    opts.values.set(opts.key, inherited);
  } else if (!opts.values.has(opts.key)) {
    opts.onUnresolved?.(opts.key);
  }
}

/**
 * Sequential Compose assignments, seeded by earlier files. A bare name inherits
 * only from project/service lookup; when unresolved it leaves prior entries
 * alone, as compose-go does. Raw format does not unquote or interpolate values.
 */
export function parseComposeEnvironmentFile(opts: {
  readonly text: string;
  readonly raw?: boolean;
  readonly lookup: (name: string, entry: ComposeEnvEntry) => string | undefined;
  readonly initial?: ReadonlyMap<string, string>;
  readonly onEntry?: (entry: ComposeEnvEntry) => void;
  readonly onMissing?: (name: string, entry: ComposeEnvEntry) => void;
  /** Source admission after both project lookup and parsed-file assignments miss. */
  readonly onUnresolved?: (name: string, entry: ComposeEnvEntry) => void;
}): ReadonlyMap<string, string> {
  if (Buffer.byteLength(opts.text) > MAX_BYTES) {
    throw new NativeEnvSyntaxError(1);
  }
  const nul = opts.text.indexOf("\0");
  if (nul >= 0) {
    throw new NativeEnvSyntaxError(opts.text.slice(0, nul).split("\n").length);
  }
  const result = new Map(opts.initial);
  const lines = opts.text.replace(BOM, "").replaceAll("\r\n", "\n").split("\n");
  // A final newline terminates the last physical line rather than adding one.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length > MAX_LINES) {
    throw new NativeEnvSyntaxError(MAX_LINES + 1);
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trimStart();
    if (line.trim() === "" || line.startsWith("#")) {
      continue;
    }
    const entry = ENTRY.exec(line);
    const key = entry?.[1];
    if (key === undefined) {
      throw new NativeEnvSyntaxError(index + 1);
    }
    const location = { key, line: index + 1 };
    opts.onEntry?.(location);
    const external = (name: string) => opts.lookup(name, location);
    const unresolved = (name: string) => opts.onUnresolved?.(name, location);
    const lookup = (name: string) => {
      const found = external(name) ?? result.get(name);
      if (found === undefined) {
        unresolved(name);
      }
      return found;
    };
    if (opts.raw && entry?.[2] !== "=" && entry?.[2] !== undefined) {
      throw new NativeEnvSyntaxError(location.line);
    }
    if (entry?.[2] === undefined) {
      inheritBareFileName({
        key,
        lookup: external,
        values: result,
        onUnresolved: unresolved,
      });
      continue;
    }
    let decoded: { readonly value: string; readonly end: number };
    try {
      decoded = dotenvValue({
        raw: opts.raw ?? false,
        line,
        value: entry?.[3] ?? "",
        lines,
        start: index,
        lookup,
        onMissing: (name) => opts.onMissing?.(name, location),
      });
    } catch (error: unknown) {
      if (error instanceof NativeEnvSyntaxError) {
        throw new NativeEnvSyntaxError(location.line);
      }
      throw error;
    }
    index = decoded.end;
    result.set(key, decoded.value);
  }
  return result;
}
