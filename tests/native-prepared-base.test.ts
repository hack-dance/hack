import { expect, test } from "bun:test";
import {
  parseNativePreparedBase,
  preparedBaseArguments,
} from "../src/backends/native-prepared-base.ts";

test("prepared base is off unless a mode is selected", () => {
  expect(parseNativePreparedBase({})).toBeUndefined();
  expect(
    parseNativePreparedBase({ HACK_NATIVE_PREPARED_BASE: "" })
  ).toBeUndefined();
  expect(
    parseNativePreparedBase({ HACK_NATIVE_PREPARED_BASE: "off" })
  ).toBeUndefined();
  expect(preparedBaseArguments(undefined)).toEqual([]);
});

test("prefer and require forward an optional absolute store", () => {
  const prefer = parseNativePreparedBase({
    HACK_NATIVE_PREPARED_BASE: "prefer",
  });
  expect(prefer).toEqual({ mode: "prefer" });
  expect(preparedBaseArguments(prefer)).toEqual(["--prepared-base", "prefer"]);
  const require = parseNativePreparedBase({
    HACK_NATIVE_PREPARED_BASE: "require",
    HACK_NATIVE_PREPARED_BASE_STORE: "/private/prepared-bases",
  });
  expect(preparedBaseArguments(require)).toEqual([
    "--prepared-base",
    "require",
    "--prepared-base-store",
    "/private/prepared-bases",
  ]);
});

test("invalid selections are refused before any runtime effect", () => {
  for (const env of [
    { HACK_NATIVE_PREPARED_BASE: "always" },
    { HACK_NATIVE_PREPARED_BASE: "Prefer" },
    { HACK_NATIVE_PREPARED_BASE_STORE: "/private/prepared-bases" },
    { HACK_NATIVE_PREPARED_BASE: "off", HACK_NATIVE_PREPARED_BASE_STORE: "/s" },
    {
      HACK_NATIVE_PREPARED_BASE: "prefer",
      HACK_NATIVE_PREPARED_BASE_STORE: "relative",
    },
  ]) {
    expect(() => parseNativePreparedBase(env)).toThrow();
  }
});
