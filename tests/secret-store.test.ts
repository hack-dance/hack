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

let tempDir: string | null = null;
let previousHome: string | undefined;
let previousGlobalConfigPath: string | undefined;
let previousSecretsKey: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-secret-store-"));
  previousHome = process.env.HOME;
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  previousSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(tempDir, "hack.config.json");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = previousHome;
  if (previousGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = previousGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  }
  if (previousSecretsKey !== undefined) {
    process.env.HACK_SECRETS_FILE_KEY = previousSecretsKey;
  } else {
    process.env.HACK_SECRETS_FILE_KEY = undefined;
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
  process.env.HACK_SECRETS_FILE_KEY = undefined;
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
  process.env.HACK_SECRETS_FILE_KEY = undefined;
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

async function writeGlobalConfig(input: {
  readonly value: Record<string, unknown>;
}): Promise<void> {
  const path = process.env.HACK_GLOBAL_CONFIG_PATH;
  if (!path) {
    throw new Error("Missing HACK_GLOBAL_CONFIG_PATH");
  }
  await writeFile(path, `${JSON.stringify(input.value, null, 2)}\n`);
}
