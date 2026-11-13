import { expect, test } from "bun:test";
import {
  interpolateComposeEnvironment,
  parseComposeEnvironmentFile,
} from "../src/backends/native-compose-env-syntax.ts";

const SENTINEL = "synthetic-private-environment-canary";
const variables: Readonly<Record<string, string>> = {
  SET: SENTINEL,
  EMPTY: "",
  OTHER: "second",
};
const lookup = (name: string) =>
  Object.hasOwn(variables, name) ? variables[name] : undefined;

test.each([
  ["$SET/${SET}", `${SENTINEL}/${SENTINEL}`],
  ["${SET:-fallback}", SENTINEL],
  ["${EMPTY:-fallback}", "fallback"],
  ["${EMPTY-fallback}", ""],
  ["${MISSING-fallback}", "fallback"],
  ["${SET:+yes}${EMPTY:+no}${EMPTY+set}", "yesset"],
  ["${MISSING:-${EMPTY:-${OTHER}}}", "second"],
  ["$$SET/$5/end$", "$SET/$5/end$"],
  ["${EMPTY?not used}", ""],
  ["${SET:?not used}", SENTINEL],
])("Compose interpolation %s", (text, expected) => {
  expect(interpolateComposeEnvironment({ text, lookup })).toBe(expected);
});

test.each([
  `\u0000${SENTINEL}`,
  `\${MISSING:?${SENTINEL}}`,
  `\${EMPTY:?${SENTINEL}}`,
  `\${MISSING?${SENTINEL}}`,
  `\${SET/old/${SENTINEL}}`,
  "${SET",
  "${A:-${A:-${A:-${A:-${A:-${A}}}}}}",
  "${SET:-${A:-${A:-${A:-${A}}}}}",
])("refusals omit authored error words and private values", (text) => {
  try {
    interpolateComposeEnvironment({ text, lookup });
    throw new Error("unexpected success");
  } catch (error) {
    expect(String(error)).toContain("values omitted");
    expect(String(error)).not.toContain(SENTINEL);
  }
});

test("four nested expressions are admitted at the declared depth bound", () => {
  expect(
    interpolateComposeEnvironment({
      text: "${A:-${A:-${A:-${OTHER}}}}",
      lookup,
    })
  ).toBe("second");
});

test("Compose quote delimiters and octal escapes follow the pinned parser", () => {
  const result = parseComposeEnvironmentFile({
    text: String.raw`OCTAL="\0123/\x41/\u0041"
SINGLE='a\\'
DOUBLE="a\\"
`,
    lookup,
  });
  expect(Object.fromEntries(result)).toEqual({
    OCTAL: "S/\\x41/\\u0041",
    SINGLE: "a\\\\",
    DOUBLE: "a\\",
  });
});

test("Compose dotenv quoting, comments, multiline values and sequential lookups", () => {
  const result = parseComposeEnvironmentFile({
    text: [
      "# comment",
      "export FIRST=one # comment",
      "SECOND=${FIRST}",
      "FIRST=two",
      "THIRD=${FIRST}",
      "EXTERNAL=${SET}",
      "COLON: value",
      "HASH=a#literal",
      "QUOTE='${SET} # literal'",
      'MULTI="line1',
      'line2\\tvalue" # comment',
      'ESCAPED="\\$SET/$$SET"',
      'LITERAL="{\\"key\\": \\"value\\"}"',
      "BARE",
      "EMPTY=",
      "__proto__=own",
      "",
    ].join("\n"),
    lookup,
  });
  expect(Object.fromEntries(result)).toEqual({
    FIRST: "two",
    SECOND: "one",
    THIRD: "two",
    EXTERNAL: SENTINEL,
    COLON: "value",
    HASH: "a#literal",
    QUOTE: "${SET} # literal",
    MULTI: "line1\nline2\tvalue",
    ESCAPED: "$SET/$SET",
    LITERAL: '{"key": "value"}',
    EMPTY: "",
    ["__proto__"]: "own",
  });
  expect(result.has("BARE")).toBe(false);
  expect(result.get("__proto__")).toBe("own");
});

test("lookup takes precedence, current file overrides earlier files, unresolved bare does not erase", () => {
  const result = parseComposeEnvironmentFile({
    text: "FIRST=new\nCOPY=${FIRST}\nKEPT\nSET\nFROM_PROJECT=${SET}\n",
    initial: new Map([
      ["FIRST", "earlier"],
      ["KEPT", "earlier"],
    ]),
    lookup,
  });
  expect(Object.fromEntries(result)).toEqual({
    FIRST: "new",
    COPY: "new",
    KEPT: "earlier",
    SET: SENTINEL,
    FROM_PROJECT: SENTINEL,
  });
});

test("raw leaves dollar references, quote characters and comments literal", () => {
  expect(
    Object.fromEntries(
      parseComposeEnvironmentFile({
        text: 'A="${SET}" # text\nB= $SET \n',
        raw: true,
        lookup,
      })
    )
  ).toEqual({ A: '"${SET}" # text', B: " $SET " });
});

test("pinned Compose removes the escaped single-quote delimiter backslash", () => {
  expect(
    parseComposeEnvironmentFile({ text: "A='it\\'s'\n", lookup }).get("A")
  ).toBe("it's");
});

test("raw does not accept a colon separator before an equals in the value", () => {
  expect(() =>
    parseComposeEnvironmentFile({ text: "KEY: a=b\n", raw: true, lookup })
  ).toThrow("values omitted");
});

test.each([
  `BAD KEY=${SENTINEL}`,
  `BROKEN='${SENTINEL}`,
  `A="${SENTINEL}"garbage`,
  "\n".repeat(4097),
  `A=${"a".repeat(256 * 1024)}`,
])("malformed or over-budget dotenv never echoes contents", (text) => {
  expect(() => parseComposeEnvironmentFile({ text, lookup })).toThrow(
    "values omitted"
  );
});
