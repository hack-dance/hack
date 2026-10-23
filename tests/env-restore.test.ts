import { expect, test } from "bun:test";
import { restoreEnv } from "./helpers/env.ts";

test("restoreEnv preserves missing, empty, and defined environment values", () => {
  const key = "HACK_TEST_ENV_RESTORE";
  const original = process.env[key];
  try {
    process.env[key] = "temporary";
    restoreEnv(key, undefined);
    expect(process.env[key]).toBeUndefined();
    expect(Object.hasOwn(process.env, key)).toBe(false);

    restoreEnv(key, "");
    expect(process.env[key]).toBe("");

    restoreEnv(key, "saved");
    expect(process.env[key]).toBe("saved");
  } finally {
    restoreEnv(key, original);
  }
});
