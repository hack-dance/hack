import { expect, test } from "bun:test";

import { parseDotEnv, serializeDotEnv } from "../src/lib/env.ts";

test("parseDotEnv preserves quoted multiline PEM values", () => {
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    "line-one",
    "line-two",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const parsed = parseDotEnv(
    `HACK_GITHUB_APP_PRIVATE_KEY="${pem}"\nOTHER_VALUE=ok\n`
  );

  expect(parsed.HACK_GITHUB_APP_PRIVATE_KEY).toBe(pem);
  expect(parsed.OTHER_VALUE).toBe("ok");
});

test("serializeDotEnv and parseDotEnv round-trip multiline quoted values", () => {
  const pem = [
    "-----BEGIN PRIVATE KEY-----",
    String.raw`line\with\slashes`,
    'line"with"quotes',
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const serialized = serializeDotEnv({
    HACK_GITHUB_APP_PRIVATE_KEY: pem,
    OTHER_VALUE: "ok",
  });
  const parsed = parseDotEnv(serialized);

  expect(parsed.HACK_GITHUB_APP_PRIVATE_KEY).toBe(pem);
  expect(parsed.OTHER_VALUE).toBe("ok");
});
