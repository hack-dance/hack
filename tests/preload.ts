import { afterEach, expect } from "bun:test";
import type { KeychainBackend } from "../src/lib/keychain.ts";

process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
// No test reaches the real systemd user manager or unit directory: every
// systemctl/loginctl call is refused before spawning. Systemd tests inject a
// fake runner, or pass an env without this key to a CLI with a fake
// `systemctl` first on PATH (HACK-2052).
process.env.HACK_SYSTEMD_DISABLE = "1";

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
  value: testSecrets,
});

afterEach(() => {
  expect(Bun.secrets).toBe(testSecrets);
  values.clear();
});
