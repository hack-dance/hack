import { afterEach, expect } from "bun:test";
import type { KeychainBackend } from "../src/lib/keychain.ts";

process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";

const values = new Map<string, string>();
function entryKey(input: { service: string; name: string }): string {
  return JSON.stringify([input.service, input.name]);
}

const testSecrets: KeychainBackend = {
  get: async (input) => values.get(entryKey(input)) ?? null,
  set: async (input) => {
    values.set(entryKey(input), input.value);
  },
  delete: async (input) => values.delete(entryKey(input)),
};

Object.defineProperty(Bun, "secrets", {
  configurable: false,
  writable: false,
  value: Object.freeze(testSecrets),
});

afterEach(() => {
  expect(Bun.secrets).toBe(testSecrets);
  values.clear();
});
