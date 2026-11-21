import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CanonicalValueError,
  canonicalDigest,
  canonicalJson,
  digestDomain,
  STEP_DOMAIN,
} from "../src/lib/canonical-digest.ts";

type Vector = {
  readonly name: string;
  readonly domain: string;
  readonly canonical: string;
  readonly sha256: string;
  readonly input_text: string;
};
type Refused = { readonly name: string; readonly input: string };

const file = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dir,
      "../packages/runtime-core/src/canonical_digest_vectors.json"
    ),
    "utf8"
  )
) as {
  readonly schema: string;
  readonly vectors: readonly Vector[];
  readonly refused: readonly Refused[];
};

/**
 * JSON text to a value without losing integers: an integer literal outside the
 * safe range becomes a bigint, as the vector file asks of a twin whose JSON
 * numbers are doubles. A literal with a fraction or exponent stays a number,
 * as serde_json reads it as a float. Test-only; the strings it accepts are
 * those of the vector file.
 */
function parseLossless(text: string): unknown {
  let at = 0;
  const fail = (): never => {
    throw new Error(`Bad vector JSON at ${at}`);
  };
  const space = (): void => {
    while (/\s/.test(text[at] ?? "")) {
      at++;
    }
  };
  const value = (): unknown => {
    space();
    const char = text[at];
    if (char === "{") {
      at++;
      const result: Record<string, unknown> = {};
      space();
      if (text[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        space();
        const key = value();
        if (typeof key !== "string") {
          fail();
        }
        space();
        if (text[at++] !== ":") {
          fail();
        }
        result[key as string] = value();
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at++] !== "}") {
          fail();
        }
        return result;
      }
    }
    if (char === "[") {
      at++;
      const result: unknown[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value());
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at++] !== "]") {
          fail();
        }
        return result;
      }
    }
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = at;
      const match = end.exec(text) ?? fail();
      at = end.lastIndex;
      return JSON.parse((match as RegExpExecArray)[0]);
    }
    const literal = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null/y;
    literal.lastIndex = at;
    const match = (literal.exec(text) ?? fail()) as RegExpExecArray;
    at = literal.lastIndex;
    const token = match[0];
    if (token === "true" || token === "false" || token === "null") {
      return JSON.parse(token);
    }
    const integer = match[1] === undefined && match[2] === undefined;
    if (integer && !Number.isSafeInteger(Number(token))) {
      return BigInt(token);
    }
    return Number(token);
  };
  const result = value();
  space();
  if (at !== text.length) {
    fail();
  }
  return result;
}

describe("canonical digest, shared vectors", () => {
  test("the vector file is the one the Rust encoder reads", () => {
    expect(file.schema).toBe("hack.canonical-digest-vectors/1");
    expect(file.vectors.length).toBeGreaterThan(0);
    expect(file.refused.length).toBeGreaterThan(0);
  });

  for (const vector of file.vectors) {
    test(`vector: ${vector.name}`, () => {
      const value = parseLossless(vector.input_text);
      expect(canonicalJson(value)).toBe(vector.canonical);
      expect(canonicalDigest(digestDomain(vector.domain), value)).toBe(
        vector.sha256
      );
    });
  }

  for (const refused of file.refused) {
    test(`refused: ${refused.name}`, () => {
      expect(() => canonicalJson(parseLossless(refused.input))).toThrow(
        CanonicalValueError
      );
    });
  }
});

describe("canonical digest, TypeScript-only inputs", () => {
  test("a lone surrogate is refused in strings and keys", () => {
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalValueError);
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow(CanonicalValueError);
    expect(canonicalJson("😀")).toBe('"😀"');
  });

  test("an unsafe number is refused, the same value as a bigint is exact", () => {
    expect(() => canonicalJson(2 ** 53)).toThrow(CanonicalValueError);
    expect(canonicalJson(2n ** 53n)).toBe("9007199254740992");
    expect(canonicalJson(-0)).toBe("0");
  });

  test("values JSON.stringify would drop or coerce are refused", () => {
    for (const value of [
      undefined,
      () => 1,
      Symbol("x"),
      new Date(0),
      new Map(),
      [undefined],
      { a: undefined },
      Number.NaN,
    ]) {
      expect(() => canonicalJson(value)).toThrow(CanonicalValueError);
    }
  });

  test("malformed domains are refused", () => {
    for (const name of [
      "hack.step",
      "hack.step/0",
      "hack.Step/1",
      "step/1",
      "hack./1",
      `hack.${"a".repeat(60)}/1`,
    ]) {
      expect(() => digestDomain(name)).toThrow(CanonicalValueError);
    }
    expect(STEP_DOMAIN).toBe(digestDomain("hack.step/1"));
  });

  test("the refusal message never contains the value", () => {
    const secret = "sentinel-value-4b1f";
    try {
      canonicalJson({ [`${secret}\ud800`]: 1 });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
