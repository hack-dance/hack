import { expect, test } from "bun:test";
import { parseComposeEnvironmentFile } from "../src/backends/native-compose-env-syntax.ts";

/**
 * Dotenv grammar parity with Docker Compose (HACK-2062 follow-up).
 *
 * Each `env` expectation was recorded with Docker Compose v5.6.1:
 * `docker compose config --format json` for a service whose `env_file` holds
 * the row's text, with an interpolation `.env` of `SETV=val` and `EMPTYV=`
 * (`UNSETV` is never set). `config` prints a literal `$` as `$$`; the recorded
 * values are unescaped. `error: true` means Compose refused the file too.
 * `refused` rows are deliberate, documented differences where Hack refuses
 * input Compose accepts (see docs/native/environment-files.md). Values here
 * are synthetic.
 */
type Expected =
  | { readonly env: Readonly<Record<string, string>> }
  | { readonly error: true }
  | { readonly refused: string };

const context: Readonly<Record<string, string>> = { SETV: "val", EMPTYV: "" };
const lookup = (name: string) =>
  Object.hasOwn(context, name) ? context[name] : undefined;

const CASES: readonly (readonly [string, string, Expected])[] = [
  ["plain", "A=plain", { env: { A: "plain" } }],
  ["spaces around value", "A=  spaced value  ", { env: { A: "spaced value" } }],
  ["spaces around equals", "A = b", { env: { A: "b" } }],
  ["leading whitespace", "   A=b", { env: { A: "b" } }],
  ["colon separator", "A: b", { env: { A: "b" } }],
  ["colon no space", "A:b", { env: { A: "b" } }],
  [
    "single quoted literal",
    "A='lit $SETV ${SETV} \\n'",
    { env: { A: "lit $SETV ${SETV} \\n" } },
  ],
  [
    "double quoted interpolates",
    'A="x $SETV ${SETV}"',
    { env: { A: "x val val" } },
  ],
  [
    "double escapes",
    'A="n\\nt\\tq\\"b\\\\d\\$SETV"',
    { env: { A: 'n\nt\tq"b\\d$SETV' } },
  ],
  ["double unknown escape", 'A="\\q\\x41"', { env: { A: "\\q\\x41" } }],
  ["single escaped quote", "A='it\\'s'", { env: { A: "it's" } }],
  ["quoted then comment", 'A="v" # c', { env: { A: "v" } }],
  [
    "quoted then garbage",
    'A="v"x',
    { refused: "Compose drops text after a closing quote" },
  ],
  ["unterminated double", 'A="v', { error: true }],
  ["unterminated single", "A='v", { error: true }],
  ["export prefix", "export A=1", { env: { A: "1" } }],
  ["export many spaces", "export    A=1", { env: { A: "1" } }],
  ["export tab", "export\tA=1", { env: { A: "1" } }],
  ["export bare known", "export SETV", { env: { SETV: "val" } }],
  ["key named export", "export=1", { env: { export: "1" } }],
  ["inline comment space", "A=val # c", { env: { A: "val" } }],
  ["inline comment tab", "A=val\t# c", { env: { A: "val\t# c" } }],
  ["hash without space", "A=val#c", { env: { A: "val#c" } }],
  ["value starts with hash", "A=#c", { env: { A: "#c" } }],
  ["space then hash only", "A= # c", { env: { A: "# c" } }],
  ["full line comment", "# A=1\nB=2", { env: { B: "2" } }],
  ["indented comment", "   # A=1\nB=2", { env: { B: "2" } }],
  ["multiline double", 'A="l1\nl2"', { env: { A: "l1\nl2" } }],
  ["multiline single", "A='l1\nl2'", { env: { A: "l1\nl2" } }],
  ["backslash newline in double", 'A="l1\\\nl2"', { env: { A: "l1\\\nl2" } }],
  ["empty", "A=", { env: { A: "" } }],
  ["empty double quotes", 'A=""', { env: { A: "" } }],
  ["empty single quotes", "A=''", { env: { A: "" } }],
  ["bare unset", "UNSETV", { env: {} }],
  ["bare from context", "SETV", { env: { SETV: "val" } }],
  ["bare empty context", "EMPTYV", { env: { EMPTYV: "" } }],
  ["unbraced", "A=$SETV/$UNSETV/end", { env: { A: "val//end" } }],
  ["dollar escape", "A=$$SETV", { env: { A: "$SETV" } }],
  ["lone dollar", "A=a$", { env: { A: "a$" } }],
  ["dollar digit", "A=$5", { env: { A: "$5" } }],
  [":- set", "A=${SETV:-x}", { env: { A: "val" } }],
  [":- empty", "A=${EMPTYV:-x}", { env: { A: "x" } }],
  [":- unset", "A=${UNSETV:-x}", { env: { A: "x" } }],
  ["- set", "A=${SETV-x}", { env: { A: "val" } }],
  ["- empty", "A=${EMPTYV-x}", { env: { A: "" } }],
  ["- unset", "A=${UNSETV-x}", { env: { A: "x" } }],
  [":? set", "A=${SETV:?err}", { env: { A: "val" } }],
  [":? empty", "A=${EMPTYV:?err}", { error: true }],
  [":? unset", "A=${UNSETV:?err}", { error: true }],
  ["? set", "A=${SETV?err}", { env: { A: "val" } }],
  ["? empty", "A=${EMPTYV?err}", { env: { A: "" } }],
  ["? unset", "A=${UNSETV?err}", { error: true }],
  [":+ set", "A=${SETV:+y}", { env: { A: "y" } }],
  [":+ empty", "A=${EMPTYV:+y}", { env: { A: "" } }],
  ["+ empty", "A=${EMPTYV+y}", { env: { A: "y" } }],
  ["+ unset", "A=${UNSETV+y}", { env: { A: "" } }],
  ["default with spaces", "A=${UNSETV:-a b}", { env: { A: "a b" } }],
  ["nested default", "A=${UNSETV:-${SETV}}", { env: { A: "val" } }],
  ["default in double quotes", 'A="${UNSETV:-x y}"', { env: { A: "x y" } }],
  [
    "default in single quotes",
    "A='${UNSETV:-x}'",
    { env: { A: "${UNSETV:-x}" } },
  ],
  ["earlier line reference", "B=one\nA=${B}", { env: { A: "one", B: "one" } }],
  ["later line not visible", "A=${C}\nC=late", { env: { A: "", C: "late" } }],
  ["duplicate last wins", "A=1\nA=2", { env: { A: "2" } }],
  ["crlf", "A=1\r\nB=2\r\n", { env: { A: "1", B: "2" } }],
  ["bom", "﻿A=1", { env: { A: "1" } }],
  ["dotted key", "A.B=1", { refused: "identifiers only" }],
  ["dashed key", "A-B=1", { refused: "identifiers only" }],
  ["leading digit key", "1A=1", { refused: "identifiers only" }],
  ["unquoted trailing quote", "A=a'b", { env: { A: "a'b" } }],
  ["unquoted inner double quote", 'A=a"b"', { env: { A: 'a"b"' } }],
  ["tab then hash", "A=val\t#c", { env: { A: "val\t#c" } }],
  ["space tab hash", "A=val \t# c", { env: { A: "val \t# c" } }],
  ["trailing tab", "A=val\t", { env: { A: "val" } }],
  ["trailing spaces", "A=val   ", { env: { A: "val" } }],
  ["leading tab value", "A=\tval", { env: { A: "val" } }],
  ["single quoted then tab comment", "A='v'\t# c", { env: { A: "v" } }],
  ["double quoted then tab comment", 'A="v"\t# c', { env: { A: "v" } }],
  [
    "single quoted then garbage",
    "A='v'x",
    { refused: "Compose drops text after a closing quote" },
  ],
  ["export with comment", "export A=1 # c", { env: { A: "1" } }],
  ["colon with comment", "A: b # c", { env: { A: "b" } }],
  ["unbraced then comment", "A=$SETV # c", { env: { A: "val" } }],
  ["default containing hash", "A=${UNSETV:-a#b}", { env: { A: "a#b" } }],
  ["default containing space hash", "A=${UNSETV:-a #b}", { error: true }],
  ["double quoted hash", 'A="a # b"', { env: { A: "a # b" } }],
  ["escaped dollar unquoted", "A=\\$SETV", { env: { A: "\\val" } }],
  ["octal in single", "A='\\0101'", { env: { A: "\\0101" } }],
];

test.each(CASES)("Compose dotenv parity: %s", (_name, text, expected) => {
  const parse = () =>
    parseComposeEnvironmentFile({
      text: text.endsWith("\n") ? text : `${text}\n`,
      lookup,
    });
  if ("env" in expected) {
    expect(Object.fromEntries(parse())).toEqual(expected.env);
    return;
  }
  // Refusals are closed: they never echo the input.
  expect(parse).toThrow("values omitted");
});
