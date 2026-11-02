import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionEncryptedFileKey,
  resolveSecretStore,
} from "../src/lib/secret-store.ts";
import { restoreEnv } from "./helpers/env.ts";

let tempDir: string | null = null;
let previousHome: string | undefined;
let previousGlobalConfigPath: string | undefined;
let previousSecretsKey: string | undefined;
let previousDisableKeychainFallback: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-secret-store-"));
  previousHome = process.env.HOME;
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  previousSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
  previousDisableKeychainFallback =
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(tempDir, "hack.config.json");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  restoreEnv("HOME", previousHome);
  if (previousGlobalConfigPath !== undefined) {
    restoreEnv("HACK_GLOBAL_CONFIG_PATH", previousGlobalConfigPath);
  } else {
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
  }
  if (previousSecretsKey !== undefined) {
    process.env.HACK_SECRETS_FILE_KEY = previousSecretsKey;
  } else {
    Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  }
  if (previousDisableKeychainFallback !== undefined) {
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK =
      previousDisableKeychainFallback;
  } else {
    Reflect.deleteProperty(
      process.env,
      "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK"
    );
  }
});

test("encrypted_file backend stores and retrieves encrypted secret values", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "unit-test-secret-key";
  const storePath = join(tempDir, "secrets.enc.json");
  await writeGlobalConfig({
    value: {
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: storePath,
          },
        },
      },
    },
  });

  const store = await resolveSecretStore({
    projectName: "app",
  });
  expect(store.descriptor.backend).toBe("encrypted_file");
  await store.set({
    key: "DATABASE_URL",
    value: "postgres://db.example.local",
  });
  const resolved = await store.get({
    key: "DATABASE_URL",
  });
  expect(resolved).toBe("postgres://db.example.local");

  const persisted = await readFile(storePath, "utf8");
  expect(persisted).not.toContain("postgres://db.example.local");
  expect(persisted).toContain('"ciphertext"');

  const deleted = await store.delete({
    key: "DATABASE_URL",
  });
  expect(deleted).toBe(true);
  const afterDelete = await store.get({
    key: "DATABASE_URL",
  });
  expect(afterDelete).toBeNull();
});

test("cloud backend shim is provider-scoped and persists through encrypted store", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "unit-test-cloud-secret-key";
  const storePath = join(tempDir, "cloud-secrets.enc.json");
  await writeGlobalConfig({
    value: {
      controlPlane: {
        secrets: {
          backend: "cloud",
          encryptedFile: {
            path: storePath,
          },
          cloud: {
            provider: "aws",
            project: "dev-account",
            secretPrefix: "hack-cli",
          },
        },
      },
    },
  });

  const firstProjectStore = await resolveSecretStore({
    projectName: "app-one",
  });
  expect(firstProjectStore.descriptor.backend).toBe("cloud");
  expect(firstProjectStore.descriptor.provider).toBe("aws");

  await firstProjectStore.set({
    key: "API_TOKEN",
    value: "cloud-token-1",
  });
  const firstValue = await firstProjectStore.get({
    key: "API_TOKEN",
  });
  expect(firstValue).toBe("cloud-token-1");

  const secondProjectStore = await resolveSecretStore({
    projectName: "app-two",
  });
  const secondValue = await secondProjectStore.get({
    key: "API_TOKEN",
  });
  expect(secondValue).toBeNull();
});

test("encrypted_file backend reads key material from configured keyPath when env is unset", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const storePath = join(tempDir, "secrets.enc.json");
  const keyPath = join(tempDir, "secrets-file.key");
  await writeFile(keyPath, "stable-file-key\n");
  await writeGlobalConfig({
    value: {
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: storePath,
            keyPath,
          },
        },
      },
    },
  });

  const store = await resolveSecretStore({
    projectName: "app",
  });
  await store.set({
    key: "API_TOKEN",
    value: "stable-key-value",
  });

  const resolved = await store.get({
    key: "API_TOKEN",
  });
  expect(resolved).toBe("stable-key-value");
});

