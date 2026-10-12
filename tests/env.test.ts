import { expect, test } from "bun:test";

import { parseDotEnv, serializeDotEnv } from "../src/lib/env.ts";

test("parseDotEnv preserves quoted multiline PEM values", () => {
  const pem = [
    `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`,
    "line-one",
    "line-two",
    `${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`,
  ].join("\n");
  const parsed = parseDotEnv(
    `HACK_GITHUB_APP_PRIVATE_KEY="${pem}"\nOTHER_VALUE=ok\n`
  );

  expect(parsed.HACK_GITHUB_APP_PRIVATE_KEY).toBe(pem);
  expect(parsed.OTHER_VALUE).toBe("ok");
});

test("serializeDotEnv and parseDotEnv round-trip multiline quoted values", () => {
  const pem = [
    `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`,
    String.raw`line\with\slashes`,
    'line"with"quotes',
    `${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`,
  ].join("\n");
  const serialized = serializeDotEnv({
    HACK_GITHUB_APP_PRIVATE_KEY: pem,
    OTHER_VALUE: "ok",
  });
  const parsed = parseDotEnv(serialized);

  expect(parsed.HACK_GITHUB_APP_PRIVATE_KEY).toBe(pem);
  expect(parsed.OTHER_VALUE).toBe("ok");
});

const roundTripCases: ReadonlyArray<{
  readonly name: string;
  readonly value: string;
}> = [
  { name: "a single-quoted value", value: "'abc'" },
  { name: "a leading single quote", value: "'a" },
  { name: "a leading double quote", value: '"a' },
  { name: "a leading tab", value: "\tx" },
  { name: "a trailing tab", value: "x\t" },
  { name: "a trailing carriage return", value: "x\r" },
  { name: "a CRLF inside the value", value: "a\r\nb" },
  {
    name: "a PEM block",
    value: [
      `${"-".repeat(5)}BEGIN PRIVATE KEY${"-".repeat(5)}`,
      "line-one",
      "line-two",
      `${"-".repeat(5)}END PRIVATE KEY${"-".repeat(5)}`,
    ].join("\n"),
  },
  { name: "the empty string", value: "" },
  { name: "a plain single-line value", value: "plain-value_123" },
  { name: "a URL single-line value", value: "postgres://u@db:5432/app?x=1" },
  { name: "an inner-quote single-line value", value: "it's" },
  { name: "a spaced single-line value", value: "hello world" },
];

for (const { name, value } of roundTripCases) {
  test(`serializeDotEnv round-trips ${name} exactly and stably`, () => {
    const first = serializeDotEnv({ VALUE: value, OTHER_VALUE: "ok" });
    const parsed = parseDotEnv(first);

    expect(parsed.VALUE).toBe(value);
    expect(parsed.OTHER_VALUE).toBe("ok");
    expect(serializeDotEnv(parsed)).toBe(first);
  });
}

test("serializeDotEnv keeps existing single-line output byte-identical", () => {
  expect(
    serializeDotEnv({
      PLAIN: "plain-value_123",
      URL: "postgres://u@db:5432/app?x=1",
      INNER_QUOTE: "it's",
      EMPTY: "",
      SPACED: "hello world",
      ESCAPED: String.raw`a"b\c`,
    })
  ).toBe(
    [
      "PLAIN=plain-value_123",
      "URL=postgres://u@db:5432/app?x=1",
      "INNER_QUOTE=it's",
      "EMPTY=",
      'SPACED="hello world"',
      String.raw`ESCAPED="a\"b\\c"`,
      "",
    ].join("\n")
  );
});
