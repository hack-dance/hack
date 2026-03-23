import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveGlobalConfigPath } from "@lib/config-paths.ts";
import { GLOBAL_CONFIG_FILENAME, GLOBAL_HACK_DIR_NAME } from "@/constants.ts";

const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;

afterEach(() => {
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

test("resolveGlobalConfigPath prefers HOME when no explicit override is set", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe(
    resolve(homedir(), GLOBAL_HACK_DIR_NAME, GLOBAL_CONFIG_FILENAME)
  );
});

test("resolveGlobalConfigPath prefers explicit override", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "/tmp/custom-config.json";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe("/tmp/custom-config.json");
});
