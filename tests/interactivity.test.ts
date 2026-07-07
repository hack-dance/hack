import { afterEach, expect, test } from "bun:test";

import { HackCliError } from "../src/lib/cli-result.ts";
import {
  canPrompt,
  confirmSafe,
  requireInteractive,
  resetNoInteractiveFlagForTests,
  setNoInteractiveFlag,
} from "../src/lib/interactivity.ts";

const originalNoInteractive = process.env.HACK_NO_INTERACTIVE;

afterEach(() => {
  resetNoInteractiveFlagForTests();
  if (originalNoInteractive === undefined) {
    Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  } else {
    process.env.HACK_NO_INTERACTIVE = originalNoInteractive;
  }
});

test("canPrompt is false when HACK_NO_INTERACTIVE is set", () => {
  process.env.HACK_NO_INTERACTIVE = "1";
  expect(canPrompt()).toBe(false);
});

test("canPrompt is false when the --no-interactive flag is set", () => {
  Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  setNoInteractiveFlag({ enabled: true });
  expect(canPrompt()).toBe(false);
});

test("canPrompt requires a TTY on stdin and stdout", () => {
  Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  setNoInteractiveFlag({ enabled: false });
  const expected =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  expect(canPrompt()).toBe(expected);
});

test("requireInteractive throws E_INTERACTIVE_REQUIRED with the hint", () => {
  let caught: unknown = null;
  try {
    requireInteractive({
      what: "hack init needs a project name",
      hint: "Use `hack init --auto`.",
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HackCliError);
  const err = caught as HackCliError;
  expect(err.code).toBe("E_INTERACTIVE_REQUIRED");
  expect(err.message).toContain("hack init needs a project name");
  expect(err.message).toContain("hack init --auto");
  expect(err.message).toContain("--no-interactive");
});

test("confirmSafe accept-default answers with the documented default", async () => {
  process.env.HACK_NO_INTERACTIVE = "1";
  expect(
    await confirmSafe({
      message: "Proceed?",
      initialValue: true,
      nonInteractive: "accept-default",
    })
  ).toBe(true);
  expect(
    await confirmSafe({
      message: "Destroy everything?",
      initialValue: false,
      nonInteractive: "accept-default",
    })
  ).toBe(false);
});

test("confirmSafe decline answers false regardless of the default", async () => {
  process.env.HACK_NO_INTERACTIVE = "1";
  expect(
    await confirmSafe({
      message: "Trust CA in the System keychain? (requires sudo)",
      initialValue: true,
      nonInteractive: "decline",
    })
  ).toBe(false);
});

test("confirmSafe fail policy raises E_INTERACTIVE_REQUIRED", async () => {
  process.env.HACK_NO_INTERACTIVE = "1";
  let caught: unknown = null;
  try {
    await confirmSafe({
      message: "Pick something",
      initialValue: true,
      nonInteractive: "fail",
      hint: "Pass --thing to script this.",
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HackCliError);
  expect((caught as HackCliError).code).toBe("E_INTERACTIVE_REQUIRED");
  expect((caught as HackCliError).message).toContain("--thing");
});
