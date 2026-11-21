/**
 * Domain-separated SHA-256 over canonical JSON: the TypeScript twin of
 * `packages/runtime-core/src/canonical_digest.rs`.
 *
 * Both encoders are checked against one vector file
 * (`packages/runtime-core/src/canonical_digest_vectors.json`); a vector that
 * passes in one language and fails in the other is a bug in one of them.
 *
 * Preimage: `domain || 0x00 || canonical_json(value)`; the digest is written
 * `sha256:<64 lowercase hex>`. A domain is `hack.<name>/<version>`; a new use
 * adds a constant and never reuses an existing one.
 *
 * Canonical JSON (the same rules as the Rust module):
 * - no insignificant whitespace; arrays keep their order;
 * - object keys sorted by Unicode code point (UTF-8 byte order), not by the
 *   UTF-16 code units JavaScript compares by default;
 * - numbers must be integers. A `number` must be a safe integer
 *   (within +-(2^53 - 1)); `-0` is written `0`. A larger integer is passed as
 *   a `bigint` and written exactly; a larger `number` is refused, because its
 *   value is not known exactly;
 * - strings are well-formed Unicode (a lone surrogate, which JavaScript can
 *   hold and Rust cannot, is refused), written as UTF-8 with exactly these
 *   escapes: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u00xx` (lowercase
 *   hex) for every other code point below U+0020;
 * - only `null`, booleans, numbers, bigints, strings, arrays without holes and
 *   plain objects with string keys; anything else (undefined, functions, class
 *   instances, symbol keys) is refused.
 *
 * The encoder is pure: no clock, no environment.
 */

/** A digest domain, validated when it is declared. */
export type DigestDomain = string & { readonly __digestDomain: unique symbol };

const DOMAIN = /^hack\.[a-z0-9-]+\/[1-9][0-9]*$/;

/** Declare a domain; throws for a malformed one. */
export function digestDomain(name: string): DigestDomain {
  if (name.length > 64 || !DOMAIN.test(name)) {
    throw new CanonicalValueError("Invalid digest domain.");
  }
  return name as DigestDomain;
}

/** The container specification digest (`io.hack-local.spec`). */
export const CONTAINER_SPEC_DOMAIN = digestDomain("hack.container-spec/1");
/** Stored step keys. */
export const STEP_DOMAIN = digestDomain("hack.step/1");
/** Integrity checks for stored step records. */
export const STEP_RECORD_DOMAIN = digestDomain("hack.step-record/1");

/** A value the encoder refuses; the message never contains the value. */
export class CanonicalValueError extends Error {
  readonly code = "canonical_value";
}

/** The short escapes, by UTF-16 code unit. */
const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertWellFormed(text: string): void {
  if (!text.isWellFormed()) {
    throw new CanonicalValueError(
      "Canonical strings are well-formed Unicode; a lone surrogate is refused."
    );
  }
}

function writeString(text: string, out: string[]): void {
  assertWellFormed(text);
  let result = '"';
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const short = SHORT_ESCAPES.get(unit);
    if (short !== undefined) {
      result += short;
    } else if (unit < 0x20) {
      result += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      result += text[index];
    }
  }
  out.push(`${result}"`);
}

function writeNumber(value: number, out: string[]): void {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalValueError(
      "Canonical numbers are integers within +-(2^53 - 1); pass a bigint for a larger integer."
    );
  }
  out.push(Object.is(value, -0) ? "0" : String(value));
}

/** Compare by Unicode code point, which equals UTF-8 byte order. */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a[index]?.codePointAt(0) ?? 0;
    const y = b[index]?.codePointAt(0) ?? 0;
    if (x !== y) {
      return x - y;
    }
  }
  return a.length - b.length;
}

function writeObject(value: Record<string, unknown>, out: string[]): void {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalValueError("Canonical object keys are strings.");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    assertWellFormed(key);
  }
  keys.sort(compareCodePoints);
  out.push("{");
  keys.forEach((key, index) => {
    if (index > 0) {
      out.push(",");
    }
    writeString(key, out);
    out.push(":");
    write(value[key], out);
  });
  out.push("}");
}

function write(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      writeNumber(value, out);
      return;
    case "bigint":
      out.push(value.toString());
      return;
    case "string":
      writeString(value, out);
      return;
    case "object":
      if (Array.isArray(value)) {
        out.push("[");
        // An index loop, not forEach: forEach skips a hole, which would encode
        // [1, , 3] as [1,3]. A hole is refused.
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) {
            throw new CanonicalValueError("Canonical arrays have no holes.");
          }
          if (index > 0) {
            out.push(",");
          }
          write(value[index], out);
        }
        out.push("]");
        return;
      }
      if (isPlainObject(value)) {
        writeObject(value, out);
        return;
      }
      break;
    default:
      break;
  }
  throw new CanonicalValueError(
    "Canonical values are null, booleans, integers, strings, arrays and plain objects."
  );
}

/** The canonical text of `value`. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

/** `sha256:<hex>` of `domain || 0x00 || canonical_json(value)`. */
export function canonicalDigest(domain: DigestDomain, value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(domain);
  hasher.update(new Uint8Array([0]));
  hasher.update(canonicalJson(value));
  return `sha256:${hasher.digest("hex")}`;
}
