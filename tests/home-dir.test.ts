import { afterEach, expect, test } from "bun:test";

import {
  normalizeHomeDir,
  readHackHomeOverride,
  readHomeEnv,
  resolveUserHomeDir,
} from "@lib/home-dir.ts";
import { restoreEnv } from "./helpers/env.ts";

const originalHome = process.env.HOME;
const originalHackHome = process.env.HACK_HOME;

afterEach(() => {
  restoreEnv("HOME", originalHome);
  restoreEnv("HACK_HOME", originalHackHome);
});

test("normalizeHomeDir accepts only absolute paths", () => {
  expect(normalizeHomeDir(undefined)).toBeNull();
  expect(normalizeHomeDir("")).toBeNull();
  expect(normalizeHomeDir("  ")).toBeNull();
  expect(normalizeHomeDir("relative")).toBeNull();
  expect(normalizeHomeDir("./relative")).toBeNull();
  expect(normalizeHomeDir("~/home")).toBeNull();
  expect(normalizeHomeDir(" /tmp/home/ ")).toBe("/tmp/home");
});

test("readHomeEnv ignores empty and relative HOME", () => {
  process.env.HOME = "";
  expect(readHomeEnv()).toBeNull();
  process.env.HOME = "relative";
  expect(readHomeEnv()).toBeNull();
  process.env.HOME = "/tmp/hack-home";
  expect(readHomeEnv()).toBe("/tmp/hack-home");
});

test("resolveUserHomeDir prefers an absolute HOME", () => {
  process.env.HOME = "/tmp/hack-home";
  expect(resolveUserHomeDir({ osHomedir: () => "/tmp/os-home" })).toBe(
    "/tmp/hack-home"
  );
});

test("resolveUserHomeDir falls back to os.homedir for empty or relative HOME", () => {
  for (const home of ["", "relative"]) {
    process.env.HOME = home;
    expect(resolveUserHomeDir({ osHomedir: () => "/tmp/os-home" })).toBe(
      "/tmp/os-home"
    );
  }
});

test("resolveUserHomeDir refuses when no absolute home is available", () => {
  process.env.HOME = "relative";
  // Bun's os.homedir() echoes a relative HOME back; it must not be used.
  expect(() => resolveUserHomeDir({ osHomedir: () => "relative" })).toThrow(
    /HOME is empty or not an absolute path/
  );
  expect(() => resolveUserHomeDir({ osHomedir: () => "" })).toThrow(
    /HOME is empty or not an absolute path/
  );
  expect(() =>
    resolveUserHomeDir({
      osHomedir: () => {
        throw new Error("no passwd entry");
      },
    })
  ).toThrow(/HOME is empty or not an absolute path/);
});

test("readHackHomeOverride treats empty as unset and refuses relative", () => {
  Reflect.deleteProperty(process.env, "HACK_HOME");
  expect(readHackHomeOverride()).toBeNull();
  process.env.HACK_HOME = " ";
  expect(readHackHomeOverride()).toBeNull();
  process.env.HACK_HOME = "/tmp/hack-isolated";
  expect(readHackHomeOverride()).toBe("/tmp/hack-isolated");
  process.env.HACK_HOME = "relative";
  expect(() => readHackHomeOverride()).toThrow(
    /HACK_HOME must be an absolute path/
  );
});
