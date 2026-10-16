import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { secrets } from "bun";
import type {
  CloudSecretProvider,
  SecretsBackend,
  SecretsConfig,
} from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, readTextFile } from "./fs.ts";

const ENCRYPTED_FILE_KEY_ENV = "HACK_SECRETS_FILE_KEY";
const DISABLE_ENCRYPTED_FILE_KEYCHAIN_FALLBACK_ENV =
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK";
const DEFAULT_ENCRYPTED_FILE_KEY_PATH = "~/.hack/secrets-file.key";
const ENCRYPTED_FILE_KEY_SERVICE = "hack-secrets-backend";
const ENCRYPTED_FILE_KEY_NAME = "encrypted-file-key";
const ENCRYPTED_FILE_KEY_FAILURE_COOLDOWN_MS = 60_000;
const ENCRYPTED_STORE_VERSION = 1 as const;
const PLAINTEXT_STORE_VERSION = 1 as const;
const ENCRYPTED_ALGORITHM = "aes-256-gcm";
const ENCRYPTED_IV_BYTES = 12;
let cachedEncryptedFileKey: string | null = null;
let encryptedFileKeyFailureCooldownUntilMs = 0;

type EncryptedStorePayload = {
  readonly version: typeof ENCRYPTED_STORE_VERSION;
  readonly algorithm: typeof ENCRYPTED_ALGORITHM;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

type PlaintextStore = {
  readonly version: typeof PLAINTEXT_STORE_VERSION;
  readonly entries: Record<string, string>;
};

export type SecretStoreDescriptor = {
  readonly backend: SecretsBackend;
  readonly location: string;
  readonly mode: "native" | "shim";
  readonly provider?: CloudSecretProvider;
};

export type SecretStore = {
  readonly descriptor: SecretStoreDescriptor;
  readonly get: (input: { readonly key: string }) => Promise<string | null>;
  readonly set: (input: {
    readonly key: string;
    readonly value: string;
  }) => Promise<void>;
  readonly delete: (input: { readonly key: string }) => Promise<boolean>;
};

/**
 * Resolve the active secret backend for a project context.
 *
 * Backends are controlled via `controlPlane.secrets.backend`.
 */
export async function resolveSecretStore(input: {
  readonly projectName: string;
  readonly projectDir?: string;
}): Promise<SecretStore> {
  const controlPlane = await readControlPlaneConfig({
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
  });
  const secretsConfig = controlPlane.config.secrets;
  if (secretsConfig.backend === "encrypted_file") {
    return await createEncryptedFileSecretStore({
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig,
    });
  }
  if (secretsConfig.backend === "cloud") {
    return await createCloudSecretStore({
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig,
    });
  }
  return createKeychainSecretStore({ projectName: input.projectName });
}

export async function resolveSecretStoreDescriptor(input: {
  readonly projectName: string;
  readonly projectDir?: string;
}): Promise<SecretStoreDescriptor> {
  const controlPlane = await readControlPlaneConfig({
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
  });
  return describeSecretStoreDescriptor({
    projectName: input.projectName,
    projectDir: input.projectDir,
    secretsConfig: controlPlane.config.secrets,
  });
}

/**
 * Render a user-facing identifier for where secrets are stored.
 */
export function formatSecretStoreDescriptor(input: {
  readonly descriptor: SecretStoreDescriptor;
}): string {
  const provider =
    input.descriptor.backend === "cloud" && input.descriptor.provider
      ? ` (${input.descriptor.provider})`
      : "";
  const mode =
    input.descriptor.mode === "shim" ? " [shim]" : input.descriptor.mode;
  return `${input.descriptor.backend}${provider} @ ${input.descriptor.location} (${mode})`;
}

function createKeychainSecretStore(input: {
  readonly projectName: string;
}): SecretStore {
  const service = resolveSecretServiceName({ projectName: input.projectName });
  return {
    descriptor: {
      backend: "keychain",
      location: service,
      mode: "native",
    },
    get: async ({ key }) =>
      await secrets.get({
        service,
        name: key,
      }),
    set: async ({ key, value }) => {
      await secrets.set({
        service,
        name: key,
        value,
      });
    },
    delete: async ({ key }) =>
      await secrets.delete({
        service,
        name: key,
      }),
  };
}

function describeSecretStoreDescriptor(input: {
  readonly projectName: string;
  readonly projectDir?: string;
  readonly secretsConfig: SecretsConfig;
}): SecretStoreDescriptor {
  if (input.secretsConfig.backend === "encrypted_file") {
    return {
      backend: "encrypted_file",
      location: resolveConfiguredPath({
        path: input.secretsConfig.encryptedFile.path,
        projectDir: input.projectDir,
      }),
      mode: "native",
    };
  }

  if (input.secretsConfig.backend === "cloud") {
    const project = input.secretsConfig.cloud.project?.trim() || "default";
    const prefix = input.secretsConfig.cloud.secretPrefix.trim() || "hack";
    const filePath = resolveConfiguredPath({
      path: input.secretsConfig.encryptedFile.path,
      projectDir: input.projectDir,
    });
    return {
      backend: "cloud",
      location: `${input.secretsConfig.cloud.provider ?? "unknown"}:${project}:${prefix}:${filePath}`,
      mode: "shim",
      ...(input.secretsConfig.cloud.provider
        ? { provider: input.secretsConfig.cloud.provider }
        : {}),
    };
  }

  return {
    backend: "keychain",
    location: resolveSecretServiceName({ projectName: input.projectName }),
    mode: "native",
  };
}

async function createEncryptedFileSecretStore(input: {
  readonly projectName: string;
  readonly projectDir?: string;
  readonly secretsConfig: SecretsConfig;
}): Promise<SecretStore> {
  const filePath = resolveConfiguredPath({
    path: input.secretsConfig.encryptedFile.path,
    projectDir: input.projectDir,
  });
  const keyPath = resolveConfiguredPath({
    path:
      input.secretsConfig.encryptedFile.keyPath ??
      DEFAULT_ENCRYPTED_FILE_KEY_PATH,
    projectDir: input.projectDir,
  });
  const encryptionKey = (
    await resolveEncryptedFileKeyMaterial({
      keyPath,
      storePath: filePath,
    })
  ).key;
  return createEncryptedScopedStore({
    backend: "encrypted_file",
    scope: input.projectName,
    filePath,
    encryptionKey,
    mode: "native",
  });
}

async function createCloudSecretStore(input: {
  readonly projectName: string;
  readonly projectDir?: string;
  readonly secretsConfig: SecretsConfig;
}): Promise<SecretStore> {
  const provider = input.secretsConfig.cloud.provider;
  if (!provider) {
    throw new Error(
      "Cloud secret backend requires controlPlane.secrets.cloud.provider."
    );
  }

  const adapter = await createCloudProviderAdapter({
    provider,
    projectName: input.projectName,
    secretsConfig: input.secretsConfig,
  });
  return {
    descriptor: {
      backend: "cloud",
      location: adapter.location,
      mode: "shim",
      provider,
    },
    get: adapter.get,
    set: adapter.set,
    delete: adapter.delete,
  };
}

async function createCloudProviderAdapter(input: {
  readonly provider: CloudSecretProvider;
  readonly projectName: string;
  readonly projectDir?: string;
  readonly secretsConfig: SecretsConfig;
}): Promise<
  Pick<SecretStore, "get" | "set" | "delete"> & { readonly location: string }
> {
  if (input.provider === "aws") {
    return await createCloudShimAdapter({
      provider: input.provider,
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig: input.secretsConfig,
    });
  }
  if (input.provider === "gcp") {
    return await createCloudShimAdapter({
      provider: input.provider,
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig: input.secretsConfig,
    });
  }
  if (input.provider === "azure") {
    return await createCloudShimAdapter({
      provider: input.provider,
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig: input.secretsConfig,
    });
  }
  return await createCloudShimAdapter({
    provider: input.provider,
    projectName: input.projectName,
    projectDir: input.projectDir,
    secretsConfig: input.secretsConfig,
  });
}

async function createCloudShimAdapter(input: {
  readonly provider: CloudSecretProvider;
  readonly projectName: string;
  readonly projectDir?: string;
  readonly secretsConfig: SecretsConfig;
}): Promise<
  Pick<SecretStore, "get" | "set" | "delete"> & { readonly location: string }
> {
  const project = input.secretsConfig.cloud.project?.trim() || "default";
  const prefix = input.secretsConfig.cloud.secretPrefix.trim() || "hack";
  const filePath = resolveConfiguredPath({
    path: input.secretsConfig.encryptedFile.path,
    projectDir: input.projectDir,
  });
  const keyPath = resolveConfiguredPath({
    path:
      input.secretsConfig.encryptedFile.keyPath ??
      DEFAULT_ENCRYPTED_FILE_KEY_PATH,
    projectDir: input.projectDir,
  });
  const encryptionKey = (
    await resolveEncryptedFileKeyMaterial({
      keyPath,
      storePath: filePath,
    })
  ).key;
  const scope = [
    "cloud",
    input.provider,
    project,
    prefix,
    input.projectName,
  ].join(":");
  const scopedStore = createEncryptedScopedStore({
    backend: "cloud",
    scope,
    filePath,
    encryptionKey,
    mode: "shim",
  });
  return {
    location: `${input.provider}:${project}:${prefix}:${filePath}`,
    get: scopedStore.get,
    set: scopedStore.set,
    delete: scopedStore.delete,
  };
}

function createEncryptedScopedStore(input: {
  readonly backend: SecretsBackend;
  readonly scope: string;
  readonly filePath: string;
  readonly encryptionKey: string;
  readonly mode: "native" | "shim";
}): SecretStore {
  return {
    descriptor: {
      backend: input.backend,
      location: input.filePath,
      mode: input.mode,
    },
    get: async ({ key }) => {
      const entries = await readEncryptedEntries({
        filePath: input.filePath,
        encryptionKey: input.encryptionKey,
      });
      const scopedKey = buildScopedSecretKey({
        scope: input.scope,
        key,
      });
      return entries[scopedKey] ?? null;
    },
    set: async ({ key, value }) => {
      const entries = await readEncryptedEntries({
        filePath: input.filePath,
        encryptionKey: input.encryptionKey,
      });
      const scopedKey = buildScopedSecretKey({
        scope: input.scope,
        key,
      });
      entries[scopedKey] = value;
      await writeEncryptedEntries({
        filePath: input.filePath,
        encryptionKey: input.encryptionKey,
        entries,
      });
    },
    delete: async ({ key }) => {
      const entries = await readEncryptedEntries({
        filePath: input.filePath,
        encryptionKey: input.encryptionKey,
      });
      const scopedKey = buildScopedSecretKey({
        scope: input.scope,
        key,
      });
      if (!(scopedKey in entries)) {
        return false;
      }
      delete entries[scopedKey];
      await writeEncryptedEntries({
        filePath: input.filePath,
        encryptionKey: input.encryptionKey,
        entries,
      });
      return true;
    },
  };
}

function buildScopedSecretKey(input: {
  readonly scope: string;
  readonly key: string;
}): string {
  return `${encodeURIComponent(input.scope)}::${encodeURIComponent(input.key)}`;
}

function resolveSecretServiceName(input: {
  readonly projectName: string;
}): string {
  return `hack-${input.projectName}`;
}

function resolveConfiguredPath(input: {
  readonly path: string;
  readonly projectDir?: string;
}): string {
  const raw = input.path.trim();
  const home = (process.env.HOME ?? "").trim();
  if (raw === "~") {
    return home;
  }
  if (raw === "~/.hack" || raw.startsWith("~/.hack/")) {
    // "~/.hack" is the canonical global hack dir; route it through the seam so
    // HACK_HOME-isolated environments keep secrets under the override dir.
    const rest = raw.slice("~/.hack/".length);
    return rest.length > 0
      ? resolve(resolveGlobalHackDir(), rest)
      : resolveGlobalHackDir();
  }
  if (raw.startsWith("~/")) {
    return resolve(home, raw.slice(2));
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  if (input.projectDir) {
    return resolve(input.projectDir, "..", raw);
  }
  return resolve(home, raw);
}

export async function provisionEncryptedFileKey(input: {
  readonly keyPath?: string;
  readonly storePath?: string;
  readonly projectDir?: string;
}): Promise<{
  readonly keyPath: string;
  readonly source: "env" | "file" | "keychain" | "generated";
}> {
  const keyPath = resolveConfiguredPath({
    path: input.keyPath ?? DEFAULT_ENCRYPTED_FILE_KEY_PATH,
    projectDir: input.projectDir,
  });
  const storePath = input.storePath
    ? resolveConfiguredPath({
        path: input.storePath,
        projectDir: input.projectDir,
      })
    : undefined;
  const resolved = await resolveEncryptedFileKeyMaterial({
    keyPath,
    storePath,
    persistResolvedKey: true,
  });
  return {
    keyPath,
    source: resolved.source,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Secret key resolution deliberately walks multiple compatibility sources in order.
async function resolveEncryptedFileKeyMaterial(input?: {
  readonly keyPath?: string;
  readonly storePath?: string;
  readonly persistResolvedKey?: boolean;
}): Promise<{
  readonly key: string;
  readonly source: "env" | "file" | "keychain" | "generated";
}> {
  const envValue = (process.env[ENCRYPTED_FILE_KEY_ENV] ?? "").trim();
  if (envValue.length > 0) {
    cachedEncryptedFileKey = envValue;
    encryptedFileKeyFailureCooldownUntilMs = 0;
    if (input?.persistResolvedKey && input.keyPath) {
      await writeEncryptedFileKey({
        keyPath: input.keyPath,
        key: envValue,
      });
    }
    return {
      key: envValue,
      source: "env",
    };
  }

  const configuredKeyPath = input?.keyPath?.trim();
  if (configuredKeyPath) {
    const fileKey = await readEncryptedFileKey({
      keyPath: configuredKeyPath,
    });
    if (fileKey) {
      cachedEncryptedFileKey = fileKey;
      encryptedFileKeyFailureCooldownUntilMs = 0;
      return {
        key: fileKey,
        source: "file",
      };
    }
  }

  if (
    isTruthyEnvFlag(process.env[DISABLE_ENCRYPTED_FILE_KEYCHAIN_FALLBACK_ENV])
  ) {
    throw new Error(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "keychain_disabled",
      })
    );
  }

  if (cachedEncryptedFileKey) {
    if (input?.persistResolvedKey && input.keyPath) {
      await writeEncryptedFileKey({
        keyPath: input.keyPath,
        key: cachedEncryptedFileKey,
      });
    }
    return {
      key: cachedEncryptedFileKey,
      source: "keychain",
    };
  }

  const shouldBootstrapFileKey =
    Boolean(configuredKeyPath) &&
    (await canBootstrapEncryptedFileKey({
      storePath: input?.storePath,
    }));
  if (configuredKeyPath && shouldBootstrapFileKey) {
    const generated = randomBytes(32).toString("base64url");
    await writeEncryptedFileKey({
      keyPath: configuredKeyPath,
      key: generated,
    });
    cachedEncryptedFileKey = generated;
    encryptedFileKeyFailureCooldownUntilMs = 0;
    return {
      key: generated,
      source: "generated",
    };
  }

  const nowMs = Date.now();
  if (nowMs < encryptedFileKeyFailureCooldownUntilMs) {
    throw new Error(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "cooldown",
      })
    );
  }

  let existing: string | undefined;
  try {
    existing = (
      await secrets.get({
        service: ENCRYPTED_FILE_KEY_SERVICE,
        name: ENCRYPTED_FILE_KEY_NAME,
      })
    )?.trim();
  } catch {
    encryptedFileKeyFailureCooldownUntilMs =
      Date.now() + ENCRYPTED_FILE_KEY_FAILURE_COOLDOWN_MS;
    throw new Error(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "keychain_access_failed",
      })
    );
  }
  if (existing) {
    if (configuredKeyPath) {
      await writeEncryptedFileKey({
        keyPath: configuredKeyPath,
        key: existing,
      });
    }
    cachedEncryptedFileKey = existing;
    encryptedFileKeyFailureCooldownUntilMs = 0;
    return {
      key: existing,
      source: "keychain",
    };
  }

  if (configuredKeyPath) {
    throw new Error(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "missing",
      })
    );
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    await secrets.set({
      service: ENCRYPTED_FILE_KEY_SERVICE,
      name: ENCRYPTED_FILE_KEY_NAME,
      value: generated,
    });
  } catch {
    encryptedFileKeyFailureCooldownUntilMs =
      Date.now() + ENCRYPTED_FILE_KEY_FAILURE_COOLDOWN_MS;
    throw new Error(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "keychain_access_failed",
      })
    );
  }
  cachedEncryptedFileKey = generated;
  encryptedFileKeyFailureCooldownUntilMs = 0;
  return {
    key: generated,
    source: "generated",
  };
}

