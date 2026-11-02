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

/**
 * Stubs `isTTY` on a stream for one test and returns the restore function.
 * When the stream had no own descriptor, the stub is deleted on restore so the
 * value never leaks into other test files sharing this process.
 */
function stubIsTty(opts: {
  readonly stream: NodeJS.ReadStream | NodeJS.WriteStream;
  readonly value: boolean;
}): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(opts.stream, "isTTY");
  Object.defineProperty(opts.stream, "isTTY", {
    configurable: true,
    value: opts.value,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(opts.stream, "isTTY", descriptor);
      return;
    }
    Reflect.deleteProperty(opts.stream, "isTTY");
  };
}

/**
 * HACK-1385: without a TTY and without the explicit opt-out, `confirmSafe`
 * used to enter the clack prompt, whose readline loop never settles on a
 * piped stdin and spins at full CPU. The policy must resolve the answer
 * without touching the prompt, so each case is bounded by a short timeout
 * (the old code path fails these tests by timing out).
 */
async function withNoTty<T>(run: () => Promise<T>): Promise<T> {
  Reflect.deleteProperty(process.env, "HACK_NO_INTERACTIVE");
  setNoInteractiveFlag({ enabled: false });
  const restoreStdin = stubIsTty({ stream: process.stdin, value: false });
  const restoreStdout = stubIsTty({ stream: process.stdout, value: true });
  try {
    expect(canPrompt()).toBe(false);
    return await run();
  } finally {
    restoreStdin();
    restoreStdout();
  }
}

test(
  "confirmSafe without a TTY applies accept-default instead of prompting",
  async () => {
    const started = performance.now();
    const answers = await withNoTty(async () => [
      await confirmSafe({
        message: 'Unset "KEY" from global in default?',
        initialValue: true,
        nonInteractive: "accept-default",
      }),
      await confirmSafe({
        message: "Destroy everything?",
        initialValue: false,
        nonInteractive: "accept-default",
      }),
    ]);
    expect(answers).toEqual([true, false]);
    expect(performance.now() - started).toBeLessThan(1000);
  },
  { timeout: 2000 }
);

test(
  "confirmSafe without a TTY declines instead of prompting",
  async () => {
    const answer = await withNoTty(() =>
      confirmSafe({
        message: "Trust CA in the System keychain? (requires sudo)",
        initialValue: true,
        nonInteractive: "decline",
      })
    );
    expect(answer).toBe(false);
  },
  { timeout: 2000 }
);

test(
  "confirmSafe without a TTY fails closed with the scriptable hint",
  async () => {
    let caught: unknown = null;
    await withNoTty(async () => {
      try {
        await confirmSafe({
          message: "Delete it?",
          initialValue: false,
          nonInteractive: "fail",
          hint: "Pass --yes to script this.",
        });
      } catch (error: unknown) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(HackCliError);
    const err = caught as HackCliError;
    expect(err.code).toBe("E_INTERACTIVE_REQUIRED");
    expect(err.message).toContain("no TTY");
    expect(err.message).toContain("--yes");
  },
  { timeout: 2000 }
);

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
