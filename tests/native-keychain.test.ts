import { expect, test } from "bun:test";

import { CliUsageError } from "../src/cli/command.ts";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  hasAbandonedNativeKeychainCall,
  NATIVE_KEYCHAIN_TIMEOUT_ENV,
  NATIVE_KEYCHAIN_TIMEOUT_MAX_MS,
  NATIVE_KEYCHAIN_TIMEOUT_MS,
  NativeKeychainTimeoutError,
  resolveNativeKeychainTimeoutMs,
  withNativeKeychainDeadline,
} from "../src/lib/native-keychain.ts";

/**
 * Deadline unit checks. No real keychain is reached: `run` is a stand-in that
 * never settles, like a keychain call blocked on an absent desktop session.
 */

test("a keychain call that never answers fails closed and is recorded", async () => {
  const name = `kc-${crypto.randomUUID()}`;
  const started = performance.now();
  let caught: unknown;
  try {
    await withNativeKeychainDeadline({
      operation: "set",
      run: () => new Promise<void>(() => undefined),
      timeoutMs: 50,
    });
  } catch (error: unknown) {
    caught = error;
  }
  expect(performance.now() - started).toBeLessThan(5000);
  expect(caught).toBeInstanceOf(NativeKeychainTimeoutError);
  expect(caught).toBeInstanceOf(ClosedCliError);
  const error = caught as NativeKeychainTimeoutError;
  expect(error.operation).toBe("set");
  expect(error.message).toContain(NATIVE_KEYCHAIN_TIMEOUT_ENV);
  // The outcome of a timed-out write is unknown, not "nothing stored".
  expect(error.message).toContain("may or may not have been applied");
  expect(error.message).not.toContain(name);
  expect(hasAbandonedNativeKeychainCall()).toBe(true);
});

test("a keychain call that answers in time passes its result and errors through", async () => {
  await expect(
    withNativeKeychainDeadline({
      operation: "get",
      run: async () => "ok",
      timeoutMs: 5000,
    })
  ).resolves.toBe("ok");
  const failure = new Error("platform failure");
  await expect(
    withNativeKeychainDeadline({
      operation: "delete",
      run: async () => {
        throw failure;
      },
      timeoutMs: 5000,
    })
  ).rejects.toBe(failure);
});

test("the keychain deadline override accepts only a bounded integer and refuses closed", () => {
  const resolve = (raw: string | undefined): number =>
    resolveNativeKeychainTimeoutMs({ [NATIVE_KEYCHAIN_TIMEOUT_ENV]: raw });
  expect(resolve(undefined)).toBe(NATIVE_KEYCHAIN_TIMEOUT_MS);
  expect(resolve("2000")).toBe(2000);
  for (const invalid of [
    "",
    "0",
    "-1",
    "2.5",
    "not-a-number",
    String(NATIVE_KEYCHAIN_TIMEOUT_MAX_MS + 1),
  ]) {
    expect(() => resolve(invalid)).toThrow(CliUsageError);
  }
  // The refusal names the variable, never the supplied text.
  const supplied = `t-${crypto.randomUUID()}`;
  let message = "";
  try {
    resolve(supplied);
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(NATIVE_KEYCHAIN_TIMEOUT_ENV);
  expect(message).not.toContain(supplied);
});