async function canBootstrapEncryptedFileKey(input: {
  readonly storePath?: string;
}): Promise<boolean> {
  if (!input.storePath) {
    return true;
  }
  try {
    const info = await stat(input.storePath);
    return info.size === 0;
  } catch {
    return true;
  }
}

async function readEncryptedFileKey(input: {
  readonly keyPath: string;
}): Promise<string | null> {
  const raw = await readTextFile(input.keyPath);
  const key = raw?.trim() ?? "";
  return key.length > 0 ? key : null;
}

async function writeEncryptedFileKey(input: {
  readonly keyPath: string;
  readonly key: string;
}): Promise<void> {
  await ensureDir(dirname(input.keyPath));
  await writeFile(input.keyPath, `${input.key}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(input.keyPath, 0o600).catch(() => undefined);
}

async function readEncryptedEntries(input: {
  readonly filePath: string;
  readonly encryptionKey: string;
}): Promise<Record<string, string>> {
  const text = await readTextFile(input.filePath);
  if (!text) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid encrypted secret store JSON at ${input.filePath}.`
    );
  }

  const envelope = parseEncryptedEnvelope(parsed);
  if (!envelope) {
    throw new Error(
      `Invalid encrypted secret store payload at ${input.filePath}.`
    );
  }
  const plaintext = decryptStore({
    envelope,
    encryptionKey: input.encryptionKey,
  });
  return parsePlaintextStore(plaintext).entries;
}

