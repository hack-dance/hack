import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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

async function writeGlobalConfig(input: {
  readonly value: Record<string, unknown>;
}): Promise<void> {
  const path = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!path) {
    throw new Error("Missing HACK_GLOBAL_CONFIG_PATH");
  }
  await writeFile(path, `${JSON.stringify(input.value, null, 2)}\n`);
}
