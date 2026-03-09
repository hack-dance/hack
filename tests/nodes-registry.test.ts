import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  deleteNodeAuthToken,
  deriveNodeHealth,
  readNodeAuthToken,
  readNodesRegistry,
  removeNodeRecord,
  saveNodeAuthToken,
  setDefaultNode,
  touchNode,
  upsertNodeRecord,
} from "../src/lib/nodes-registry.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalGlobalConfigPath: string | undefined;
let originalSecretsFileKey: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  originalSecretsFileKey = process.env.HACK_SECRETS_FILE_KEY;
  tempDir = await mkdtemp(join(tmpdir(), "hack-nodes-registry-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  if (originalGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  }
  if (originalSecretsFileKey !== undefined) {
    process.env.HACK_SECRETS_FILE_KEY = originalSecretsFileKey;
  } else {
    process.env.HACK_SECRETS_FILE_KEY = undefined;
  }
});

test("node registry supports upsert/default/touch/remove", async () => {
  const created = await upsertNodeRecord({
    name: "alpha",
    source: "remote-user@198.51.100.42",
    endpoint: "http://127.0.0.1:7788/",
    authRef: "node.auth.alpha",
  });

  expect(created.created).toBe(true);
  expect(created.node.endpoint).toBe("http://127.0.0.1:7788");
  expect(created.node.name).toBe("alpha");
  expect(created.node.source).toBe("remote-user@198.51.100.42");

  const updated = await upsertNodeRecord({
    id: created.node.id,
    name: "alpha",
    endpoint: "http://127.0.0.1:7788",
    authRef: "node.auth.alpha",
  });
  expect(updated.created).toBe(false);
  expect(updated.node.source).toBe("remote-user@198.51.100.42");

  const selected = await setDefaultNode({ id: created.node.id });
  expect(selected.defaultNodeId).toBe(created.node.id);

  const touched = await touchNode({
    id: created.node.id,
    status: "healthy",
    nowIso: "2026-01-01T00:00:00.000Z",
  });
  expect(touched?.status).toBe("healthy");
  expect(touched?.lastSeenAt).toBe("2026-01-01T00:00:00.000Z");

  const removed = await removeNodeRecord({ id: created.node.id });
  expect(removed.removed).toBe(true);

  const after = await readNodesRegistry();
  expect(after.nodes).toHaveLength(0);
  expect(after.defaultNodeId).toBeNull();
});

test("deriveNodeHealth classifies healthy/stale/offline", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const healthy = deriveNodeHealth({
    nowIso,
    lastSeenAt: "2025-12-31T23:59:59.000Z",
    staleAfterMs: 5000,
    offlineAfterMs: 20_000,
  });
  const stale = deriveNodeHealth({
    nowIso,
    lastSeenAt: "2025-12-31T23:59:50.000Z",
    staleAfterMs: 5000,
    offlineAfterMs: 20_000,
  });
  const offline = deriveNodeHealth({
    nowIso,
    lastSeenAt: "2025-12-31T23:59:20.000Z",
    staleAfterMs: 5000,
    offlineAfterMs: 20_000,
  });

  expect(healthy).toBe("healthy");
  expect(stale).toBe("stale");
  expect(offline).toBe("offline");
});

test("upsert clears stale registry lock", async () => {
  const lockPath = join(tempDir!, ".hack", "registry", "nodes.json.lock");
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "123\n");
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);

  const created = await upsertNodeRecord({
    name: "beta",
    endpoint: "http://10.0.0.8:7788",
    authRef: "node.auth.beta",
  });
  expect(created.created).toBe(true);
});

test("node env auth refs resolve when allowEnvAuthRefs is enabled", async () => {
  await writeGlobalSecretsConfig({
    allowEnvAuthRefs: true,
  });
  const envName = "HACK_NODE_AUTH_TOKEN_TEST";
  const authRef = `env:${envName}`;

  await saveNodeAuthToken({
    authRef,
    token: "env-token",
  });
  const resolved = await readNodeAuthToken({ authRef });
  expect(resolved).toBe("env-token");
  expect(process.env[envName]).toBe("env-token");

  const deleted = await deleteNodeAuthToken({ authRef });
  expect(deleted).toBe(true);
  const afterDelete = await readNodeAuthToken({ authRef });
  expect(afterDelete).toBeNull();
});

test("node env auth refs are rejected when allowEnvAuthRefs is disabled", async () => {
  await writeGlobalSecretsConfig({
    allowEnvAuthRefs: false,
  });
  const envName = "HACK_NODE_AUTH_TOKEN_BLOCKED";
  const authRef = `env:${envName}`;
  process.env[envName] = "blocked-token";

  await expect(
    saveNodeAuthToken({
      authRef,
      token: "blocked-token",
    })
  ).rejects.toThrow("allowEnvAuthRefs=false");
  await expect(readNodeAuthToken({ authRef })).rejects.toThrow(
    "allowEnvAuthRefs=false"
  );
  await expect(deleteNodeAuthToken({ authRef })).rejects.toThrow(
    "allowEnvAuthRefs=false"
  );
  expect(process.env[envName]).toBe("blocked-token");
  delete process.env[envName];
});

test("node auth refs use encrypted_file backend for non-env refs", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }

  const storePath = join(tempDir, "node-secrets.enc.json");
  process.env.HACK_SECRETS_FILE_KEY = "nodes-registry-test-secret-key";
  await writeGlobalSecretsConfig({
    backend: "encrypted_file",
    encryptedFilePath: storePath,
  });

  const authRef = "node.auth.encrypted";
  await saveNodeAuthToken({
    authRef,
    token: "encrypted-backend-token",
  });
  const resolved = await readNodeAuthToken({ authRef });
  expect(resolved).toBe("encrypted-backend-token");

  const storeText = await readFile(storePath, "utf8");
  expect(storeText).toContain('"ciphertext"');

  const deleted = await deleteNodeAuthToken({ authRef });
  expect(deleted).toBe(true);
  const afterDelete = await readNodeAuthToken({ authRef });
  expect(afterDelete).toBeNull();
});

async function writeGlobalSecretsConfig(input: {
  readonly allowEnvAuthRefs?: boolean;
  readonly backend?: "keychain" | "encrypted_file" | "cloud";
  readonly encryptedFilePath?: string;
  readonly cloudProvider?: "aws" | "gcp" | "azure" | "vault";
  readonly cloudProject?: string;
  readonly cloudSecretPrefix?: string;
}): Promise<void> {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }

  const configPath = join(tempDir, "global-config.json");
  process.env.HACK_GLOBAL_CONFIG_PATH = configPath;
  const payload = {
    controlPlane: {
      secrets: {
        ...(input.backend ? { backend: input.backend } : {}),
        ...(input.allowEnvAuthRefs !== undefined
          ? { allowEnvAuthRefs: input.allowEnvAuthRefs }
          : {}),
        ...(input.encryptedFilePath
          ? {
              encryptedFile: {
                path: input.encryptedFilePath,
                keyPath: "~/.hack/secrets-file.key",
              },
            }
          : {}),
        ...(input.cloudProvider
          ? {
              cloud: {
                provider: input.cloudProvider,
                ...(input.cloudProject ? { project: input.cloudProject } : {}),
                ...(input.cloudSecretPrefix
                  ? { secretPrefix: input.cloudSecretPrefix }
                  : {}),
              },
            }
          : {}),
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`);
}
