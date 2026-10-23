/**
 * Test-only decoder for a LogQL double-quoted string literal.
 *
 * Loki scans a string token with Go's `text/scanner` and decodes it with
 * Prometheus `strutil.Unquote`, which follows `strconv.Unquote` for
 * double-quoted strings. This mirrors those rules so tests check what Loki
 * would actually receive as the label value or regex:
 *
 * - the literal starts and ends with `"`; a raw `"` or newline inside it is
 *   an error;
 * - `\a \b \f \n \r \t \v \\ \"` are single-character escapes;
 * - `\xHH`, `\ooo` (three octal digits, at most 0o377), `\uHHHH` and
 *   `\UHHHHHHHH` encode one byte or code point;
 * - any other escape, including `\'`, is an error.
 *
 * `\x` and octal escapes encode raw bytes in Go; for the ASCII range this
 * helper accepts, a byte and a code point are the same.
 */
export function unquoteGoDoubleQuoted(literal: string): string {
  if (
    literal.length < 2 ||
    !literal.startsWith('"') ||
    !literal.endsWith('"')
  ) {
    throw new Error(`not a double-quoted literal: ${literal}`);
  }
  const body = literal.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    if (ch === '"' || ch === "\n") {
      throw new Error(`unescaped ${JSON.stringify(ch)} at ${i} in ${literal}`);
    }
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const decoded = decodeEscape(body, i + 1, literal);
    out += decoded.value;
    i = decoded.next;
  }
  return out;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

const HEX_ESCAPE_LENGTHS: Readonly<Record<string, number>> = {
  x: 2,
  u: 4,
  U: 8,
};

function decodeEscape(
  body: string,
  start: number,
  literal: string
): { readonly value: string; readonly next: number } {
  const kind = body[start];
  if (kind === undefined) {
    throw new Error(`dangling backslash in ${literal}`);
  }
  const simple = SIMPLE_ESCAPES[kind];
  if (simple !== undefined) {
    return { value: simple, next: start + 1 };
  }
  const hexLength = HEX_ESCAPE_LENGTHS[kind];
  if (hexLength !== undefined) {
    const digits = body.slice(start + 1, start + 1 + hexLength);
    if (!new RegExp(`^[0-9A-Fa-f]{${hexLength}}$`).test(digits)) {
      throw new Error(`bad \\${kind} escape in ${literal}`);
    }
    const code = Number.parseInt(digits, 16);
    if (kind === "x" && code > 0x7f) {
      throw new Error(`non-ASCII \\x byte is out of scope in ${literal}`);
    }
    if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) {
      throw new Error(`invalid code point escape in ${literal}`);
    }
    return {
      value: String.fromCodePoint(code),
      next: start + 1 + hexLength,
    };
  }
  if (/[0-7]/.test(kind)) {
    const digits = body.slice(start, start + 3);
    if (!/^[0-7]{3}$/.test(digits)) {
      throw new Error(`bad octal escape in ${literal}`);
    }
    const code = Number.parseInt(digits, 8);
    if (code > 0x7f) {
      throw new Error(`non-ASCII octal byte is out of scope in ${literal}`);
    }
    return { value: String.fromCharCode(code), next: start + 3 };
  }
  throw new Error(`unknown escape \\${kind} in ${literal}`);
}
