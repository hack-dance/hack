import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ensureDir, readTextFile, writeTextFile } from "../../../lib/fs.ts";
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
  const text = await readTextFile(path);
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
  await ensureDir(dir);
  const path = resolveGatewayTokensPath({ rootDir: opts.rootDir });
  await writeTextFile(path, `${JSON.stringify(opts.store, null, 2)}\n`);
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
