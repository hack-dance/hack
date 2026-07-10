import { createHash, randomInt, randomUUID } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GLOBAL_NODE_PAIRINGS_REGISTRY_FILENAME,
  GLOBAL_REGISTRY_DIR_NAME,
} from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

const NODE_PAIRINGS_VERSION = 1 as const;
const PAIRINGS_LOCK_FILENAME = `${GLOBAL_NODE_PAIRINGS_REGISTRY_FILENAME}.lock`;
const PAIRINGS_LOCK_TIMEOUT_MS = 2000;
const PAIRINGS_LOCK_STALE_MS = 30_000;
const PAIRINGS_LOCK_RETRY_MS = 50;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

export type NodePairingStatus =
  | "pending"
  | "consumed"
  | "cancelled"
  | "expired";

export interface NodePairingSession {
  readonly id: string;
  readonly source: string;
  readonly endpoint: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: NodePairingStatus;
  readonly updatedAt: string;
  readonly consumedAt?: string;
}

interface NodePairingsRegistry {
  readonly version: typeof NODE_PAIRINGS_VERSION;
  readonly sessions: readonly NodePairingSession[];
}

function resolveGlobalRoot(): string {
  const configPath = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configPath.length > 0) {
    return dirname(configPath);
  }
  return resolveGlobalHackDir();
}

function getPairingsPath(): string {
  return resolve(
    resolveGlobalRoot(),
    GLOBAL_REGISTRY_DIR_NAME,
    GLOBAL_NODE_PAIRINGS_REGISTRY_FILENAME
  );
}

function getPairingsLockPath(): string {
  return resolve(
    resolveGlobalRoot(),
    GLOBAL_REGISTRY_DIR_NAME,
    PAIRINGS_LOCK_FILENAME
  );
}

function parsePairingStatus(value: string | undefined): NodePairingStatus {
  if (
    value === "pending" ||
    value === "consumed" ||
    value === "cancelled" ||
    value === "expired"
  ) {
    return value;
  }
  return "expired";
}

function parsePairing(value: unknown): NodePairingSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, "id");
  const source = getString(value, "source");
  const endpoint = getString(value, "endpoint");
  const codeHash = getString(value, "codeHash");
  const createdAt = getString(value, "createdAt");
  const expiresAt = getString(value, "expiresAt");
  const updatedAt = getString(value, "updatedAt");
  if (
    !(
      id &&
      source &&
      endpoint &&
      codeHash &&
      createdAt &&
      expiresAt &&
      updatedAt
    )
  ) {
    return null;
  }
  const status = parsePairingStatus(getString(value, "status") ?? undefined);
  const consumedAt = getString(value, "consumedAt") ?? undefined;
  return {
    id,
    source,
    endpoint,
    codeHash,
    createdAt,
    expiresAt,
    status,
    updatedAt,
    ...(consumedAt ? { consumedAt } : {}),
  };
}

function parseRegistry(value: unknown): NodePairingsRegistry | null {
  if (!isRecord(value)) {
    return null;
  }
  const version =
    typeof value.version === "number" ? Math.trunc(value.version) : null;
  if (version === null || version < 1) {
    return null;
  }
  const sessionsRaw = Array.isArray(value.sessions) ? value.sessions : [];
  const sessions: NodePairingSession[] = [];
  const seen = new Set<string>();
  for (const entry of sessionsRaw) {
    const parsed = parsePairing(entry);
    if (!(parsed && !seen.has(parsed.id))) {
      continue;
    }
    seen.add(parsed.id);
    sessions.push(parsed);
  }
  return {
    version: NODE_PAIRINGS_VERSION,
    sessions,
  };
}

function normalizeRegistry(
  value: NodePairingsRegistry | null
): NodePairingsRegistry {
  if (!value) {
    return { version: NODE_PAIRINGS_VERSION, sessions: [] };
  }
  return {
    version: NODE_PAIRINGS_VERSION,
    sessions: [...value.sessions],
  };
}

