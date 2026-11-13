import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import type {
  CloudSecretProvider,
  SecretsBackend,
  SecretsConfig,
} from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { envParseDiagnostic } from "./env-parse-diagnostic.ts";
import { ensureDir } from "./fs.ts";
import { resolveUserHomeDir } from "./home-dir.ts";
import { isKeychainDisabled, keychain } from "./keychain.ts";
import { quoteShellWord } from "./logs.ts";
import { NativeKeychainTimeoutError } from "./native-keychain.ts";
import {
  decodeCanonicalBase64,
  publishPrivateFileExclusive,
  type ReplaceablePrivateFileOptions,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";
import { withProjectsRegistryLock } from "./projects-registry-lock.ts";

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
const ENCRYPTED_TAG_BYTES = 16;
/** Decoded ciphertext bound for the whole encrypted store. */
const ENCRYPTED_CIPHERTEXT_LIMIT = 16 * 1024 * 1024;
const ENCRYPTED_STORE_READ_REFUSAL =
  "Refused to read the encrypted secret store: the store path is a symlink, not a regular file, or larger than a store can be. Replace it with a regular file and retry; values omitted.";
/**
 * Largest store file read: the base64 ciphertext bound plus the envelope's
 * fixed fields, with room to spare.
 */
const ENCRYPTED_STORE_FILE_LIMIT =
  Math.ceil((ENCRYPTED_CIPHERTEXT_LIMIT * 4) / 3) + 64 * 1024;
const ENCRYPTED_STORE_WRITE_REFUSAL =
  "Refused encrypted secret store write: the store path is a symlink or not a regular file. Replace it with a regular file and retry; values omitted.";
/**
 * The encrypted_file key read from (or generated into) the OS keychain item,
 * cached for this process. Only keychain material is cached (HACK-2169): a
 * key read from one store's key file, or from the environment, must never
 * satisfy another store's configured key path, which goes through that
 * store's own provisioning and recovery rules.
 */
let cachedKeychainEncryptedFileKey: string | null = null;
/** Per-path tail of the in-process mutation queue; see withEncryptedStoreMutation. */
const encryptedStoreMutationTails = new Map<string, Promise<void>>();
let encryptedFileKeyFailureCooldownUntilMs = 0;

type EncryptedStorePayload = {
  readonly version: typeof ENCRYPTED_STORE_VERSION;
  readonly algorithm: typeof ENCRYPTED_ALGORITHM;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

/** Envelope fields decoded and size-checked; the bytes are not yet authenticated. */
type ParsedEncryptedEnvelope = {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
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

/** An encrypted backend's key isn't available, and this read didn't create one. */
export class SecretStoreKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreKeyUnavailableError";
  }
}

/**
 * The key file exists but is refused (HACK-2036): a link or non-regular
 * file, readable or writable by other users, or tracked by git.
 */
export class SecretStoreKeyRefusedError extends SecretStoreKeyUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreKeyRefusedError";
  }
}

/**
 * Resolve the active secret backend for a project context.
 *
 * Backends are controlled via `controlPlane.secrets.backend`.
 * Set allowKeyProvisioning=false for reads that must not generate or copy key
 * material. Existing native key access and its authorization are preserved.
 */
export async function resolveSecretStore(input: {
  readonly projectName: string;
  readonly projectDir?: string;
  readonly allowKeyProvisioning?: boolean;
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
      allowKeyProvisioning: input.allowKeyProvisioning,
    });
  }
  if (secretsConfig.backend === "cloud") {
    return await createCloudSecretStore({
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig,
      allowKeyProvisioning: input.allowKeyProvisioning,
    });
  }
  return createKeychainSecretStore({ projectName: input.projectName });
}

/**
 * What a project's encrypted-file secret store holds, for a migration that must
 * know whether every entry was carried over before it offers the store and its
 * key file for removal. Values are only compared with what env layers deliver;
 * reports name keys, never values. `storePath` and `keyPath` are the configured
 * locations, resolved the way the store resolves them.
 *
 * - `inactive`: the backend is the keychain, so the store isn't read, and it
 *   isn't opened here either (that could prompt for a keychain item).
 * - `listed`: `ownEntries` maps this project's keys (as `resolveEnvSecretKey`
 *   names them, such as `TOKEN` or `env.staging.TOKEN`) to their values;
 *   `foreignEntryCount` counts entries for any other project or scope.
 * - `unreadable`: the store exists but couldn't be read without provisioning a
 *   key (missing or wrong key, unreadable or corrupt file, incomplete config).
 */
export type FileSecretStoreListing = {
  readonly storePath: string;
  readonly keyPath: string;
} & (
  | { readonly kind: "inactive" }
  | {
      readonly kind: "listed";
      readonly ownEntries: ReadonlyMap<string, string>;
      readonly foreignEntryCount: number;
    }
  | {
      readonly kind: "unreadable";
      /**
       * Why, for recovery advice (HACK-2169): the store file itself cannot
       * be read; no key is configured or found; the key file is refused
       * (a link, open to others, tracked); the key does not open the store
       * or the file is corrupt; or the cloud configuration is incomplete.
       */
      readonly reason:
        | "store_unreadable"
        | "store_refused"
        | "key_missing"
        | "key_refused"
        | "key_unreadable"
        | "wrong_key_or_corrupt"
        | "incomplete_config";
    }
);

/**
 * Where the encrypted file store (also the cloud shim's) for this context
 * lives, from configuration only: nothing is read, opened or provisioned.
 * `active` is false when the backend is the OS keychain.
 */