async function writeEncryptedEntries(input: {
  readonly filePath: string;
  readonly encryptionKey: string;
  readonly entries: Record<string, string>;
}): Promise<void> {
  const plaintext: PlaintextStore = {
    version: PLAINTEXT_STORE_VERSION,
    entries: input.entries,
  };
  const envelope = encryptStore({
    plaintext: JSON.stringify(plaintext),
    encryptionKey: input.encryptionKey,
  });
  await ensureDir(dirname(input.filePath));
  await Bun.write(input.filePath, `${JSON.stringify(envelope, null, 2)}\n`);
}

function parseEncryptedEnvelope(value: unknown): EncryptedStorePayload | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const maybe = value as Record<string, unknown>;
  if (
    maybe.version !== ENCRYPTED_STORE_VERSION ||
    maybe.algorithm !== ENCRYPTED_ALGORITHM ||
    typeof maybe.iv !== "string" ||
    typeof maybe.tag !== "string" ||
    typeof maybe.ciphertext !== "string"
  ) {
    return null;
  }
  return {
    version: ENCRYPTED_STORE_VERSION,
    algorithm: ENCRYPTED_ALGORITHM,
    iv: maybe.iv,
    tag: maybe.tag,
    ciphertext: maybe.ciphertext,
  };
}

function parsePlaintextStore(value: string): PlaintextStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Decrypted secret store payload is not valid JSON.");
  }
  if (!(parsed && typeof parsed === "object")) {
    throw new Error("Decrypted secret store payload is not an object.");
  }
  const maybe = parsed as Record<string, unknown>;
  if (
    maybe.version !== PLAINTEXT_STORE_VERSION ||
    !(maybe.entries && typeof maybe.entries === "object")
  ) {
    throw new Error("Decrypted secret store payload has an invalid shape.");
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    maybe.entries as Record<string, unknown>
  )) {
    if (typeof value !== "string") {
      continue;
    }
    entries[key] = value;
  }
  return {
    version: PLAINTEXT_STORE_VERSION,
    entries,
  };
}