async function writePairingsRegistry(
  registry: NodePairingsRegistry
): Promise<void> {
  const path = getPairingsPath();
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(tmp, path);
}

export async function readNodePairingsRegistry(): Promise<NodePairingsRegistry> {
  const text = await readTextFile(getPairingsPath());
  if (!text) {
    return { version: NODE_PAIRINGS_VERSION, sessions: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: NODE_PAIRINGS_VERSION, sessions: [] };
  }
  return normalizeRegistry(parseRegistry(parsed));
}

function buildPairingCode(): string {
  const raw = randomInt(0, 1_000_000);
  return raw.toString().padStart(6, "0");
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export async function createNodePairingSession(input: {
  readonly source: string;
  readonly endpoint: string;
  readonly ttlMs?: number;
  readonly nowIso?: string;
}): Promise<{ readonly session: NodePairingSession; readonly code: string }> {
  return await withPairingsLock(async () => {
    const registry = await readNodePairingsRegistry();
    const nowIso = input.nowIso ?? new Date().toISOString();
    const ttlMs = Math.max(
      30_000,
      Math.trunc(input.ttlMs ?? DEFAULT_PAIRING_TTL_MS)
    );
    const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    const code = buildPairingCode();
    const session: NodePairingSession = {
      id: randomUUID(),
      source: input.source.trim(),
      endpoint: input.endpoint.trim(),
      codeHash: hashPairingCode(code),
      createdAt: nowIso,
      expiresAt,
      status: "pending",
      updatedAt: nowIso,
    };
    const nextRegistry = pruneExpiredSessions({
      registry: {
        ...registry,
        sessions: [...registry.sessions, session],
      },
      nowIso,
    });
    await writePairingsRegistry(nextRegistry);
    return { session, code };
  });
}

export async function consumeNodePairingSession(input: {
  readonly sessionId: string;
  readonly code: string;
  readonly nowIso?: string;
}): Promise<
  | { readonly ok: true; readonly session: NodePairingSession }
  | { readonly ok: false; readonly error: string }
> {
  return await withPairingsLock(async () => {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const registry = pruneExpiredSessions({
      registry: await readNodePairingsRegistry(),
      nowIso,
    });
    const index = registry.sessions.findIndex(
      (entry) => entry.id === input.sessionId.trim()
    );
    if (index === -1) {
      await writePairingsRegistry(registry);
      return {
        ok: false,
        error: `Unknown pairing session: ${input.sessionId}`,
      };
    }
    const session = registry.sessions[index];
    if (!session) {
      await writePairingsRegistry(registry);
      return {
        ok: false,
        error: `Unknown pairing session: ${input.sessionId}`,
      };
    }
    if (session.status === "expired") {
      await writePairingsRegistry(registry);
      return { ok: false, error: "Pairing session expired." };
    }
    if (session.status === "cancelled") {
      await writePairingsRegistry(registry);
      return { ok: false, error: "Pairing session cancelled." };
    }
    if (session.status === "consumed") {
      await writePairingsRegistry(registry);
      return { ok: false, error: "Pairing session already consumed." };
    }
    if (hashPairingCode(input.code.trim()) !== session.codeHash) {
      await writePairingsRegistry(registry);
      return { ok: false, error: "Invalid pairing code." };
    }
    const consumed: NodePairingSession = {
      ...session,
      status: "consumed",
      consumedAt: nowIso,
      updatedAt: nowIso,
    };
    const nextSessions = [...registry.sessions];
    nextSessions[index] = consumed;
    const nextRegistry = {
      ...registry,
      sessions: nextSessions,
    };
    await writePairingsRegistry(nextRegistry);
    return { ok: true, session: consumed };
  });
}

export async function cancelNodePairingSession(input: {
  readonly sessionId: string;
  readonly nowIso?: string;
}): Promise<{
  readonly cancelled: boolean;
  readonly session?: NodePairingSession;
}> {
  return await withPairingsLock(async () => {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const registry = pruneExpiredSessions({
      registry: await readNodePairingsRegistry(),
      nowIso,
    });
    const index = registry.sessions.findIndex(
      (entry) => entry.id === input.sessionId.trim()
    );
    if (index === -1) {
      await writePairingsRegistry(registry);
      return { cancelled: false };
    }
    const session = registry.sessions[index];
    if (!session) {
      await writePairingsRegistry(registry);
      return { cancelled: false };
    }
    if (session.status !== "pending") {
      await writePairingsRegistry(registry);
      return { cancelled: false, session };
    }
    const cancelled: NodePairingSession = {
      ...session,
      status: "cancelled",
      updatedAt: nowIso,
    };
    const nextSessions = [...registry.sessions];
    nextSessions[index] = cancelled;
    await writePairingsRegistry({ ...registry, sessions: nextSessions });
    return { cancelled: true, session: cancelled };
  });
}

export async function getNodePairingSession(input: {
  readonly sessionId: string;
  readonly nowIso?: string;
}): Promise<NodePairingSession | null> {
  return await withPairingsLock(async () => {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const registry = pruneExpiredSessions({
      registry: await readNodePairingsRegistry(),
      nowIso,
    });
    await writePairingsRegistry(registry);
    return (
      registry.sessions.find((entry) => entry.id === input.sessionId.trim()) ??
      null
    );
  });
}

export async function listNodePairingSessions(input?: {
  readonly status?: NodePairingStatus | "all";
  readonly nowIso?: string;
  readonly limit?: number;
}): Promise<readonly NodePairingSession[]> {
  return await withPairingsLock(async () => {
    const nowIso = input?.nowIso ?? new Date().toISOString();
    const registry = pruneExpiredSessions({
      registry: await readNodePairingsRegistry(),
      nowIso,
    });
    await writePairingsRegistry(registry);

    const filtered =
      input?.status && input.status !== "all"
        ? registry.sessions.filter((session) => session.status === input.status)
        : [...registry.sessions];

    filtered.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
    const limit = Math.max(0, Math.trunc(input?.limit ?? 0));
    if (limit > 0) {
      return filtered.slice(0, limit);
    }
    return filtered;
  });
}

function pruneExpiredSessions(input: {
  readonly registry: NodePairingsRegistry;
  readonly nowIso: string;
}): NodePairingsRegistry {
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(nowMs)) {
    return input.registry;
  }
  let changed = false;
  const nextSessions = input.registry.sessions.map((session) => {
    if (session.status !== "pending") {
      return session;
    }
    const expiresMs = Date.parse(session.expiresAt);
    if (!(Number.isFinite(expiresMs) && expiresMs <= nowMs)) {
      return session;
    }
    changed = true;
    return {
      ...session,
      status: "expired" as const,
      updatedAt: input.nowIso,
    };
  });
  if (!changed) {
    return input.registry;
  }
  return { ...input.registry, sessions: nextSessions };
}

async function withPairingsLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquirePairingsLock();
  try {
    return await fn();
  } finally {
    await releasePairingsLock();
  }
}

async function acquirePairingsLock(): Promise<void> {
  const lockPath = getPairingsLockPath();
  await ensureDir(dirname(lockPath));
  const start = Date.now();

  while (true) {
    try {
      const file = await open(lockPath, "wx");
      await file.writeFile(`${process.pid}\n`);
      await file.close();
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - start > PAIRINGS_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for node pairings registry lock");
      }
      await Bun.sleep(PAIRINGS_LOCK_RETRY_MS);
    }
  }
}

async function releasePairingsLock(): Promise<void> {
  const lockPath = getPairingsLockPath();
  await unlink(lockPath).catch(() => undefined);
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > PAIRINGS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}
