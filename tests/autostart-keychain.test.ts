import { expect, test } from "bun:test";
import { buildLifecycleJsonErrorResult } from "../src/commands/project.ts";
import { classifyAutostartExit } from "../src/daemon/autostart.ts";
import { createKeychainBackend } from "../src/lib/keychain.ts";
import { ProjectEnvKeyMissingError } from "../src/lib/project-env-config.ts";
import { SecretStoreKeyUnavailableError } from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

test("real key refusals become a closed skipped result without invoking keychain", async () => {
  const previousLogin = process.env.HACK_AUTOSTART_LOGIN;
  const previousDisable = process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
  try {
    process.env.HACK_AUTOSTART_LOGIN = "1";
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
    let called = false;
    const backend = createKeychainBackend({
      backend: {
        get: async () => {
          called = true;
          return null;
        },
        set: async () => {
          called = true;
        },
        delete: async () => {
          called = true;
          return false;
        },
      },
    });
    let keychainError: unknown;
    try {
      await backend.get({ service: "fixture", name: "SAMPLE_KEY" });
    } catch (error) {
      keychainError = error;
    }
    expect(keychainError).toBeInstanceOf(Error);
    for (const error of [
      keychainError,
      new ProjectEnvKeyMissingError("fixture"),
      new SecretStoreKeyUnavailableError("fixture"),
    ]) {
      expect(
        classifyAutostartExit({
          exitCode: 1,
          stdout: JSON.stringify(buildLifecycleJsonErrorResult({ error })),
        })
      ).toEqual({ status: "skipped", reason: "env_key_missing" });
    }
    expect(called).toBe(false);
  } finally {
    restoreEnv("HACK_AUTOSTART_LOGIN", previousLogin);
    restoreEnv("HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK", previousDisable);
  }
});
