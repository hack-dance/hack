import { COMPOSE_PROJECT_NAME_VARIABLE } from "./native-compose-project-name.ts";

/**
 * Predict the value native execution compiles one Compose string to, before
 * any runtime work.
 *
 * Native execution resolves Compose interpolation itself (runtime-core
 * `project::inputs::Resolver`) from an explicit map: no process environment or
 * dotenv file is consulted, and the only bound name is `COMPOSE_PROJECT_NAME`
 * (the reviewed Compose project name). Every other reference is therefore
 * unset: `${NAME:-word}` selects `word`, `${NAME:+word}` selects nothing, and
 * `$NAME` or `${NAME}` refuses at execution.
 *
 * This mirrors that grammar exactly: `$$` escapes, braced `:-` and `:+`
 * operators whose words hold literal text, `$$` and nested braced expressions
 * (at most four levels), and unbraced references. It returns null whenever
 * native execution would refuse the text or the value is not knowable yet: a
 * required reference, unsupported syntax, a Hack-managed name (delivered
 * privately and never interpolated), or `COMPOSE_PROJECT_NAME`, which is bound
 * only after review. Callers must treat null as "unknown" and leave the final
 * decision to native review and execution, which stay the authority.
 */
export function resolveNativeComposeText(opts: {
  readonly text: string;
  /** Names Hack delivers privately to the service; a reference refuses. */
  readonly managed?: ReadonlySet<string>;
}): string | null {
  if (opts.text.length > MAX_TEXT) {
    return null;
  }
  try {
    return resolve(opts.text, opts.managed ?? EMPTY);
  } catch (error) {
    if (error === UNKNOWN) {
      return null;
    }
    throw error;
  }
}

const MAX_TEXT = 64 * 1024;
/** Compose nesting such as `${A:-${B:-${C:-${D:-word}}}}` is bounded at four levels. */
const MAX_DEPTH = 4;
const EMPTY: ReadonlySet<string> = new Set();
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_BYTE = /[A-Za-z0-9_]/;
/** Thrown internally for any text whose native value is not knowable here. */
const UNKNOWN = Symbol("unknown");

function unknown(): never {
  throw UNKNOWN;
}

/**
 * Validate a referenced name exactly as the runtime does before lookup. A live
 * reference to the project name is unknown here; elsewhere it is irrelevant.
 */
function checked(
  name: string,
  managed: ReadonlySet<string>,
  live: boolean
): void {
  if (
    !VARIABLE.test(name) ||
    managed.has(name) ||
    (live && name === COMPOSE_PROJECT_NAME_VARIABLE)
  ) {
    unknown();
  }
}

/** Index of the `}` closing a body that follows `${`, as the runtime counts it. */
function bracedEnd(text: string): number {
  let depth = 1;
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("$$", index)) {
      index += 2;
      continue;
    }
    if (text.startsWith("${", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return unknown();
}

function resolve(text: string, managed: ReadonlySet<string>): string {
  let result = "";
  let rest = text;
  for (;;) {
    const index = rest.indexOf("$");
    if (index < 0) {
      return result + rest;
    }
    result += rest.slice(0, index);
    rest = rest.slice(index + 1);
    if (rest.startsWith("$")) {
      result += "$";
      rest = rest.slice(1);
      continue;
    }
    if (rest.startsWith("{")) {
      const body = rest.slice(1);
      const end = bracedEnd(body);
      result += expression(body.slice(0, end), 1, true, managed);
      rest = body.slice(end + 1);
      continue;
    }
    // An unbraced reference is always required, and no supplied value exists.
    let end = 0;
    while (end < rest.length && NAME_BYTE.test(rest[end] ?? "")) {
      end += 1;
    }
    checked(rest.slice(0, end), managed, true);
    return unknown();
  }
}

/**
 * One braced body. `live` is false inside a word the operator does not select:
 * it is still validated, but a missing input there is not required.
 */
function expression(
  body: string,
  depth: number,
  live: boolean,
  managed: ReadonlySet<string>
): string {
  const colon = body.indexOf(":");
  if (colon < 0) {
    checked(body, managed, live);
    // A live bare reference is required; nothing is supplied.
    return live ? unknown() : "";
  }
  const name = body.slice(0, colon);
  const suffix = body.slice(colon + 1);
  if (suffix === "") {
    return unknown();
  }
  checked(name, managed, live);
  const operator = suffix[0];
  if (operator !== "+" && operator !== "-") {
    return unknown();
  }
  // Every checked name is unset, so `:-` selects its word and `:+` does not.
  const selected = operator === "-";
  const value = word(suffix.slice(1), depth, live && selected, managed);
  return selected ? value : "";
}

/** Literal text, `$$` escapes and nested braced expressions only. */
function word(
  text: string,
  depth: number,
  live: boolean,
  managed: ReadonlySet<string>
): string {
  let result = "";
  let rest = text;
  for (;;) {
    const found = rest.indexOf("$");
    const index = found < 0 ? rest.length : found;
    const literal = rest.slice(0, index);
    if (literal.includes("{") || literal.includes("}")) {
      return unknown();
    }
    if (live) {
      result += literal;
    }
    if (index === rest.length) {
      return result;
    }
    rest = rest.slice(index + 1);
    if (rest.startsWith("$")) {
      if (live) {
        result += "$";
      }
      rest = rest.slice(1);
      continue;
    }
    if (!rest.startsWith("{") || depth >= MAX_DEPTH) {
      return unknown();
    }
    const body = rest.slice(1);
    const end = bracedEnd(body);
    result += expression(body.slice(0, end), depth + 1, live, managed);
    rest = body.slice(end + 1);
  }
}
