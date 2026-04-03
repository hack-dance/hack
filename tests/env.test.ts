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