export async function resolveFileSecretStorePaths(input: {
  /** Omitted: only the global configuration applies (no project). */
  readonly projectDir?: string;
}): Promise<{
  readonly active: boolean;
  readonly storePath: string;
  readonly keyPath: string;
}> {
  const secretsConfig = (
    await readControlPlaneConfig({ projectDir: input.projectDir })
  ).config.secrets;
  return {
    active:
      secretsConfig.backend === "encrypted_file" ||
      secretsConfig.backend === "cloud",
    storePath: resolveConfiguredPath({
      path: secretsConfig.encryptedFile.path,
      projectDir: input.projectDir,
    }),
    keyPath: resolveConfiguredPath({
      path:
        secretsConfig.encryptedFile.keyPath ?? DEFAULT_ENCRYPTED_FILE_KEY_PATH,
      projectDir: input.projectDir,
    }),
  };
}

/** Retired stores are kept beside the store as `<store><infix><UTC stamp>`. */
export const RETIRED_STORE_INFIX = ".retired-";
const STAMP_SEPARATORS = /[-:]/g;
const STAMP_MILLISECONDS = /\.\d{3}Z$/;

/** Thrown when a store cannot be moved aside; the message says why and what to do. */
export class SecretStoreRetireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreRetireError";
  }
}

/**
 * Moves an encrypted store file aside (HACK-2177), never deleting it. Under
 * the store's mutation lock:
 *
 * 1. the store must be a regular file, and not the key file itself (same
 *    device and inode, so an alias or hard link of the key is refused);
 * 2. `recheck` runs (eligibility, classified again under the lock);
 * 3. the archive name `<store>.retired-<UTC stamp>` is created exclusively
 *    as an empty placeholder (refused if that name exists);
 * 4. `rename` moves whatever file is at the store path at that instant over
 *    the placeholder, after checking the placeholder is still the same
 *    empty file.
 *
 * Nothing is unlinked: if a writer outside the lock replaced the store in
 * between, the replacement is what gets archived, and the only file ever
 * replaced is the empty placeholder this call created. Nothing is read or
 * decrypted; the key file is not touched.
 */
export async function retireEncryptedStoreFile(input: {
  readonly storePath: string;
  /** The store's key file: a store that is the key file is not retired. */
  readonly keyPath?: string;
  readonly now?: Date;
  /**
   * Runs under the store's lock just before the move: a refusal message
   * when the store is no longer one to retire (its key was restored, or it
   * was replaced meanwhile), null to go on.
   */
  readonly recheck?: () => Promise<string | null>;
  /**
   * Test seam: runs just before the rename, after the placeholder check,
   * so a test can replace the store as a writer outside the lock would.
   */
  readonly beforeMove?: () => Promise<void>;
}): Promise<{ readonly from: string; readonly to: string }> {
  const storePath = input.storePath;
  return await withEncryptedStoreMutation({
    filePath: storePath,
    run: async () => {
      await assertRetirableStoreFile(input);
      const changed = (await input.recheck?.()) ?? null;
      if (changed !== null) {
        throw new SecretStoreRetireError(changed);
      }
      const stamp = (input.now ?? new Date())
        .toISOString()
        .replace(STAMP_SEPARATORS, "")
        .replace(STAMP_MILLISECONDS, "Z");
      const to = `${storePath}${RETIRED_STORE_INFIX}${stamp}`;
      const placeholder = await createRetirePlaceholder({ storePath, to });
      await moveStoreOverPlaceholder({
        storePath,
        to,
        placeholder,
        beforeMove: input.beforeMove,
      });
      return { from: storePath, to };
    },
  });
}

/** The store is a regular file, and not its own key file (same device and inode). */
async function assertRetirableStoreFile(input: {
  readonly storePath: string;
  readonly keyPath?: string;
}): Promise<void> {
  const info = await stat(input.storePath).catch(() => null);
  const linkInfo = await lstat(input.storePath).catch(() => null);
  if (info === null || linkInfo === null) {
    throw new SecretStoreRetireError(
      `There is no encrypted secret store at ${input.storePath}; nothing was moved.`
    );
  }
  if (!linkInfo.isFile()) {
    throw new SecretStoreRetireError(
      `The encrypted secret store at ${input.storePath} is a symlink or not a regular file; nothing was moved. Inspect it with ls -l, then move it aside by hand if you mean to.`
    );
  }
  const keyInfo = input.keyPath
    ? await stat(input.keyPath).catch(() => null)
    : null;
  if (
    keyInfo !== null &&
    keyInfo.dev === info.dev &&
    keyInfo.ino === info.ino
  ) {
    throw new SecretStoreRetireError(
      `The encrypted secret store at ${input.storePath} is its own key file (${input.keyPath}); retiring it would remove the key. Nothing was moved. Fix controlPlane.secrets.encryptedFile so the store and its key are different files.`
    );
  }
}

/**
 * Renames the store over the placeholder, after checking the placeholder is
 * still the same empty file; on any failure the placeholder (only if still
 * ours) is removed and nothing has moved.
 */
async function moveStoreOverPlaceholder(input: {
  readonly storePath: string;
  readonly to: string;
  readonly placeholder: { readonly dev: number; readonly ino: number };
  readonly beforeMove?: () => Promise<void>;
}): Promise<void> {
  try {
    const current = await lstat(input.to).catch(() => null);
    if (
      current === null ||
      !current.isFile() ||
      current.dev !== input.placeholder.dev ||
      current.ino !== input.placeholder.ino ||
      current.size !== 0
    ) {
      throw new SecretStoreRetireError(
        `${input.to} changed while retiring; nothing was moved and it was left as it is.`
      );
    }
    await input.beforeMove?.();
    await rename(input.storePath, input.to);
  } catch (error: unknown) {
    await removeOwnPlaceholder(input);
    if (error instanceof SecretStoreRetireError) {
      throw error;
    }
    throw new SecretStoreRetireError(
      `Could not move ${input.storePath} to ${input.to} (${errorCode(error)}); nothing was moved. To retire it by hand: mv ${quoteShellWord(input.storePath)} ${quoteShellWord(input.to)}`
    );
  }
}

