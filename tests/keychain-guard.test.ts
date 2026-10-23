import { afterEach, expect, test } from "bun:test";
import { secrets } from "bun";
import { createKeychainBackend, keychain } from "../src/lib/keychain.ts";
import { resolveSecretStore } from "../src/lib/secret-store.ts";

const disableFlag = process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
afterEach(() => {
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = disableFlag;
});

test("preload replaces both Bun.secrets entry points and prevents restoration", async () => {
  expect(Object.getOwnPropertyDescriptor(Bun, "secrets")?.configurable).toBe(
    false
  );
  expect(secrets).toBe(Bun.secrets);
  expect(() => Object.defineProperty(Bun, "secrets", { value: {} })).toThrow();
  const input = { service: "guard", name: "SECRET_TWO" };
  await secrets.set({ ...input, value: "memory-only" });
  expect(await secrets.get(input)).toBe("memory-only");
  expect(await secrets.delete(input)).toBe(true);
  expect(await secrets.get(input)).toBeNull();
});

test("disable flag gates every operation before even an injected backend is called", async () => {
  const calls: string[] = [];
  const backend = createKeychainBackend({
    backend: {
      get: async () => {
        calls.push("get");
        return "value";
      },
      set: async () => {
        calls.push("set");
      },
      delete: async () => {
        calls.push("delete");
        return true;
      },
    },
  });
  const input = { service: "guard", name: "SECRET_TWO" };
  for (const flag of ["1", "true", "yes", "on", " TRUE "]) {
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = flag;
    await expect(backend.get(input)).rejects.toThrow(
      "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK"
    );
    await expect(backend.set({ ...input, value: "value" })).rejects.toThrow(
      "disabled"
    );
    await expect(backend.delete(input)).rejects.toThrow(
      "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK"
    );
  }
  expect(calls).toEqual([]);
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "0";
  expect(await backend.get(input)).toBe("value");
  await backend.set({ ...input, value: "value" });
  expect(await backend.delete(input)).toBe(true);
  expect(calls).toEqual(["get", "set", "delete"]);
});

test("existing keychain stores honor changes to the flag without native calls", async () => {
  const previousConfig = process.env.HACK_GLOBAL_CONFIG_PATH;
  try {
    process.env.HACK_GLOBAL_CONFIG_PATH = "/dev/null";
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "0";
    const store = await resolveSecretStore({ projectName: "hermetic-guard" });
    expect(store.descriptor.backend).toBe("keychain");
    await store.set({ key: "SECRET_TWO", value: "memory-only" });
    expect(await store.get({ key: "SECRET_TWO" })).toBe("memory-only");
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
    await expect(store.get({ key: "SECRET_TWO" })).rejects.toThrow("disabled");
    await expect(
      store.set({ key: "SECRET_TWO", value: "blocked" })
    ).rejects.toThrow("disabled");
    await expect(store.delete({ key: "SECRET_TWO" })).rejects.toThrow(
      "disabled"
    );
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "0";
    expect(await store.get({ key: "SECRET_TWO" })).toBe("memory-only");
    expect(await store.delete({ key: "SECRET_TWO" })).toBe(true);
    expect(
      await keychain.get({ service: "hack-hermetic-guard", name: "SECRET_TWO" })
    ).toBeNull();
  } finally {
    process.env.HACK_GLOBAL_CONFIG_PATH = previousConfig;
  }
});
