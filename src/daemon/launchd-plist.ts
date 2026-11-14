/**
 * Reads which executable a launchd plist runs, from the keys of its root
 * `<dict>` only (HACK-2216). The reader is deliberately small: anything it
 * does not fully understand is `unknown`, and unknown is never evidence
 * that the program is missing, so callers leave such a plist as it is.
 */

/**
 * `path`: the executable, with launchd's precedence (`Program` when present,
 * else `ProgramArguments[0]`). `none`: neither key is a root key (or the
 * plist is empty), so nothing is run: absence established. `unknown`: see
 * {@link parseLaunchdPlistProgram}.
 */
export type LaunchdPlistProgram =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly reason: string };

type Token =
  | { readonly kind: "open" | "close" | "empty"; readonly name: string }
  | { readonly kind: "text"; readonly text: string };

type PlistValue =
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "array"; readonly first: PlistValue | null }
  | {
      readonly kind: "dict";
      readonly keys: ReadonlyMap<string, PlistValue>;
    }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "other" };

const PROLOG = /^\s*(<\?xml[^?]*\?>)?\s*(<!DOCTYPE[^>[]*>)?/;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /^<(\/?)([A-Za-z][\w.-]*)(\s+[^<>]*?)?(\/?)>/;
/** Values that hold plain text (a `<key>` is read by the dict reader). */
const SCALAR_TAGS = new Set(["string", "integer", "real", "date", "data"]);
const EMPTY_VALUE_TAGS = new Set(["true", "false", "string", "array", "dict"]);

class PlistShapeError extends Error {}

/**
 * Unknown when: the text is not a property list; it has an unterminated
 * comment, CDATA, a processing instruction or a doctype past the prolog;
 * its root is not a `<dict>`; a tag is malformed or unbalanced; a root key
 * repeats; `Program` is not a string or `ProgramArguments` not an array
 * starting with a string; or the path uses an XML escape or is relative.
 * Comments are dropped as launchd drops them, and keys of nested dicts
 * (for example inside `EnvironmentVariables`) never count.
 */
export function parseLaunchdPlistProgram(opts: {
  readonly plistText: string;
}): LaunchdPlistProgram {
  let root: Map<string, PlistValue> | null;
  try {
    root = readRootDict(opts.plistText);
  } catch (error: unknown) {
    return {
      kind: "unknown",
      reason: error instanceof PlistShapeError ? error.message : "unreadable",
    };
  }
  if (root === null) {
    return { kind: "none" };
  }
  const program = root.get("Program");
  if (program !== undefined) {
    return program.kind === "string"
      ? programPath(program.text)
      : { kind: "unknown", reason: "Program is not a plain string value" };
  }
  const args = root.get("ProgramArguments");
  if (args === undefined) {
    return { kind: "none" };
  }
  return args.kind === "array" && args.first?.kind === "string"
    ? programPath(args.first.text)
    : {
        kind: "unknown",
        reason: "ProgramArguments is not an array that starts with a string",
      };
}

/**
 * The plist's root `EnvironmentVariables` (HACK-2216), for the home
 * binding check before an automatic rewrite: `env` maps each name to its
 * string value (null for a non-string value); an absent dict is empty.
 * `unknown` when the plist cannot be read ({@link parseLaunchdPlistProgram})
 * or `EnvironmentVariables` is not a dict.
 */
export function parseLaunchdPlistEnvironment(opts: {
  readonly plistText: string;
}):
  | {
      readonly kind: "env";
      readonly env: ReadonlyMap<string, string | null>;
    }
  | { readonly kind: "unknown"; readonly reason: string } {
  let root: Map<string, PlistValue> | null;
  try {
    root = readRootDict(opts.plistText);
  } catch (error: unknown) {
    return {
      kind: "unknown",
      reason: error instanceof PlistShapeError ? error.message : "unreadable",
    };
  }
  const value = root?.get("EnvironmentVariables");
  if (value === undefined) {
    return { kind: "env", env: new Map() };
  }
  if (value.kind !== "dict") {
    return {
      kind: "unknown",
      reason: "EnvironmentVariables is not a dict",
    };
  }
  const env = new Map<string, string | null>();
  for (const [name, entry] of value.keys) {
    env.set(name, entry.kind === "string" ? entry.text : null);
  }
  return { kind: "env", env };
}

/**
 * Whether launchd may start the job again on its own (HACK-2216): `none`
 * when the root has no `KeepAlive` (or `KeepAlive` false) and no
 * `RunAtLoad` true; `retry` when `KeepAlive` is true or `RunAtLoad` is
 * true; `unknown` for a conditional `KeepAlive` dict (whether it fires
 * depends on state this reader does not see), any other value, or an
 * unreadable plist.
 */
export function parseLaunchdPlistRetry(opts: {
  readonly plistText: string;
}): "none" | "retry" | "unknown" {
  let root: Map<string, PlistValue> | null;
  try {
    root = readRootDict(opts.plistText);
  } catch {
    return "unknown";
  }
  const keepAlive = root?.get("KeepAlive");
  const runAtLoad = root?.get("RunAtLoad");
  const flag = (value: PlistValue | undefined) => {
    if (value === undefined) {
      return "false" as const;
    }
    if (value.kind === "bool") {
      return value.value ? ("true" as const) : ("false" as const);
    }
    return "unknown" as const;
  };
  const keep = flag(keepAlive);
  const load = flag(runAtLoad);
  if (keep === "unknown" || load === "unknown") {
    return "unknown";
  }
  return keep === "true" || load === "true" ? "retry" : "none";
}

function programPath(raw: string): LaunchdPlistProgram {
  // Exactly as written: launchd does not trim string values.
  const path = raw;
  if (path.includes("&")) {
    return { kind: "unknown", reason: "the program path uses an XML escape" };
  }
  if (!path.startsWith("/")) {
    return { kind: "unknown", reason: "the program path is not absolute" };
  }
  return { kind: "path", path };
}

/** The root dict's keys, or null for an empty `<plist/>`. Throws on shape. */
function readRootDict(text: string): Map<string, PlistValue> | null {
  const tokens = tokenize(text);
  let i = skipSpace(tokens, 0);
  const plist = tokens[i];
  if (plist?.kind === "empty" && plist.name === "plist") {
    expectEnd(tokens, i + 1);
    return null;
  }
  if (!(plist?.kind === "open" && plist.name === "plist")) {
    throw new PlistShapeError("not a property list");
  }
  i = skipSpace(tokens, i + 1);
  const first = tokens[i];
  if (first?.kind === "close" && first.name === "plist") {
    expectEnd(tokens, i + 1);
    return null;
  }
  if (first?.kind === "empty" && first.name === "dict") {
    i = expectClose(tokens, skipSpace(tokens, i + 1), "plist");
    expectEnd(tokens, i);
    return new Map();
  }
  if (!(first?.kind === "open" && first.name === "dict")) {
    throw new PlistShapeError("the plist root is not a dict");
  }
  const parsed = readDictBody(tokens, i + 1, true);
  i = expectClose(tokens, skipSpace(tokens, parsed.next), "plist");
  expectEnd(tokens, i);
  return parsed.keys;
}

function tokenize(input: string): Token[] {
  const text = input.replace(PROLOG, "").replace(COMMENT, "");
  if (text.includes("<!") || text.includes("<?")) {
    throw new PlistShapeError(
      "it has an unterminated comment, CDATA, a doctype or a processing instruction"
    );
  }
  const tokens: Token[] = [];
  let rest = text;
  while (rest.length > 0) {
    const lt = rest.indexOf("<");
    if (lt < 0) {
      tokens.push({ kind: "text", text: rest });
      break;
    }
    if (lt > 0) {
      tokens.push({ kind: "text", text: rest.slice(0, lt) });
      rest = rest.slice(lt);
      continue;
    }
    const tag = readTag(rest);
    tokens.push(tag.token);
    rest = rest.slice(tag.length);
  }
  return tokens;
}

function readTag(rest: string): {
  readonly token: Token;
  readonly length: number;
} {
  const match = TAG.exec(rest);
  if (match === null) {
    throw new PlistShapeError("it has a malformed tag");
  }
  const [whole, closing, name = "", , selfClosing] = match;
  if (closing && selfClosing) {
    throw new PlistShapeError("it has a malformed tag");
  }
  let kind: "open" | "close" | "empty" = "open";
  if (closing) {
    kind = "close";
  } else if (selfClosing) {
    kind = "empty";
  }
  return { token: { kind, name }, length: whole.length };
}

function skipSpace(tokens: readonly Token[], start: number): number {
  let i = start;
  while (true) {
    const token = tokens[i];
    if (!(token?.kind === "text" && token.text.trim() === "")) {
      return i;
    }
    i += 1;
  }
}

function expectClose(
  tokens: readonly Token[],
  i: number,
  name: string
): number {
  const token = tokens[i];
  if (!(token?.kind === "close" && token.name === name)) {
    throw new PlistShapeError(`it has an unbalanced <${name}>`);
  }
  return i + 1;
}

function expectEnd(tokens: readonly Token[], i: number): void {
  if (skipSpace(tokens, i) !== tokens.length) {
    throw new PlistShapeError("it has content after the root element");
  }
}

/**
 * Reads `<key>`/value pairs up to `</dict>`. Keys are only ever looked up
 * in the dict a caller asks for (Program in the root, HACK_HOME in the
 * root's EnvironmentVariables), never searched across nesting.
 */
function readDictBody(
  tokens: readonly Token[],
  start: number,
  keep: boolean
): { readonly keys: Map<string, PlistValue>; readonly next: number } {
  const keys = new Map<string, PlistValue>();
  let i = start;
  while (true) {
    i = skipSpace(tokens, i);
    const token = tokens[i];
    if (token?.kind === "close" && token.name === "dict") {
      return { keys, next: i + 1 };
    }
    if (!(token?.kind === "open" && token.name === "key")) {
      throw new PlistShapeError("a dict entry is not a <key>");
    }
    const key = readScalar(tokens, i, "key");
    const value = readValue(tokens, skipSpace(tokens, key.next));
    // Key identity is the exact text: launchd neither trims nor knows
    // another spelling. An entity or character reference (`Progr&#97;m`
    // is `Program` to launchd) is not decoded here, so it is unknown.
    const name = key.text;
    if (keep && name.includes("&")) {
      throw new PlistShapeError("a key uses an XML escape");
    }
    if (keep && keys.has(name)) {
      throw new PlistShapeError(`the key ${name} appears twice`);
    }
    if (keep) {
      keys.set(name, value.value);
    }
    i = value.next;
  }
}

function readScalar(
  tokens: readonly Token[],
  start: number,
  name: string
): { readonly text: string; readonly next: number } {
  const body = tokens[start + 1];
  if (body?.kind === "close" && body.name === name) {
    return { text: "", next: start + 2 };
  }
  if (body?.kind !== "text") {
    throw new PlistShapeError(`a <${name}> does not hold plain text`);
  }
  return { text: body.text, next: expectClose(tokens, start + 2, name) };
}

function emptyValue(name: string): PlistValue {
  if (name === "string") {
    return { kind: "string", text: "" };
  }
  if (name === "array") {
    return { kind: "array", first: null };
  }
  if (name === "dict") {
    return { kind: "dict", keys: new Map() };
  }
  if (name === "true" || name === "false") {
    return { kind: "bool", value: name === "true" };
  }
  return { kind: "other" };
}

type ValueRead = { readonly value: PlistValue; readonly next: number };

function readValue(tokens: readonly Token[], start: number): ValueRead {
  const token = tokens[start];
  if (token?.kind === "empty" && EMPTY_VALUE_TAGS.has(token.name)) {
    return { value: emptyValue(token.name), next: start + 1 };
  }
  if (token?.kind !== "open") {
    throw new PlistShapeError("a dict key has no value");
  }
  if (token.name === "dict") {
    // Nested dicts are kept (EnvironmentVariables binds the service's home)
    // and held to the same rules: an escaped or repeated key is unknown.
    const nested = readDictBody(tokens, start + 1, true);
    return {
      value: { kind: "dict", keys: nested.keys },
      next: nested.next,
    };
  }
  if (token.name === "array") {
    return readArray(tokens, start + 1);
  }
  if (!SCALAR_TAGS.has(token.name)) {
    throw new PlistShapeError(`it has an unexpected <${token.name}> value`);
  }
  const scalar = readScalar(tokens, start, token.name);
  const value: PlistValue =
    token.name === "string"
      ? { kind: "string", text: scalar.text }
      : { kind: "other" };
  return { value, next: scalar.next };
}

function readArray(tokens: readonly Token[], start: number): ValueRead {
  let i = start;
  let first: PlistValue | null = null;
  while (true) {
    i = skipSpace(tokens, i);
    const next = tokens[i];
    if (next?.kind === "close" && next.name === "array") {
      return { value: { kind: "array", first }, next: i + 1 };
    }
    const item = readValue(tokens, i);
    first ??= item.value;
    i = item.next;
  }
}
