import { afterEach, beforeEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  getGumPath,
  gumChooseMany,
  gumConfirm,
  gumFilterMany,
  gumInput,
  gumVersionCheck,
  resetGumPathCacheForTests,
  tryGumLog,
} from "../src/ui/gum.ts";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixtureGumPath = `${fixturesDir}/gum`;

beforeEach(() => {
  process.env.HACK_GUM_PATH = fixtureGumPath;
  resetGumPathCacheForTests();
});

afterEach(() => {
  process.env.HACK_GUM_PATH = undefined;
  process.env.GUM_FIXTURE_LOG = undefined;
  process.env.GUM_FIXTURE_CONFIRM_EXIT = undefined;
  process.env.GUM_FIXTURE_INPUT_OUTPUT = undefined;
  process.env.GUM_FIXTURE_CHOOSE_OUTPUT = undefined;
  process.env.GUM_FIXTURE_FILTER_OUTPUT = undefined;
  resetGumPathCacheForTests();
});

test("getGumPath prefers HACK_GUM_PATH (fixture)", () => {
  expect(getGumPath()).toBe(fixtureGumPath);
});

test("gumInput returns stdout", async () => {
  process.env.GUM_FIXTURE_INPUT_OUTPUT = "hello";
  const res = await gumInput({ placeholder: "Type something..." });
  expect(res).toEqual({ ok: true, value: "hello" });
});

test("gumConfirm maps exit codes to boolean", async () => {
  process.env.GUM_FIXTURE_CONFIRM_EXIT = "0";
  expect(await gumConfirm({ prompt: "Ok?" })).toEqual({
    ok: true,
    value: true,
  });

  process.env.GUM_FIXTURE_CONFIRM_EXIT = "1";
  expect(await gumConfirm({ prompt: "Ok?" })).toEqual({
    ok: true,
    value: false,
  });
});

test("gumConfirm detects cancel", async () => {
  process.env.GUM_FIXTURE_CONFIRM_EXIT = "130";
  expect(await gumConfirm({ prompt: "Ok?" })).toEqual({
    ok: false,
    reason: "cancelled",
  });
});

test("gumChooseMany parses output delimiter", async () => {
  process.env.GUM_FIXTURE_CHOOSE_OUTPUT = "a,b";
  const res = await gumChooseMany({
    options: ["a", "b"],
    outputDelimiter: ",",
  });
  expect(res).toEqual({ ok: true, value: ["a", "b"] });
});

test("gumFilterMany parses output delimiter", async () => {
  process.env.GUM_FIXTURE_FILTER_OUTPUT = "x|y";
  const res = await gumFilterMany({
    options: ["x", "y"],
    outputDelimiter: "|",
  });
  expect(res).toEqual({ ok: true, value: ["x", "y"] });
});

test("gumVersionCheck maps exit code to boolean", async () => {
  expect(await gumVersionCheck({ constraint: ">=0.0.0" })).toEqual({
    ok: true,
    value: true,
  });
  expect(await gumVersionCheck({ constraint: "fail" })).toEqual({
    ok: true,
    value: false,
  });
});

test("tryGumLog returns true and writes structured args (fixture)", async () => {
  const logFile = `/tmp/hack-cli-gum-fixture-${Date.now()}.log`;
  await Bun.write(logFile, "");
  process.env.GUM_FIXTURE_LOG = logFile;

  const ok = tryGumLog({
    level: "info",
    message: "hello",
    fields: { a: 1, ok: true },
  });
  expect(ok).toBe(true);

  const text = await Bun.file(logFile).text();
  expect(text).toContain("gum log --level info --structured hello a 1 ok true");
});