/** Creates the archive name exclusively (an empty 0600 file); refuses if it exists. */
async function createRetirePlaceholder(input: {
  readonly storePath: string;
  readonly to: string;
}): Promise<{ readonly dev: number; readonly ino: number }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(input.to, "wx", 0o600);
  } catch (error: unknown) {
    throw new SecretStoreRetireError(
      errorCode(error) === "EEXIST"
        ? `${input.to} already exists; nothing was moved. Retry in a second.`
        : `Could not create ${input.to} (${errorCode(error)}); nothing was moved. To retire it by hand: mv ${quoteShellWord(input.storePath)} ${quoteShellWord(input.to)}`
    );
  }
  try {
    const created = await handle.stat();
    return { dev: created.dev, ino: created.ino };
  } finally {
    await handle.close();
  }
}

/** Removes the placeholder only while it is still the empty file this call made. */
async function removeOwnPlaceholder(input: {
  readonly to: string;
  readonly placeholder: { readonly dev: number; readonly ino: number };
}): Promise<void> {
  const current = await lstat(input.to).catch(() => null);
  if (
    current?.isFile() === true &&
    current.dev === input.placeholder.dev &&
    current.ino === input.placeholder.ino &&
    current.size === 0
  ) {
    await unlink(input.to).catch(() => undefined);
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : "unknown";
}

/** Retired copies of `storePath` in its directory, oldest first. */
export async function listRetiredEncryptedStores(
  storePath: string
): Promise<readonly string[]> {
  const prefix = `${basename(storePath)}${RETIRED_STORE_INFIX}`;
  const entries = await readdir(dirname(storePath)).catch(() => [] as string[]);
  return entries
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => resolve(dirname(storePath), name));
}

/** The listing's reason for each way a store file read can fail. */
const STORE_READ_FAILURE_REASON = {
  refused: "store_refused",
  unreadable: "store_unreadable",
} as const;

/**
 * Lists a project's encrypted-file (or cloud shim) secret store read-only. It
 * never generates, copies or persists key material, and it reports a store it
 * can't open as `unreadable` instead of throwing. An absent or empty store is
 * listed with no entries without reading any key.
 */
export async function listFileSecretStoreEntries(input: {
  readonly projectName: string;
  /** Omitted: only the global configuration applies (no project). */
  readonly projectDir?: string;
}): Promise<FileSecretStoreListing> {
  const controlPlane = await readControlPlaneConfig({
    projectDir: input.projectDir,
  });
  const secretsConfig = controlPlane.config.secrets;
  const storePath = resolveConfiguredPath({
    path: secretsConfig.encryptedFile.path,
    projectDir: input.projectDir,
  });
  const keyPath = resolveConfiguredPath({
    path:
      secretsConfig.encryptedFile.keyPath ?? DEFAULT_ENCRYPTED_FILE_KEY_PATH,
    projectDir: input.projectDir,
  });
  let scope: string;
  if (secretsConfig.backend === "encrypted_file") {
    scope = input.projectName;
  } else if (secretsConfig.backend === "cloud") {
    const provider = secretsConfig.cloud.provider;
    if (!provider) {
      return {
        kind: "unreadable",
        reason: "incomplete_config",
        storePath,
        keyPath,
      };
    }
    scope = [
      "cloud",
      provider,
      secretsConfig.cloud.project?.trim() || "default",
      secretsConfig.cloud.secretPrefix.trim() || "hack",
      input.projectName,
    ].join(":");
  } else {
    return { kind: "inactive", storePath, keyPath };
  }
  // The same read real use makes: an existing store that can't be read is
  // unreadable, never empty, and a linked one is refused, not followed.
  const read = await readEncryptedStoreText(storePath);
  if (read.kind === "refused" || read.kind === "unreadable") {
    return {
      kind: "unreadable",
      reason: STORE_READ_FAILURE_REASON[read.kind],
      storePath,
      keyPath,
    };
  }
  if (read.kind === "absent" || read.text.length === 0) {
    return {
      kind: "listed",
      storePath,
      keyPath,
      ownEntries: new Map(),
      foreignEntryCount: 0,
    };
  }
  const opened = await openListedStore({ storePath, keyPath, text: read.text });
  if ("reason" in opened) {
    return { kind: "unreadable", reason: opened.reason, storePath, keyPath };
  }
  const { entries } = opened;
  const prefix = `${encodeURIComponent(scope)}::`;
  const ownEntries = new Map<string, string>();
  let foreignEntryCount = 0;
  for (const [scopedKey, value] of Object.entries(entries)) {
    const ownKey = scopedKey.startsWith(prefix)
      ? decodeScopedKey(scopedKey.slice(prefix.length))
      : null;
    if (ownKey === null) {
      foreignEntryCount += 1;
    } else {
      ownEntries.set(ownKey, value);
    }
  }
  return { kind: "listed", storePath, keyPath, ownEntries, foreignEntryCount };
}

/**
 * Decrypts a listed store read-only, never provisioning a key; on failure,
 * why it could not be opened.
 */
async function openListedStore(input: {
  readonly storePath: string;
  readonly keyPath: string;
  readonly text: string;
}): Promise<
  | { readonly entries: Record<string, string> }
  | {
      readonly reason:
        | "key_missing"
        | "key_refused"
        | "key_unreadable"
        | "wrong_key_or_corrupt";
    }