test("project config resolves encrypted_file paths relative to the repo root", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  const projectRoot = join(tempDir, "repo");
  const projectDir = join(projectRoot, ".hack");
  const storePath = join(projectRoot, ".hack-secrets.enc.json");
  const keyPath = join(projectRoot, ".hack-secrets-file.key");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(tempDir, "hack.config.json"),
    `${JSON.stringify({}, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: "repo-app",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: {
              path: ".hack-secrets.enc.json",
              keyPath: ".hack-secrets-file.key",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  const store = await resolveSecretStore({
    projectName: "repo-app",
    projectDir,
  });
  expect(store.descriptor.backend).toBe("encrypted_file");
  expect(store.descriptor.location).toBe(storePath);

  await store.set({
    key: "API_TOKEN",
    value: "repo-relative-secret",
  });

  expect(await store.get({ key: "API_TOKEN" })).toBe("repo-relative-secret");
  await access(storePath);

  const provisioned = await provisionEncryptedFileKey({
    projectDir,
    storePath: ".hack-secrets.enc.json",
    keyPath: ".hack-secrets-file.key",
  });
  expect(provisioned.keyPath).toBe(keyPath);
  await access(keyPath);
});

test("encrypted_file backend returns recovery guidance when key material is missing", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "true";
  const projectRoot = join(tempDir, "repo-missing-key");
  const projectDir = join(projectRoot, ".hack");
  const storePath = join(projectRoot, ".hack-secrets.enc.json");
  const keyPath = join(projectRoot, ".hack-secrets-file.key");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(tempDir, "hack.config.json"),
    `${JSON.stringify({}, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: "repo-missing-key",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: {
              path: ".hack-secrets.enc.json",
              keyPath: ".hack-secrets-file.key",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
  await writeFile(storePath, '{"ciphertext":"existing"}\n');

  await expect(
    resolveSecretStore({
      projectName: "repo-missing-key",
      projectDir,
    })
  ).rejects.toThrow("Missing encrypted backend key");
  await expect(
    resolveSecretStore({
      projectName: "repo-missing-key",
      projectDir,
    })
  ).rejects.toThrow("will not fall back to plaintext .hack/.env");
  const persisted = await readFile(storePath, "utf8");
  expect(persisted).toContain('"ciphertext"');
  await expect(access(keyPath)).rejects.toThrow();
});

const STORE_KEY = "synthetic-store-key-for-tests-only";
const STORE_SENTINEL = "synthetic-store-value-never-in-errors";

type StoreEnvelope = {
  readonly version: number;
  readonly algorithm: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

/** Writes one sentinel entry through the real store and returns its envelope. */
async function encryptedStoreFixture(): Promise<{
  readonly storePath: string;
  readonly envelope: StoreEnvelope;
}> {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = STORE_KEY;
  const storePath = join(tempDir, "secrets.enc.json");
  await writeGlobalConfig({
    value: {
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: { path: storePath },
        },
      },
    },
  });
  const store = await resolveSecretStore({ projectName: "app" });
  await store.set({ key: "TOKEN", value: STORE_SENTINEL });
  await store.set({ key: "EMPTY", value: "" });
  const envelope = JSON.parse(
    await readFile(storePath, "utf8")
  ) as StoreEnvelope;
  return { storePath, envelope };
}

function reencode(
  envelope: StoreEnvelope,
  field: "iv" | "tag" | "ciphertext",
  change: (bytes: Buffer) => Buffer
): StoreEnvelope {
  return {
    ...envelope,
    [field]: change(Buffer.from(envelope[field], "base64")).toString("base64"),
  };
}

const STORE_MUTATIONS: ReadonlyArray<
  readonly [string, (envelope: StoreEnvelope) => StoreEnvelope]
> = [
  ...[4, 8, 12].map(
    (bytes) =>
      [
        `${bytes}-byte tag`,
        (envelope: StoreEnvelope) =>
          reencode(envelope, "tag", (tag) => tag.subarray(0, bytes)),
      ] as const
  ),
  [
    "16-byte IV",
    (envelope) =>
      reencode(envelope, "iv", (iv) => Buffer.concat([iv, Buffer.alloc(4)])),
  ],
  [
    "base64 with !",
    (envelope) => ({
      ...envelope,
      ciphertext: `!${envelope.ciphertext.slice(1)}`,
    }),
  ],
  [
    "base64 with whitespace",
    (envelope) => ({
      ...envelope,
      tag: `${envelope.tag.slice(0, 4)}\n${envelope.tag.slice(4)}`,
    }),
  ],
  [
    "truncated ciphertext",
    (envelope) =>
      reencode(envelope, "ciphertext", (ciphertext) =>
        ciphertext.subarray(0, -1)
      ),
  ],
  [
    "bit-flipped ciphertext",
    (envelope) =>
      reencode(envelope, "ciphertext", (ciphertext) => {
        const flipped = Buffer.from(ciphertext);
        flipped[0] = (flipped[0] ?? 0) ^ 1;
        return flipped;
      }),
  ],
  [
    "oversized ciphertext",
    (envelope) => ({
      ...envelope,
      ciphertext: Buffer.alloc(16 * 1024 * 1024 + 1, 7).toString("base64"),
    }),
  ],
];

for (const [name, mutate] of STORE_MUTATIONS) {
  test(`encrypted_file envelope with ${name} refuses with a fixed redacted error`, async () => {
    const { storePath, envelope } = await encryptedStoreFixture();
    const mutated = mutate(envelope);
    expect(mutated).not.toEqual(envelope);
    await writeFile(storePath, `${JSON.stringify(mutated)}\n`);

    const store = await resolveSecretStore({ projectName: "app" });
    const error = await store.get({ key: "TOKEN" }).then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(
      /^(Invalid encrypted secret store payload|Cannot decrypt encrypted secret store) at /
    );
    for (const privateText of [STORE_SENTINEL, STORE_KEY]) {
      expect(String(error)).not.toContain(privateText);
    }
  });
}

test("encrypted_file envelope with the wrong key refuses with a fixed redacted error", async () => {
  await encryptedStoreFixture();
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-wrong-store-key";
  const store = await resolveSecretStore({ projectName: "app" });
  const error = await store.get({ key: "TOKEN" }).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Cannot decrypt encrypted secret store at ");
  expect(String(error)).not.toContain(STORE_SENTINEL);
});

test("encrypted_file v1 envelope round-trips, including the empty value", async () => {
  const { envelope } = await encryptedStoreFixture();
  expect(Buffer.from(envelope.iv, "base64").length).toBe(12);
  expect(Buffer.from(envelope.tag, "base64").length).toBe(16);
  const store = await resolveSecretStore({ projectName: "app" });
  expect(await store.get({ key: "TOKEN" })).toBe(STORE_SENTINEL);
  expect(await store.get({ key: "EMPTY" })).toBe("");
});

/** Byte bound of the encrypted_file ciphertext parser. */
const STORE_CIPHERTEXT_LIMIT = 16 * 1024 * 1024;

function storeKey(): Buffer {
  return nodeCrypto.createHash("sha256").update(STORE_KEY, "utf8").digest();
}

/** Opens a store envelope the way the v1 owner does, to reuse its plaintext. */
function openStoreEnvelope(envelope: StoreEnvelope): string {
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-gcm",
    storeKey(),
    Buffer.from(envelope.iv, "base64"),
    { authTagLength: 16 }
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Seals a store plaintext exactly as the v1 owner does but with a caller-chosen
 * IV length. GCM accepts any non-empty IV, so a refusal of these authentic
 * envelopes can only come from the parser's own IV and size guards.
 */
function sealStoreEnvelope(opts: {
  readonly plaintext: string;
  readonly ivBytes: number;
}): StoreEnvelope {
  const iv = nodeCrypto.randomBytes(opts.ivBytes);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", storeKey(), iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(opts.plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Pads the real store plaintext with an extra entry to exactly `bytes` bytes. */
function storePlaintextOfLength(opts: {
  readonly envelope: StoreEnvelope;
  readonly bytes: number;
}): string {
  const parsed = JSON.parse(openStoreEnvelope(opts.envelope)) as {
    readonly version: number;
    readonly entries: Record<string, string>;
  };
  const base = JSON.stringify({
    ...parsed,
    entries: { ...parsed.entries, PAD: "" },
  });
  const padded = JSON.stringify({
    ...parsed,
    entries: { ...parsed.entries, PAD: "a".repeat(opts.bytes - base.length) },
  });
  expect(Buffer.byteLength(padded, "utf8")).toBe(opts.bytes);
  return padded;
}

async function readStoreToken(): Promise<
  { readonly value: string | null } | { readonly error: unknown }
> {
  try {
    const store = await resolveSecretStore({ projectName: "app" });
    return { value: await store.get({ key: "TOKEN" }) };
  } catch (error: unknown) {
    return { error };
  }
}

function expectFixedStoreRefusal(
  outcome: { readonly value: string | null } | { readonly error: unknown }
): void {
  const error = "error" in outcome ? outcome.error : null;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toMatch(
    /^Invalid encrypted secret store payload at /
  );
  for (const privateText of [STORE_SENTINEL, STORE_KEY]) {
    expect(String(error)).not.toContain(privateText);
  }
}

test("encrypted_file test-sealed 12-byte-IV envelope at the ciphertext bound opens with the tag length pinned (control)", async () => {
  const { storePath, envelope } = await encryptedStoreFixture();
  await writeFile(
    storePath,
    `${JSON.stringify(
      sealStoreEnvelope({
        plaintext: storePlaintextOfLength({
          envelope,
          bytes: STORE_CIPHERTEXT_LIMIT,
        }),
        ivBytes: 12,
      })
    )}\n`
  );
  const decipher = spyOn(nodeCrypto, "createDecipheriv");
  try {
    const outcome = await readStoreToken();
    expect("value" in outcome ? outcome.value : null).toBe(STORE_SENTINEL);
    // The tag length is pinned by option rather than left to the runtime default.
    expect(decipher).toHaveBeenCalled();
    for (const call of decipher.mock.calls) {
      const options: unknown = call[3];
      expect(options).toEqual({ authTagLength: 16 });
    }
  } finally {
    decipher.mockRestore();
  }
});

for (const ivBytes of [8, 16]) {
  test(`encrypted_file authentic envelope sealed with a ${ivBytes}-byte IV refuses before decipher`, async () => {
    const { storePath, envelope } = await encryptedStoreFixture();
    await writeFile(
      storePath,
      `${JSON.stringify(
        sealStoreEnvelope({ plaintext: openStoreEnvelope(envelope), ivBytes })
      )}\n`
    );
    const decipher = spyOn(nodeCrypto, "createDecipheriv");
    try {
      expectFixedStoreRefusal(await readStoreToken());
      expect(decipher).not.toHaveBeenCalled();
    } finally {
      decipher.mockRestore();
    }
  });
}

test("encrypted_file authentic envelope one byte over the ciphertext bound refuses before decipher", async () => {
  const { storePath, envelope } = await encryptedStoreFixture();
  await writeFile(
    storePath,
    `${JSON.stringify(
      sealStoreEnvelope({
        plaintext: storePlaintextOfLength({
          envelope,
          bytes: STORE_CIPHERTEXT_LIMIT + 1,
        }),
        ivBytes: 12,
      })
    )}\n`
  );
  const decipher = spyOn(nodeCrypto, "createDecipheriv");
  try {
    expectFixedStoreRefusal(await readStoreToken());
    expect(decipher).not.toHaveBeenCalled();
  } finally {
    decipher.mockRestore();
  }
});

// Structural mutations must be refused by the explicit parser guards before any
// decipher exists, so the refusal does not depend on runtime GCM defaults.
for (const name of [
  "4-byte tag",
  "8-byte tag",
  "12-byte tag",
  "16-byte IV",
  "base64 with !",
  "base64 with whitespace",
  "oversized ciphertext",
]) {
  test(`encrypted_file envelope with ${name} refuses before decipher`, async () => {
    const mutate = STORE_MUTATIONS.find(([label]) => label === name)?.[1];
    if (!mutate) {
      throw new Error("missing store mutation");
    }
    const { storePath, envelope } = await encryptedStoreFixture();
    await writeFile(storePath, `${JSON.stringify(mutate(envelope))}\n`);
    const decipher = spyOn(nodeCrypto, "createDecipheriv");
    try {
      expectFixedStoreRefusal(await readStoreToken());
      expect(decipher).not.toHaveBeenCalled();
    } finally {
      decipher.mockRestore();
    }
  });
}

test("encrypted_file envelope with a 16-byte tag of the wrong value refuses", async () => {
  const { storePath, envelope } = await encryptedStoreFixture();
  const tag = Buffer.from(envelope.tag, "base64");
  tag[15] = (tag[15] ?? 0) ^ 1;
  await writeFile(
    storePath,
    `${JSON.stringify({ ...envelope, tag: tag.toString("base64") })}\n`
  );
  const outcome = await readStoreToken();
  const error = "error" in outcome ? outcome.error : null;
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("Cannot decrypt encrypted secret store at ");
  for (const privateText of [STORE_SENTINEL, STORE_KEY]) {
    expect(String(error)).not.toContain(privateText);
  }
});

async function writeGlobalConfig(input: {
  readonly value: Record<string, unknown>;
}): Promise<void> {
  const path = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!path) {
    throw new Error("Missing HACK_GLOBAL_CONFIG_PATH");
  }
  await writeFile(path, `${JSON.stringify(input.value, null, 2)}\n`);
}

test("encrypted file key provisioning refuses symlinks without changing the target", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-new-key";
  const target = join(tempDir, "unrelated-file");
  const keyPath = join(tempDir, "key-link");
  await writeFile(target, "synthetic-original-content", { mode: 0o644 });
  const targetMode = (await stat(target)).mode & 0o777;
  await symlink(target, keyPath);
  await expect(provisionEncryptedFileKey({ keyPath })).rejects.toThrow(
    "Refused encrypted secret key write"
  );
  expect(await readFile(target, "utf8")).toBe("synthetic-original-content");
  expect((await stat(target)).mode & 0o777).toBe(targetMode);
});

test("encrypted file key provisioning refuses dangling symlinks", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-new-key";
  const target = join(tempDir, "missing-target");
  const keyPath = join(tempDir, "key-link");
  await symlink(target, keyPath);
  await expect(provisionEncryptedFileKey({ keyPath })).rejects.toThrow(
    "Refused encrypted secret key write"
  );
  await expect(access(target)).rejects.toThrow();
});

test("encrypted file key provisioning replaces a regular key with private permissions", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-new-key";
  const keyPath = join(tempDir, "regular-key");
  await writeFile(keyPath, "synthetic-old-key", { mode: 0o644 });
  const before = await stat(keyPath);
  await provisionEncryptedFileKey({ keyPath });
  expect(await readFile(keyPath, "utf8")).toBe("synthetic-new-key\n");
  const after = await stat(keyPath);
  expect(after.mode & 0o777).toBe(0o600);
  expect(after.ino).not.toBe(before.ino);
});

test("encrypted file key provisioning refuses a symlinked parent directory", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  process.env.HACK_SECRETS_FILE_KEY = "synthetic-new-key";
  const target = join(tempDir, "real-directory");
  const alias = join(tempDir, "directory-link");
  await mkdir(target);
  await symlink(target, alias);
  await expect(
    provisionEncryptedFileKey({ keyPath: join(alias, "key") })
  ).rejects.toThrow("Refused encrypted secret key write");
  await expect(access(join(target, "key"))).rejects.toThrow();
});
