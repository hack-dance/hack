import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";

import { getString, isRecord } from "../../../lib/guards.ts";

export type GatewayTokenRecord = {
  readonly id: string;
  readonly hash: string;
  readonly scope: GatewayTokenScope;
  readonly label?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
};

export type GatewayTokenScope = "read" | "write";

export type GatewayTokenStore = {
  readonly version: 1;
  readonly tokens: readonly GatewayTokenRecord[];
};

const TOKEN_STORE_VERSION = 1 as const;
const GATEWAY_DIR = "gateway";
const TOKENS_FILENAME = "tokens.json";

/**
 * Read the gateway token store from disk.
 *
 * @param opts.rootDir - Daemon root directory.
 * @returns Parsed token store or an empty store if missing.
 */
export async function readGatewayTokenStore(opts: {
  readonly rootDir: string;
}): Promise<GatewayTokenStore> {
  const path = resolveGatewayTokensPath({ rootDir: opts.rootDir });
  const text = await readTrustedTokenStore({ path });
  if (!text) {
    return emptyTokenStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyTokenStore();
  }

  const store = parseGatewayTokenStore(parsed);
  return store ?? emptyTokenStore();
}

/**
 * Gateway tokens for status output: never throws for an untrusted store
 * ({@link GatewayTokenStoreUntrustedError}), which is reported as no
 * tokens plus `untrusted`, so `hack global status`, `hack remote status`
 * and doctor still finish when the gateway cannot use its store
 * (HACK-2142). Authentication keeps refusing such a store.
 */
export async function listGatewayTokensForStatus(opts: {
  readonly rootDir: string;
}): Promise<{
  readonly tokens: readonly GatewayTokenRecord[];
  readonly untrusted: string | null;
}> {
  try {
    return { tokens: await listGatewayTokens(opts), untrusted: null };
  } catch (error: unknown) {
    if (error instanceof GatewayTokenStoreUntrustedError) {
      return { tokens: [], untrusted: error.message };
    }
    throw error;
  }
}

/**
 * Write the gateway token store to disk.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.store - Token store to persist.
 */
export async function writeGatewayTokenStore(opts: {
  readonly rootDir: string;
  readonly store: GatewayTokenStore;
}): Promise<void> {
  const dir = resolveGatewayDir({ rootDir: opts.rootDir });
  // Owner-only from creation: hackd appends here (HACK-2142).
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = resolveGatewayTokensPath({ rootDir: opts.rootDir });
  await writeOwnerOnlyReplacing({
    path,
    text: `${JSON.stringify(opts.store, null, 2)}\n`,
  });
}

/**
 * The token store could have been changed by someone else (HACK-2142): it
 * is not this user's plain file, or group or others can write it (a store
 * written before 0600 stores, under umask 0002, is 0664). Its token hashes
 * cannot be trusted, so the gateway refuses it; hackd itself still starts.
 */
export class GatewayTokenStoreUntrustedError extends Error {
  constructor(opts: { readonly path: string; readonly detail: string }) {
    super(
      `${opts.path} ${opts.detail}, so its tokens cannot be trusted and the gateway does not use them. Remove it and issue tokens again: rm ${opts.path} && hack x gateway token-create`
    );
    this.name = "GatewayTokenStoreUntrustedError";
  }
}

/**
 * The store's text, read through one open that does not follow a link
 * (and does not block on a FIFO), with the checks applied to that open
 * file: no gap between checking and reading (HACK-2142). Null when there
 * is no store.
 */
