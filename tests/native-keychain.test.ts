import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

test(
  "an invalid override reaches the encrypted_file key lookup as its own usage refusal",
  async () => {
    // Fresh process: the key lookup caches key material at module level. The
    // override is resolved before any keychain call, so none is made here.
    const root = await mkdtemp(join(tmpdir(), "hack-keychain-override-"));
    try {
      const projectDir = join(root, "repo", ".hack");
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(root, "hack.config.json"), "{}\n");
      await writeFile(
        join(projectDir, "hack.config.json"),
        `${JSON.stringify({
          name: "keychain-override",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: {
                path: "secrets.enc.json",
                keyPath: "missing.key",
              },
            },
          },
        })}\n`
      );
      // A non-empty store with no key file: lookup falls through to the keychain.
      await writeFile(
        join(root, "repo", "secrets.enc.json"),
        '{"ciphertext":"existing"}\n'
      );
      const script = `
        const { resolveSecretStore } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/lib/secret-store.ts"))});
        const { CliUsageError } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/cli/command.ts"))});
        try {
          await resolveSecretStore({ projectName: "keychain-override", projectDir: ${JSON.stringify(projectDir)} });
          console.log(JSON.stringify({ ok: true }));
        } catch (error) {
          console.log(JSON.stringify({ usage: error instanceof CliUsageError, message: String(error?.message) }));
        }
      `;
      const supplied = `bad-${crypto.randomUUID()}`;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          HACK_GLOBAL_CONFIG_PATH: join(root, "hack.config.json"),
          [NATIVE_KEYCHAIN_TIMEOUT_ENV]: supplied,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "missing-bus.sock")}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      const outcome = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
        readonly usage?: boolean;
        readonly message?: string;
      };
      expect(outcome.usage).toBe(true);
      expect(outcome.message).toContain(NATIVE_KEYCHAIN_TIMEOUT_ENV);
      expect(outcome.message).not.toContain("encrypted backend key");
      expect(outcome.message).not.toContain(supplied);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  { timeout: 30_000 }
);