> {
  let key: string;
  try {
    key = (
      await resolveEncryptedFileKeyMaterial({
        keyPath: input.keyPath,
        storePath: input.storePath,
        allowKeyProvisioning: false,
      })
    ).key;
  } catch (error: unknown) {
    if (error instanceof SecretStoreKeyRefusedError) {
      return { reason: "key_refused" };
    }
    // Missing only when there is no key file, or it is empty. A key file
    // that exists but cannot be read is not missing (HACK-2177): fixing its
    // permissions may recover the store, which must not be retired.
    return {
      reason: (await keyFileUnreadable(input.keyPath))
        ? "key_unreadable"
        : "key_missing",
    };
  }
  try {
    return {
      entries: decryptEncryptedEntriesText({
        filePath: input.storePath,
        text: input.text,
        encryptionKey: key,
      }),
    };
  } catch {
    return { reason: "wrong_key_or_corrupt" };
  }
}

/** True when the key file exists but this user cannot read it. */
async function keyFileUnreadable(keyPath: string): Promise<boolean> {
  try {
    await readFile(keyPath);
    return false;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

function decodeScopedKey(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
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
      await keychain.get({
        service,
        name: key,
      }),
    set: async ({ key, value }) => {
      await keychain.set({
        service,
        name: key,
        value,
      });
    },
    delete: async ({ key }) =>
      await keychain.delete({
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
  readonly allowKeyProvisioning?: boolean;
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
      allowKeyProvisioning: input.allowKeyProvisioning,
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
  readonly allowKeyProvisioning?: boolean;
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
    // Relative store and key paths belong to the project, like the
    // encrypted_file backend and the read-only listing (HACK-2001).
    projectDir: input.projectDir,
    secretsConfig: input.secretsConfig,
    allowKeyProvisioning: input.allowKeyProvisioning,
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
  readonly allowKeyProvisioning?: boolean;
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
      allowKeyProvisioning: input.allowKeyProvisioning,
    });
  }
  if (input.provider === "gcp") {
    return await createCloudShimAdapter({
      provider: input.provider,
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig: input.secretsConfig,
      allowKeyProvisioning: input.allowKeyProvisioning,
    });
  }
  if (input.provider === "azure") {
    return await createCloudShimAdapter({
      provider: input.provider,
      projectName: input.projectName,
      projectDir: input.projectDir,
      secretsConfig: input.secretsConfig,
      allowKeyProvisioning: input.allowKeyProvisioning,
    });
  }
  return await createCloudShimAdapter({
    provider: input.provider,
    projectName: input.projectName,
    projectDir: input.projectDir,
    secretsConfig: input.secretsConfig,
    allowKeyProvisioning: input.allowKeyProvisioning,
  });
}

async function createCloudShimAdapter(input: {
  readonly provider: CloudSecretProvider;
  readonly projectName: string;
  readonly projectDir?: string;
  readonly allowKeyProvisioning?: boolean;
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
      allowKeyProvisioning: input.allowKeyProvisioning,
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
    set: async ({ key, value }) =>
      await withEncryptedStoreMutation({
        filePath: input.filePath,
        run: async () => {
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
      }),
    delete: async ({ key }) =>
      await withEncryptedStoreMutation({
        filePath: input.filePath,
        run: async () => {
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
      }),
  };
}

/**
 * Serializes read-modify-write of one encrypted store file.
 *
 * Writers in this process queue per configured path, so they never poll each
 * other; across processes the cooperative `<store>.lock` (the same exclusive
 * hard-link owner protocol as the projects registry, with dead-owner recovery)
 * admits one writer at a time. Every set/delete re-reads the store inside the
 * lock, so a concurrent writer's update is never lost. Reads take no lock:
 * writes replace the file atomically, so a reader sees a whole envelope.
 */
async function withEncryptedStoreMutation<T>(input: {
  readonly filePath: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const previous =
    encryptedStoreMutationTails.get(input.filePath) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolveTurn) => {
    release = resolveTurn;
  });
  const tail = previous.then(() => turn);
  encryptedStoreMutationTails.set(input.filePath, tail);
  await previous;
  try {
    await ensureDir(dirname(input.filePath));
    return await withProjectsRegistryLock({
      lockPath: `${input.filePath}.lock`,
      label: "encrypted secret store",
      run: input.run,
    });
  } finally {
    release();
    if (encryptedStoreMutationTails.get(input.filePath) === tail) {
      encryptedStoreMutationTails.delete(input.filePath);
    }
  }
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
  if (raw === "~") {
    return resolveUserHomeDir();
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
    return resolve(resolveUserHomeDir(), raw.slice(2));
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  if (input.projectDir) {
    return resolve(input.projectDir, "..", raw);
  }
  return resolve(resolveUserHomeDir(), raw);
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
  const envValue = (process.env[ENCRYPTED_FILE_KEY_ENV] ?? "").trim();
  if (envValue.length > 0) {
    await provisionEnvKey({ keyPath, storePath, key: envValue });
    encryptedFileKeyFailureCooldownUntilMs = 0;
    return { keyPath, source: "env" };
  }
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

/**
 * Explicit provisioning of `HACK_SECRETS_FILE_KEY` into the key file
 * (HACK-2169, S3). A key file may serve more than one store (the default
 * path is shared), and failing to open one store is no evidence that a key
 * is unused elsewhere, so provisioning never replaces a different key:
 *
 * - no key file (or an empty one): the key is written only when the
 *   configured store is confirmed absent or empty, or opens under it. A
 *   store that cannot be read or is refused is unknown, so nothing is
 *   written: a new file would shadow the key that opens it today;
 * - the same key: rewritten as a private (0600) regular file;
 * - a different key, or a key file that cannot be read: refused, with the
 *   manual steps. Changing a key is a rotation, which re-encrypts.
 *
 * Every branch runs under the key file's own lock (`<key>.lock`, shared by
 * every store using that path), and each write re-checks the file just
 * before it lands (the replacement's `beforeRename`), so a stale
 * observation never overwrites a key written meanwhile.
 */
async function provisionEnvKey(input: {
  readonly keyPath: string;
  readonly storePath: string | undefined;
  readonly key: string;
}): Promise<void> {
  await ensureDir(dirname(input.keyPath));
  await withEncryptedFileKeyLock({
    keyPath: input.keyPath,
    run: async () => {
      const existing = await readKeyForProvisioning(input.keyPath);
      if (existing !== null && existing !== input.key) {
        throw new SecretStoreKeyUnavailableError(
          `Refused to replace the encrypted secret key at ${input.keyPath}: ${ENCRYPTED_FILE_KEY_ENV} holds a different key, and the existing key may be the only one that opens this or another store using that path (values omitted). Unset ${ENCRYPTED_FILE_KEY_ENV} to keep the current key. Changing a store's key is a rotation that re-encrypts it, which provisioning does not do. If you have confirmed that no store needs the current key, move the key file aside yourself (keep a copy) and retry.`
        );
      }
      if (existing === null) {
        await refuseUnlessStoreAcceptsKey({
          keyPath: input.keyPath,
          storePath: input.storePath,
          key: input.key,
        });
      }
      await writeEncryptedFileKeyIfUnchangedLocked({
        keyPath: input.keyPath,
        key: input.key,
      });
    },
  });
}

/**
 * Runs `run` holding the key file's own lock (`<key>.lock`, shared by every
 * store using that path). Every writer of a key file takes it: explicit
 * provisioning, keychain persistence and first-use bootstrap (HACK-2169),
 * so no writer can land between another's check and write. Key writers
 * take no store lock while holding it, and store writers resolve their key
 * before taking the store lock, so the two locks never nest.
 */
async function withEncryptedFileKeyLock<T>(input: {
  readonly keyPath: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  await ensureDir(dirname(input.keyPath));
  return await withProjectsRegistryLock({
    lockPath: `${input.keyPath}.lock`,
    label: "encrypted secret key",
    run: input.run,
  });
}

/**
 * Refuses writing `key` to a missing key file unless the store is
 * confirmed absent or empty, or opens under `key` (HACK-2169). Anything
 * else is refused: a store under another key (an older keychain key), or
 * one that cannot be read or is refused, which may open with that other
 * key once repaired.
 */
async function refuseUnlessStoreAcceptsKey(input: {
  readonly keyPath: string;
  readonly storePath: string | undefined;
  readonly key: string;
}): Promise<void> {
  if (input.storePath === undefined) {
    return;
  }
  const store = await readEncryptedStoreText(input.storePath);
  if (store.kind === "absent") {
    return;
  }
  if (store.kind === "text") {
    if (
      store.text.length === 0 ||
      encryptedStoreOpensUnder({
        storePath: input.storePath,
        text: store.text,
        key: input.key,
      })
    ) {
      return;
    }
    throw new SecretStoreKeyUnavailableError(
      `Refused to write the encrypted secret key at ${input.keyPath}: ${ENCRYPTED_FILE_KEY_ENV} does not open the store at ${input.storePath}, which has entries, and readers would use the key file instead of the key that does (values omitted). Unset ${ENCRYPTED_FILE_KEY_ENV}, or set it to the key that opens the store, and retry.`
    );
  }
  throw new SecretStoreKeyUnavailableError(
    `Refused to write the encrypted secret key at ${input.keyPath}: the store at ${input.storePath} ${store.kind === "refused" ? "is a symlink or not a regular file" : "exists but cannot be read"}, so it cannot be checked against ${ENCRYPTED_FILE_KEY_ENV}, and a new key file could shadow the key that opens it (values omitted). Make the store a regular file this user can read and write, then retry.`
  );
}

/** Thrown inside a key write's `beforeRename` when the file changed. */
class EncryptedFileKeyChangedError extends Error {}

/**
 * Writes `key` to the key file (0600) only while the file is absent, empty
 * or already holds `key`, checked again immediately before the write lands.
 * Refuses, writing nothing, when another key is there by then. The caller
 * holds {@link withEncryptedFileKeyLock}.
 */
async function writeEncryptedFileKeyIfUnchangedLocked(input: {
  readonly keyPath: string;
  readonly key: string;
}): Promise<void> {
  await ensureDir(dirname(input.keyPath));
  const options = encryptedFileKeyOptions(input);
  const text = `${input.key}\n`;
  if (await publishPrivateFileExclusive({ ...options, text })) {
    return;
  }
  try {
    await replacePrivateFileAtomic({
      ...options,
      text,
      beforeRename: async () => {
        const current = await readKeyForProvisioning(input.keyPath);
        if (current !== null && current !== input.key) {
          throw new EncryptedFileKeyChangedError();
        }
      },
    });
  } catch (error: unknown) {
    if (error instanceof EncryptedFileKeyChangedError) {
      throw new SecretStoreKeyUnavailableError(
        `Refused to write the encrypted secret key at ${input.keyPath}: another key was written there meanwhile, and it is kept (values omitted). Check which key the store needs, then retry.`
      );
    }
    throw error;
  }
}

/** True when `key` decrypts the store text. */
function encryptedStoreOpensUnder(input: {
  readonly storePath: string;
  readonly text: string;
  readonly key: string;
}): boolean {
  try {
    decryptEncryptedEntriesText({
      filePath: input.storePath,
      text: input.text,
      encryptionKey: input.key,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The key file's text for provisioning, compared only (its mode and git
 * status are judged by readers): null when absent or empty. A link or
 * non-regular file gets the key write's own refusal; any other read
 * failure is refused, since that file may hold the only copy of a key.
 */
async function readKeyForProvisioning(keyPath: string): Promise<string | null> {
  const options = encryptedFileKeyOptions({ keyPath });
  try {
    const read = await readReplaceablePrivateFile({
      ...options,
      directories: [],
    });
    return read?.text.trim() || null;
  } catch (error: unknown) {
    const refusal = options.refusal();
    if (error instanceof Error && error.message === refusal.message) {
      throw refusal;
    }
    throw new SecretStoreKeyUnavailableError(
      `Refused to replace the encrypted secret key at ${keyPath}: it exists but cannot be read, and it may be the only copy of a store's key (values omitted). Make it readable by this user (chmod 600 after fixing its owner), then retry.`
    );
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Secret key resolution deliberately walks multiple compatibility sources in order.
async function resolveEncryptedFileKeyMaterial(input?: {
  readonly keyPath?: string;
  readonly storePath?: string;
  readonly persistResolvedKey?: boolean;
  readonly allowKeyProvisioning?: boolean;
}): Promise<{
  readonly key: string;
  readonly source: "env" | "file" | "keychain" | "generated";
}> {
  const allowKeyProvisioning = input?.allowKeyProvisioning !== false;
  const envValue = (process.env[ENCRYPTED_FILE_KEY_ENV] ?? "").trim();
  if (envValue.length > 0) {
    // Persisting the environment key is provisionEnvKey's job (explicit
    // provisioning handles it before reaching here); never written here.
    encryptedFileKeyFailureCooldownUntilMs = 0;
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
      encryptedFileKeyFailureCooldownUntilMs = 0;
      return {
        key: fileKey,
        source: "file",
      };
    }
  }

  const shouldBootstrapFileKey =
    allowKeyProvisioning &&
    Boolean(configuredKeyPath) &&
    (await canBootstrapEncryptedFileKey({
      storePath: input?.storePath,
    }));
  if (configuredKeyPath && shouldBootstrapFileKey) {
    const generated = randomBytes(32).toString("base64url");
    const key = await createOrAdoptEncryptedFileKey({
      keyPath: configuredKeyPath,
      key: generated,
    });
    encryptedFileKeyFailureCooldownUntilMs = 0;
    return {
      key,
      source: key === generated ? "generated" : "file",
    };
  }
  if (configuredKeyPath) {
    // A first user publishes its key file before it writes the store, so a
    // store found non-empty after the first key read implies a key file that
    // may have appeared since. Prefer it to the keychain.
    const publishedKey = await readEncryptedFileKey({
      keyPath: configuredKeyPath,
    });
    if (publishedKey) {
      encryptedFileKeyFailureCooldownUntilMs = 0;
      return {
        key: publishedKey,
        source: "file",
      };
    }
  }

  if (isKeychainDisabled()) {
    throw new SecretStoreKeyUnavailableError(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "keychain_disabled",
      })
    );
  }

  const nowMs = Date.now();
  if (
    cachedKeychainEncryptedFileKey === null &&
    nowMs < encryptedFileKeyFailureCooldownUntilMs
  ) {
    throw new SecretStoreKeyUnavailableError(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "cooldown",
      })
    );
  }

  let existing: string | undefined =
    cachedKeychainEncryptedFileKey ?? undefined;
  if (existing === undefined) {
    try {
      existing = (
        await keychain.get({
          service: ENCRYPTED_FILE_KEY_SERVICE,
          name: ENCRYPTED_FILE_KEY_NAME,
        })
      )?.trim();
    } catch (error: unknown) {
      throw keychainKeyAccessError({
        error,
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
      });
    }
  }
  if (existing) {
    if (allowKeyProvisioning && configuredKeyPath) {
      const keyPath = configuredKeyPath;
      await withEncryptedFileKeyLock({
        keyPath,
        run: () =>
          writeEncryptedFileKeyIfUnchangedLocked({ keyPath, key: existing }),
      });
    }
    cachedKeychainEncryptedFileKey = existing;
    encryptedFileKeyFailureCooldownUntilMs = 0;
    return {
      key: existing,
      source: "keychain",
    };
  }

  if (configuredKeyPath || !allowKeyProvisioning) {
    throw new SecretStoreKeyUnavailableError(
      buildEncryptedBackendKeyRecoveryMessage({
        keyPath: configuredKeyPath,
        storePath: input?.storePath,
        reason: "missing",
      })
    );
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    await keychain.set({
      service: ENCRYPTED_FILE_KEY_SERVICE,
      name: ENCRYPTED_FILE_KEY_NAME,
      value: generated,
    });
  } catch (error: unknown) {
    throw keychainKeyAccessError({
      error,
      keyPath: configuredKeyPath,
      storePath: input?.storePath,
    });
  }
  cachedKeychainEncryptedFileKey = generated;
  encryptedFileKeyFailureCooldownUntilMs = 0;
  return {
    key: generated,
    source: "generated",
  };
}

/**
 * Map a failed keychain call for the encrypted_file key. An invalid
 * `HACK_KEYCHAIN_TIMEOUT_MS` keeps its own usage refusal (no keychain call was
 * made, so no cooldown). A timeout keeps its closed message, which reports an
 * unknown outcome for a write, and starts the cooldown like any other failure.
 * Other failures become the fixed recovery message.
 */
function keychainKeyAccessError(input: {
  readonly error: unknown;
  readonly keyPath: string | undefined;
  readonly storePath: string | undefined;
}): Error {
  if (input.error instanceof CliUsageError) {
    return input.error;
  }
  encryptedFileKeyFailureCooldownUntilMs =
    Date.now() + ENCRYPTED_FILE_KEY_FAILURE_COOLDOWN_MS;
  if (input.error instanceof NativeKeychainTimeoutError) {
    return input.error;
  }
  return new SecretStoreKeyUnavailableError(
    buildEncryptedBackendKeyRecoveryMessage({
      keyPath: input.keyPath,
      storePath: input.storePath,
      reason: "keychain_access_failed",
    })
  );
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

/**
 * Reads the encrypted_file key file (HACK-2036, HACK-2169): opened without
 * following a link (a symlinked or non-regular key path is refused), and
 * refused when group or others can read or write it, or when git tracks it
 * (a committed key ships with the ciphertext). An absent or empty file is
 * no key. A git status that cannot be established is not treated as
 * tracked, as for the project env key.
 */
async function readEncryptedFileKey(input: {
  readonly keyPath: string;
}): Promise<string | null> {
  // Only the key file itself must not be a link; writes also check its
  // directory. A missing directory is no key.
  const read = await readReplaceablePrivateFile({
    path: input.keyPath,
    directories: [],
    refusal: () =>
      new SecretStoreKeyRefusedError(
        `Refused the encrypted secret key at ${input.keyPath}: it is a symlink or not a regular file (values omitted). Replace it with a regular file this user owns (mode 0600), then retry.`
      ),
  });
  const key = read?.text.trim() ?? "";
  if (read === null || key.length === 0) {
    return null;
  }
  if ((read.mode & 0o077) !== 0) {
    throw new SecretStoreKeyRefusedError(
      `Refused the encrypted secret key at ${input.keyPath}: other users can read or write it (mode ${(read.mode & 0o777).toString(8)}; values omitted). Run: chmod 600 ${input.keyPath}`
    );
  }
  const tracked = await isKeyFileTrackedByGit(input.keyPath);
  if (tracked === true) {
    throw new SecretStoreKeyRefusedError(
      `Refused the encrypted secret key at ${input.keyPath}: git tracks it, so it would be shared with the encrypted values (values omitted). Remove it from the repository (git rm --cached), rotate the key, then retry.`
    );
  }
  if (tracked === null) {
    throw new SecretStoreKeyRefusedError(
      `Refused the encrypted secret key at ${input.keyPath}: it is inside a git work tree, but git could not report whether it tracks it (git failed, is missing, or took longer than ${GIT_TRACKING_TIMEOUT_MS / 1000} s; values omitted). Make git status work there, or move the key outside the repository and update keyPath, then retry.`
    );
  }
  return key;
}

/** Bound on the git tracking probe; a slower git counts as unknown. */
const GIT_TRACKING_TIMEOUT_MS = 5000;

/**
 * Whether the real directory of `dir` (symlinks resolved, as git resolves
 * its working directory) or one of its ancestors holds a `.git` entry:
 * `inside`, `outside`, or `unknown` when that cannot be read.
 */
async function gitWorkTreeState(
  dir: string
): Promise<"inside" | "outside" | "unknown"> {
  let current: string;
  try {
    current = await realpath(dir);
  } catch {
    return "unknown";
  }
  for (;;) {
    try {
      await lstat(resolve(current, ".git"));
      return "inside";
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return "unknown";
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return "outside";
    }
    current = parent;
  }
}

/**
 * True when git tracks `path`, false when it does not: either no `.git`
 * is at or above its real directory (no repository to track it, and git is
 * not run), or git says so. Null when the key is inside a work tree but git cannot say
 * (it fails to run, exits unexpectedly, or exceeds the time bound): the
 * caller refuses that key rather than guess.
 */
async function isKeyFileTrackedByGit(path: string): Promise<boolean | null> {
  const workTree = await gitWorkTreeState(dirname(path));
  if (workTree === "outside") {
    return false;
  }
  if (workTree === "unknown") {
    return null;
  }
  let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    proc = Bun.spawn({
      cmd: [
        "git",
        "--literal-pathspecs",
        "-C",
        dirname(path),
        "ls-files",
        "--error-unmatch",
        "--",
        basename(path),
      ],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<null>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(null), GIT_TRACKING_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (exitCode === null) {
    proc.kill();
    return null;
  }
  if (exitCode === 0) {
    return true;
  }
  return exitCode === 1 ? false : null;
}

function encryptedFileKeyOptions(input: {
  readonly keyPath: string;
}): ReplaceablePrivateFileOptions {
  return {
    path: input.keyPath,
    directories: [dirname(input.keyPath)],
    refusal: () =>
      new Error(
        "Refused encrypted secret key write: the key path or its directory is aliased or not a regular file; values omitted."
      ),
  };
}

/**
 * First-use bootstrap of a generated key; returns the key now stored.
 *
 * Concurrent first users must converge on one key: a key that is replaced
 * after another process has encrypted the store with it leaves that store
 * undecryptable. The generated key is therefore published only when no key
 * file exists (complete contents, never a partial file); otherwise the key
 * already published is adopted. An existing empty key file is replaced as
 * before, since a published key is never empty.
 */
async function createOrAdoptEncryptedFileKey(input: {
  readonly keyPath: string;
  readonly key: string;
}): Promise<string> {
  return await withEncryptedFileKeyLock({
    keyPath: input.keyPath,
    run: () => createOrAdoptEncryptedFileKeyLocked(input),
  });
}

/** {@link createOrAdoptEncryptedFileKey}, holding the key file's lock. */
async function createOrAdoptEncryptedFileKeyLocked(input: {
  readonly keyPath: string;
  readonly key: string;
}): Promise<string> {
  const options = encryptedFileKeyOptions(input);
  if (
    await publishPrivateFileExclusive({ ...options, text: `${input.key}\n` })
  ) {
    return input.key;
  }
  const existing = (await readReplaceablePrivateFile(options))?.text.trim();
  if (existing) {
    return existing;
  }
  try {
    await replacePrivateFileAtomic({
      ...options,
      text: `${input.key}\n`,
      // Only while still empty: a key published meanwhile is adopted.
      beforeRename: async () => {
        if ((await readReplaceablePrivateFile(options))?.text.trim()) {
          throw new EncryptedFileKeyChangedError();
        }
      },
    });
  } catch (error: unknown) {
    const adopted = (await readReplaceablePrivateFile(options))?.text.trim();
    if (error instanceof EncryptedFileKeyChangedError && adopted) {
      return adopted;
    }
    throw error;
  }
  return input.key;
}

/**
 * Thrown when an encrypted store exists but cannot be read (HACK-2169). Only
 * a store that does not exist counts as empty: treating an unreadable one as
 * empty would let the next `set` replace it and lose every earlier entry,
 * other projects' included in a shared store.
 */
export class SecretStoreUnreadableError extends Error {
  constructor(filePath: string) {
    super(
      `The encrypted secret store at ${filePath} exists but could not be read, so it was not read or changed (values omitted). Fix its permissions or ownership (it should be a regular file this user can read and write), then retry.`
    );
    this.name = "SecretStoreUnreadableError";
  }
}

/**
 * Reads a store file the way every reader must (HACK-2036, HACK-2169):
 * without following a link, so a symlinked, non-regular or oversized store
 * is `refused`, not read through; any other failure to read an existing
 * store is `unreadable`, never empty. Use, get, set, doctor and
 * provisioning all classify a store through this one read.
 */
async function readEncryptedStoreText(
  filePath: string
): Promise<
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "refused" }
  | { readonly kind: "unreadable" }
> {
  try {
    const read = await readReplaceablePrivateFile({
      path: filePath,
      directories: [],
      refusal: () => new Error(ENCRYPTED_STORE_READ_REFUSAL),
      maxBytes: ENCRYPTED_STORE_FILE_LIMIT,
    });
    return read === null
      ? { kind: "absent" }
      : { kind: "text", text: read.text };
  } catch (error: unknown) {
    return error instanceof Error &&
      error.message === ENCRYPTED_STORE_READ_REFUSAL
      ? { kind: "refused" }
      : { kind: "unreadable" };
  }
}

async function readEncryptedEntries(input: {
  readonly filePath: string;
  readonly encryptionKey: string;
}): Promise<Record<string, string>> {
  const read = await readEncryptedStoreText(input.filePath);
  if (read.kind === "refused") {
    throw new Error(ENCRYPTED_STORE_READ_REFUSAL);
  }
  if (read.kind === "unreadable") {
    throw new SecretStoreUnreadableError(input.filePath);
  }
  if (read.kind === "absent" || read.text.length === 0) {
    return {};
  }
  return decryptEncryptedEntriesText({ ...input, text: read.text });
}

/** Parses and decrypts a store's text; every failure is a fixed, value-free error. */
function decryptEncryptedEntriesText(input: {
  readonly filePath: string;
  readonly text: string;
  readonly encryptionKey: string;
}): Record<string, string> {
  const { text } = input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid encrypted secret store JSON at ${input.filePath}: ${envParseDiagnostic({ format: "JSON", text })}.`
    );
  }

  const envelope = parseEncryptedEnvelope(parsed);
  if (!envelope) {
    throw new Error(
      `Invalid encrypted secret store payload at ${input.filePath}.`
    );
  }
  let plaintext: string;
  try {
    plaintext = decryptStore({
      envelope,
      encryptionKey: input.encryptionKey,
    });
  } catch {
    throw new Error(
      `Cannot decrypt encrypted secret store at ${input.filePath}: the key does not match or the payload was modified.`
    );
  }
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
  // Atomic same-directory replace with mode 0600. The configured store
  // location's ancestors are the user's choice and are not inspected.
  await replacePrivateFileAtomic({
    path: input.filePath,
    directories: [],
    text: `${JSON.stringify(envelope, null, 2)}\n`,
    refusal: () => new Error(ENCRYPTED_STORE_WRITE_REFUSAL),
  });
}

/**
 * Accepts only the v1 envelope with canonical padded base64 fields, a 12-byte
 * IV, a 16-byte tag and a bounded ciphertext. Anything else returns null so the
 * caller reports a fixed, value-free error.
 */
function parseEncryptedEnvelope(
  value: unknown
): ParsedEncryptedEnvelope | null {
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
  const iv = decodeCanonicalBase64({
    text: maybe.iv,
    maxBytes: ENCRYPTED_IV_BYTES,
  });
  const tag = decodeCanonicalBase64({
    text: maybe.tag,
    maxBytes: ENCRYPTED_TAG_BYTES,
  });
  const ciphertext = decodeCanonicalBase64({
    text: maybe.ciphertext,
    maxBytes: ENCRYPTED_CIPHERTEXT_LIMIT,
  });
  if (
    iv?.length !== ENCRYPTED_IV_BYTES ||
    tag?.length !== ENCRYPTED_TAG_BYTES ||
    ciphertext === null
  ) {
    return null;
  }
  return { iv, tag, ciphertext };
}

function parsePlaintextStore(value: string): PlaintextStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `Decrypted secret store payload: ${envParseDiagnostic({ format: "JSON", text: value })}.`
    );
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
  const cipher = createCipheriv(ENCRYPTED_ALGORITHM, key, iv, {
    authTagLength: ENCRYPTED_TAG_BYTES,
  });
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
  readonly envelope: ParsedEncryptedEnvelope;
  readonly encryptionKey: string;
}): string {
  const key = deriveEncryptionKey({ source: input.encryptionKey });
  const decipher = createDecipheriv(
    ENCRYPTED_ALGORITHM,
    key,
    input.envelope.iv,
    { authTagLength: ENCRYPTED_TAG_BYTES }
  );
  decipher.setAuthTag(input.envelope.tag);
  const plaintext = Buffer.concat([
    decipher.update(input.envelope.ciphertext),
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