async function readTrustedTokenStore(opts: {
  readonly path: string;
}): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      opts.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "ENOENT") {
      return null;
    }
    // A link, or an entry this user cannot open (another account's file):
    // not usable, so refused like any other untrusted store, which status
    // output reports as a warning (HACK-2142).
    throw new GatewayTokenStoreUntrustedError({
      path: opts.path,
      detail:
        code === "ELOOP"
          ? "is not a plain file"
          : `could not be opened (${typeof code === "string" ? code : String(error)})`,
    });
  }
  try {
    const detail = untrustedStoreDetail(await handle.stat());
    if (detail !== null) {
      throw new GatewayTokenStoreUntrustedError({ path: opts.path, detail });
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Why a token store entry cannot be trusted, or null. */
function untrustedStoreDetail(info: Stats): string | null {
  const uid = process.getuid?.() ?? -1;
  if (info.isSymbolicLink() || !info.isFile()) {
    return "is not a plain file";
  }
  if (info.nlink > 1) {
    return "has other hard links";
  }
  if (uid >= 0 && info.uid !== uid) {
    return `is owned by another user (uid ${info.uid})`;
  }
  const mode = Number(info.mode);
  return (mode & 0o022) === 0
    ? null
    : `could be written by other users (mode ${(mode & 0o777).toString(8)})`;
}

/**
 * Replaces `path` without writing through it (HACK-2142): an existing entry
 * must be this user's plain file (not a link, not hard-linked elsewhere),
 * else the write is refused; the text goes to a new owner-only file
 * (exclusive create) that is renamed over it, so a link planted after the
 * check is replaced, never followed.
 */
async function writeOwnerOnlyReplacing(opts: {
  readonly path: string;
  readonly text: string;
}): Promise<void> {
  const uid = process.getuid?.() ?? -1;
  const existing = await lstat(opts.path).catch(() => null);
  if (
    existing !== null &&
    (existing.isSymbolicLink() ||
      !existing.isFile() ||
      existing.nlink > 1 ||
      (uid >= 0 && existing.uid !== uid))
  ) {
    throw new Error(
      `${opts.path} is not a plain file of this user's (a link, a hard link or another user's entry); review and remove it`
    );
  }
  const temp = `${opts.path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(opts.text);
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, opts.path);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Create a new gateway token.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.label - Optional label to help identify the token.
 * @returns Plaintext token and stored record.
 */
export async function createGatewayToken(opts: {
  readonly rootDir: string;
  readonly label?: string;
  readonly scope?: GatewayTokenScope;
}): Promise<{ readonly token: string; readonly record: GatewayTokenRecord }> {
  const store = await readGatewayTokenStore({ rootDir: opts.rootDir });
  const token = randomBytes(32).toString("base64url");
  const label = normalizeLabel({ value: opts.label });
  const scope = normalizeScope({ value: opts.scope });
  const record: GatewayTokenRecord = {
    id: randomUUID(),
    hash: hashToken({ token }),
    scope,
    ...(label ? { label } : {}),
    createdAt: new Date().toISOString(),
  };

  const next: GatewayTokenStore = {
    version: TOKEN_STORE_VERSION,
    tokens: [...store.tokens, record],
  };
  await writeGatewayTokenStore({ rootDir: opts.rootDir, store: next });
  return { token, record };
}

/**
 * List gateway tokens.
 *
 * @param opts.rootDir - Daemon root directory.
 * @returns Token records.
 */
export async function listGatewayTokens(opts: {
  readonly rootDir: string;
}): Promise<readonly GatewayTokenRecord[]> {
  const store = await readGatewayTokenStore({ rootDir: opts.rootDir });
  return store.tokens;
}

/**
 * Revoke a gateway token by id.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.tokenId - Token id to revoke.
 * @returns True when a token was revoked.
 */
export async function revokeGatewayToken(opts: {
  readonly rootDir: string;
  readonly tokenId: string;
}): Promise<boolean> {
  const store = await readGatewayTokenStore({ rootDir: opts.rootDir });
  const idx = store.tokens.findIndex((token) => token.id === opts.tokenId);
  if (idx === -1) {
    return false;
  }

  const existing = store.tokens[idx];
  if (!existing) {
    return false;
  }
  if (existing?.revokedAt) {
    return false;
  }

  const updated: GatewayTokenRecord = {
    ...existing,
    revokedAt: new Date().toISOString(),
  };

  const nextTokens = store.tokens.map((token, index) =>
    index === idx ? updated : token
  );
  const next: GatewayTokenStore = {
    version: TOKEN_STORE_VERSION,
    tokens: nextTokens,
  };
  await writeGatewayTokenStore({ rootDir: opts.rootDir, store: next });
  return true;
}

/**
 * Verify a gateway token and update last-used timestamp.
 *
 * @param opts.rootDir - Daemon root directory.
 * @param opts.token - Plaintext token to verify.
 * @returns Token record when valid, otherwise null.
 */
export async function verifyGatewayToken(opts: {
  readonly rootDir: string;
  readonly token: string;
}): Promise<GatewayTokenRecord | null> {
  const store = await readGatewayTokenStore({ rootDir: opts.rootDir });
  const hash = hashToken({ token: opts.token });
  const match =
    store.tokens.find((token) => token.hash === hash && !token.revokedAt) ??
    null;
  if (!match) {
    return null;
  }

  const updated: GatewayTokenRecord = {
    ...match,
    lastUsedAt: new Date().toISOString(),
  };
  const nextTokens = store.tokens.map((token) =>
    token.id === match.id ? updated : token
  );
  const next: GatewayTokenStore = {
    version: TOKEN_STORE_VERSION,
    tokens: nextTokens,
  };
  await writeGatewayTokenStore({ rootDir: opts.rootDir, store: next });
  return updated;
}

function resolveGatewayDir(opts: { readonly rootDir: string }): string {
  return resolve(opts.rootDir, GATEWAY_DIR);
}

function resolveGatewayTokensPath(opts: { readonly rootDir: string }): string {
  return resolve(resolveGatewayDir({ rootDir: opts.rootDir }), TOKENS_FILENAME);
}

function emptyTokenStore(): GatewayTokenStore {
  return { version: TOKEN_STORE_VERSION, tokens: [] };
}

function parseGatewayTokenStore(value: unknown): GatewayTokenStore | null {
  if (!isRecord(value)) {
    return null;
  }
  const versionRaw = value.version;
  const version = typeof versionRaw === "number" ? versionRaw : null;
  if (version !== TOKEN_STORE_VERSION) {
    return null;
  }
  const tokensRaw = value.tokens;
  if (!Array.isArray(tokensRaw)) {
    return null;
  }

  const tokens: GatewayTokenRecord[] = [];
  for (const item of tokensRaw) {
    const token = parseGatewayToken(item);
    if (token) {
      tokens.push(token);
    }
  }

  return { version: TOKEN_STORE_VERSION, tokens };
}

function parseGatewayToken(value: unknown): GatewayTokenRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, "id");
  const hash = getString(value, "hash");
  const createdAt = getString(value, "createdAt");
  if (!(id && hash && createdAt)) {
    return null;
  }
  const scope = parseScope(value);
  const label = getString(value, "label") ?? undefined;
  const lastUsedAt = getString(value, "lastUsedAt") ?? undefined;
  const revokedAt = getString(value, "revokedAt") ?? undefined;
  return {
    id,
    hash,
    scope,
    ...(label ? { label } : {}),
    createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function hashToken(opts: { readonly token: string }): string {
  return createHash("sha256").update(opts.token).digest("hex");
}

function normalizeLabel(opts: { readonly value?: string }): string | undefined {
  const raw = opts.value?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function normalizeScope(opts: {
  readonly value?: GatewayTokenScope;
}): GatewayTokenScope {
  return opts.value === "write" ? "write" : "read";
}

function parseScope(value: Record<string, unknown>): GatewayTokenScope {
  const raw = getString(value, "scope");
  return raw === "write" ? "write" : "read";
}