function encryptStore(input: {
  readonly plaintext: string;
  readonly encryptionKey: string;
}): EncryptedStorePayload {
  const iv = randomBytes(ENCRYPTED_IV_BYTES);
  const key = deriveEncryptionKey({ source: input.encryptionKey });
  const cipher = createCipheriv(ENCRYPTED_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: ENCRYPTED_STORE_VERSION,
    algorithm: ENCRYPTED_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptStore(input: {
  readonly envelope: EncryptedStorePayload;
  readonly encryptionKey: string;
}): string {
  const key = deriveEncryptionKey({ source: input.encryptionKey });
  const iv = Buffer.from(input.envelope.iv, "base64");
  const tag = Buffer.from(input.envelope.tag, "base64");
  const ciphertext = Buffer.from(input.envelope.ciphertext, "base64");
  const decipher = createDecipheriv(ENCRYPTED_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function deriveEncryptionKey(input: { readonly source: string }): Buffer {
  return createHash("sha256").update(input.source, "utf8").digest();
}

function buildEncryptedBackendKeyRecoveryMessage(input: {
  readonly keyPath: string | undefined;
  readonly storePath?: string;
  readonly reason:
    | "cooldown"
    | "keychain_access_failed"
    | "keychain_disabled"
    | "missing";
}): string {
  const location = input.storePath ? ` for ${input.storePath}` : "";
  const recovery = input.keyPath
    ? `Provision ${input.keyPath} or set ${ENCRYPTED_FILE_KEY_ENV}.`
    : `Set ${ENCRYPTED_FILE_KEY_ENV}.`;

  if (input.reason === "cooldown") {
    return `Encrypted backend key access is cooling down after a failed keychain lookup${location}. ${recovery} Hack will not fall back to plaintext .hack/.env or ambient process env.`;
  }

  if (input.reason === "keychain_access_failed") {
    return `Failed to access encrypted backend key in keychain service "${ENCRYPTED_FILE_KEY_SERVICE}"${location}. ${recovery} Hack will not fall back to plaintext .hack/.env or ambient process env.`;
  }

  if (input.reason === "keychain_disabled") {
    return `Missing encrypted backend key${location}. Keychain fallback is disabled by ${DISABLE_ENCRYPTED_FILE_KEYCHAIN_FALLBACK_ENV}. ${recovery} Hack will not fall back to plaintext .hack/.env or ambient process env.`;
  }

  return `Missing encrypted backend key${location}. ${recovery} Hack will not fall back to plaintext .hack/.env or ambient process env.`;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}
