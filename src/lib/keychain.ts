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

/** Check on every operation so changing the flag also protects existing stores. */
export function createKeychainBackend({
  backend,
}: {
  readonly backend: KeychainBackend;
}): KeychainBackend {
  return {
    get: async (input) =>
      isKeychainDisabled() ? null : await backend.get(input),
    set: async (input) => {
      if (isKeychainDisabled()) {
        throw new Error(
          "Keychain access is disabled by HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK."
        );
      }
      await backend.set(input);
    },
    delete: async (input) =>
      isKeychainDisabled() ? false : await backend.delete(input),
  };
}

export const keychain = createKeychainBackend({
  backend: {
    get: async (input) => await Bun.secrets.get(input),
    set: async (input) => {
      await Bun.secrets.set(input);
    },
    delete: async (input) => await Bun.secrets.delete(input),
  },
});
