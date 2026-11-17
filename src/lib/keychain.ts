import { HackCliError } from "./cli-result.ts";
import { nativeKeychain } from "./native-keychain.ts";

/** The single boundary for native keychain access, injectable for isolated callers. */
export type KeychainBackend = {
  get(input: { service: string; name: string }): Promise<string | null>;
  set(input: { service: string; name: string; value: string }): Promise<void>;
  delete(input: { service: string; name: string }): Promise<boolean>;
};

export function isKeychainDisabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK ?? "")
      .trim()
      .toLowerCase()
  );
}

function assertKeychainEnabled(): void {
  if (isKeychainDisabled()) {
    if (process.env.HACK_AUTOSTART_LOGIN === "1") {
      throw new HackCliError({
        code: "E_ENV_KEY_MISSING",
        message:
          "Autostart skipped: required keychain access is unavailable without interaction.",
      });
    }
    throw new Error(
      "Keychain access is disabled by HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK."
    );
  }
}

/** Check on every operation so changing the flag also protects existing stores. */
export function createKeychainBackend({
  backend,
}: {
  readonly backend: KeychainBackend;
}): KeychainBackend {
  return {
    get: async (input) => {
      assertKeychainEnabled();
      return await backend.get(input);
    },
    set: async (input) => {
      assertKeychainEnabled();
      await backend.set(input);
    },
    delete: async (input) => {
      assertKeychainEnabled();
      return await backend.delete(input);
    },
  };
}

/** The gate runs first, then every native call is deadline-bounded. */
export const keychain = createKeychainBackend({ backend: nativeKeychain });
