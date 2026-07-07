import { randomUUID } from "node:crypto";
import { open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  GLOBAL_NODES_REGISTRY_FILENAME,
  GLOBAL_REGISTRY_DIR_NAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { resolveSecretStore, type SecretStore } from "./secret-store.ts";
import { exec } from "./shell.ts";

const NODES_REGISTRY_VERSION = 1 as const;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_OFFLINE_AFTER_MS = 120_000;
const NODE_SECRET_STORE_PROJECT_NAME = "node-registry";
const NODE_KEYCHAIN_SERVICE = "hack-node-registry";
const REGISTRY_LOCK_FILENAME = `${GLOBAL_NODES_REGISTRY_FILENAME}.lock`;
const REGISTRY_LOCK_TIMEOUT_MS = 2000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_RETRY_MS = 50;
const ENV_AUTH_REF_PREFIX = "env:";
const TRAILING_SLASH_PATTERN = /\/+$/;

export type NodeStatus = "healthy" | "stale" | "offline" | "unknown";

export interface NodeRecord {
  readonly id: string;
  readonly name: string;
  readonly source?: string;
  readonly labels: readonly string[];
  readonly capabilities: readonly string[];
  readonly endpoint: string;
  readonly authRef: string;
  readonly lastSeenAt?: string;
  readonly status?: NodeStatus;
  readonly version?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NodesRegistry {
  readonly version: typeof NODES_REGISTRY_VERSION;
  readonly defaultNodeId: string | null;
  readonly nodes: readonly NodeRecord[];
}

export interface NodeHealthInput {
  readonly lastSeenAt?: string;
  readonly nowIso?: string;
  readonly staleAfterMs?: number;
  readonly offlineAfterMs?: number;
}

type ParsedNodesRegistry = {
  readonly version: number;
  readonly defaultNodeId?: string | null;
  readonly nodes: readonly NodeRecord[];
};

function resolveGlobalRoot(): string {
  const configPath = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configPath.length > 0) {
    return dirname(configPath);
  }
  return resolveGlobalHackDir();
}

function getRegistryPath(): string {
  return resolve(
    resolveGlobalRoot(),
    GLOBAL_REGISTRY_DIR_NAME,
    GLOBAL_NODES_REGISTRY_FILENAME
  );
}

function getRegistryLockPath(): string {
  return resolve(
    resolveGlobalRoot(),
    GLOBAL_REGISTRY_DIR_NAME,
    REGISTRY_LOCK_FILENAME
  );
}

function normalizeLabels(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const label = raw.trim();
    if (!(label && !seen.has(label))) {
      continue;
    }
    seen.add(label);
    out.push(label);
  }
  return out;
}

function normalizeCapabilities(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const capability = raw.trim();
    if (!(capability && !seen.has(capability))) {
      continue;
    }
    seen.add(capability);
    out.push(capability);
  }
  return out;
}

function sanitizeNodeStatus(value: string | undefined): NodeStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value === "healthy" ||
    value === "stale" ||
    value === "offline" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function parseNodeRecord(value: unknown): NodeRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, "id");
  const name = getString(value, "name");
  const source = getString(value, "source");
  const endpoint = getString(value, "endpoint");
  const authRef = getString(value, "authRef");
  const createdAt = getString(value, "createdAt");
  const updatedAt = getString(value, "updatedAt");
  if (!(id && name && endpoint && authRef && createdAt && updatedAt)) {
    return null;
  }

  const labels = Array.isArray(value.labels)
    ? value.labels.filter((entry) => typeof entry === "string")
    : [];
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((entry) => typeof entry === "string")
    : [];
  const lastSeenAt = getString(value, "lastSeenAt") ?? undefined;
  const status = sanitizeNodeStatus(getString(value, "status") ?? undefined);
  const version = getString(value, "version") ?? undefined;
  const platform = getString(value, "platform") ?? undefined;
  const arch = getString(value, "arch") ?? undefined;

  return {
    id,
    name,
    ...(source ? { source: source.trim() } : {}),
    labels: normalizeLabels(labels),
    capabilities: normalizeCapabilities(capabilities),
    endpoint: endpoint.trim().replace(TRAILING_SLASH_PATTERN, ""),
    authRef,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(status ? { status } : {}),
    ...(version ? { version } : {}),
    ...(platform ? { platform } : {}),
    ...(arch ? { arch } : {}),
    createdAt,
    updatedAt,
  };
}

function parseRegistry(value: unknown): ParsedNodesRegistry | null {
  if (!isRecord(value)) {
    return null;
  }
  const version =
    typeof value.version === "number" ? Math.trunc(value.version) : null;
  if (version === null || version < 1) {
    return null;
  }
  const nodesRaw = Array.isArray(value.nodes) ? value.nodes : [];
  const nodes: NodeRecord[] = [];
  const seenNodeIds = new Set<string>();
  for (const raw of nodesRaw) {
    const parsed = parseNodeRecord(raw);
    if (!(parsed && !seenNodeIds.has(parsed.id))) {
      continue;
    }
    seenNodeIds.add(parsed.id);
    nodes.push(parsed);
  }
  let defaultNodeId: string | null | undefined;
  if (typeof value.defaultNodeId === "string") {
    defaultNodeId = value.defaultNodeId;
  } else if (value.defaultNodeId === null) {
    defaultNodeId = null;
  } else {
    defaultNodeId = undefined;
  }
  return {
    version,
    ...(defaultNodeId !== undefined ? { defaultNodeId } : {}),
    nodes,
  };
}

function normalizeRegistry(input: ParsedNodesRegistry | null): NodesRegistry {
  if (!input) {
    return { version: NODES_REGISTRY_VERSION, defaultNodeId: null, nodes: [] };
  }
  const ids = new Set(input.nodes.map((node) => node.id));
  const defaultNodeId =
    typeof input.defaultNodeId === "string" && ids.has(input.defaultNodeId)
      ? input.defaultNodeId
      : null;
  return {
    version: NODES_REGISTRY_VERSION,
    defaultNodeId,
    nodes: [...input.nodes],
  };
}

async function writeRegistry(registry: NodesRegistry): Promise<void> {
  const path = getRegistryPath();
  await ensureDir(dirname(path));
  const next = `${JSON.stringify(registry, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, next);
  await rename(tmp, path);
}

export async function readNodesRegistry(): Promise<NodesRegistry> {
  const text = await readTextFile(getRegistryPath());
  if (!text) {
    return { version: NODES_REGISTRY_VERSION, defaultNodeId: null, nodes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: NODES_REGISTRY_VERSION, defaultNodeId: null, nodes: [] };
  }
  return normalizeRegistry(parseRegistry(parsed));
}

export async function upsertNodeRecord(input: {
  readonly id?: string;
  readonly name: string;
  readonly source?: string;
  readonly labels?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly endpoint: string;
  readonly authRef: string;
  readonly status?: NodeStatus;
  readonly lastSeenAt?: string;
  readonly version?: string;
  readonly platform?: string;
  readonly arch?: string;
}): Promise<{ readonly node: NodeRecord; readonly created: boolean }> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Registry upsert preserves explicit merge behavior inside the lock boundary.
  return await withRegistryLock(async () => {
    const registry = await readNodesRegistry();
    const nowIso = new Date().toISOString();
    const nodeId = input.id?.trim() || randomUUID();
    const existingIndex = registry.nodes.findIndex(
      (node) => node.id === nodeId
    );
    const existing = existingIndex >= 0 ? registry.nodes[existingIndex] : null;
    const source = input.source?.trim() || existing?.source;
    const node: NodeRecord = {
      id: nodeId,
      name: input.name.trim(),
      ...(source ? { source } : {}),
      labels: normalizeLabels([...(input.labels ?? [])]),
      capabilities: normalizeCapabilities([
        ...(input.capabilities ?? ["runtime", "gateway", "supervisor"]),
      ]),
      endpoint: input.endpoint.trim().replace(TRAILING_SLASH_PATTERN, ""),
      authRef: input.authRef.trim(),
      ...(input.lastSeenAt ? { lastSeenAt: input.lastSeenAt } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.version ? { version: input.version } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.arch ? { arch: input.arch } : {}),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    const nextNodes = [...registry.nodes];
    if (existingIndex >= 0) {
      nextNodes[existingIndex] = node;
    } else {
      nextNodes.push(node);
    }

    const nextRegistry: NodesRegistry = {
      ...registry,
      nodes: nextNodes,
    };
    await writeRegistry(nextRegistry);
    return { node, created: existingIndex === -1 };
  });
}

export async function removeNodeRecord(input: {
  readonly id: string;
}): Promise<{ readonly removed: boolean; readonly node?: NodeRecord }> {
  return await withRegistryLock(async () => {
    const registry = await readNodesRegistry();
    const index = registry.nodes.findIndex((node) => node.id === input.id);
    if (index === -1) {
      return { removed: false };
    }
    const node = registry.nodes[index];
    const nextNodes = [...registry.nodes];
    nextNodes.splice(index, 1);
    const nextRegistry: NodesRegistry = {
      ...registry,
      nodes: nextNodes,
      defaultNodeId:
        registry.defaultNodeId === input.id ? null : registry.defaultNodeId,
    };
    await writeRegistry(nextRegistry);
    return { removed: true, ...(node ? { node } : {}) };
  });
}

export async function setDefaultNode(input: {
  readonly id: string | null;
}): Promise<NodesRegistry> {
  return await withRegistryLock(async () => {
    const registry = await readNodesRegistry();
    if (input.id !== null) {
      const exists = registry.nodes.some((node) => node.id === input.id);
      if (!exists) {
        throw new Error(`Unknown node id: ${input.id}`);
      }
    }
    const next: NodesRegistry = { ...registry, defaultNodeId: input.id };
    await writeRegistry(next);
    return next;
  });
}

export async function touchNode(input: {
  readonly id: string;
  readonly nowIso?: string;
  readonly status?: NodeStatus;
  readonly version?: string;
  readonly platform?: string;
  readonly arch?: string;
}): Promise<NodeRecord | null> {
  return await withRegistryLock(async () => {
    const registry = await readNodesRegistry();
    const index = registry.nodes.findIndex((node) => node.id === input.id);
    if (index === -1) {
      return null;
    }
    const node = registry.nodes[index];
    if (!node) {
      return null;
    }
    const nowIso = input.nowIso ?? new Date().toISOString();
    const updated: NodeRecord = {
      ...node,
      lastSeenAt: nowIso,
      ...(input.status ? { status: input.status } : {}),
      ...(input.version ? { version: input.version } : {}),
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.arch ? { arch: input.arch } : {}),
      updatedAt: nowIso,
    };
    const nextNodes = [...registry.nodes];
    nextNodes[index] = updated;
    await writeRegistry({ ...registry, nodes: nextNodes });
    return updated;
  });
}

export function deriveNodeHealth(input: NodeHealthInput): NodeStatus {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const offlineAfterMs = input.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
  if (!input.lastSeenAt) {
    return "offline";
  }
  const nowMs = Date.parse(nowIso);
  const seenMs = Date.parse(input.lastSeenAt);
  if (!(Number.isFinite(nowMs) && Number.isFinite(seenMs))) {
    return "unknown";
  }
  const ageMs = Math.max(0, nowMs - seenMs);
  if (ageMs >= offlineAfterMs) {
    return "offline";
  }
  if (ageMs >= staleAfterMs) {
    return "stale";
  }
  return "healthy";
}

export async function saveNodeAuthToken(input: {
  readonly authRef: string;
  readonly token: string;
}): Promise<void> {
  const envAuthRef = await resolveAllowedEnvAuthRef(input.authRef);
  if (envAuthRef) {
    process.env[envAuthRef] = input.token;
    return;
  }
  const store = await resolveNodeAuthSecretStore();
  await store.set({ key: input.authRef, value: input.token });
}

export async function readNodeAuthToken(input: {
  readonly authRef: string;
}): Promise<string | null> {
  const envAuthRef = await resolveAllowedEnvAuthRef(input.authRef);
  if (envAuthRef) {
    const token = (process.env[envAuthRef] ?? "").trim();
    return token.length > 0 ? token : null;
  }
  const store = await resolveNodeAuthSecretStore();
  return await store.get({ key: input.authRef });
}

export async function deleteNodeAuthToken(input: {
  readonly authRef: string;
}): Promise<boolean> {
  const envAuthRef = await resolveAllowedEnvAuthRef(input.authRef);
  if (envAuthRef) {
    const existed = Object.hasOwn(process.env, envAuthRef);
    delete process.env[envAuthRef];
    return existed;
  }
  const store = await resolveNodeAuthSecretStore();
  return await store.delete({ key: input.authRef });
}

function resolveEnvAuthRef(authRef: string): string | null {
  const trimmed = authRef.trim();
  if (!trimmed.startsWith(ENV_AUTH_REF_PREFIX)) {
    return null;
  }
  const envName = trimmed.slice(ENV_AUTH_REF_PREFIX.length).trim();
  return envName.length > 0 ? envName : null;
}

async function resolveAllowedEnvAuthRef(
  authRef: string
): Promise<string | null> {
  const envAuthRef = resolveEnvAuthRef(authRef);
  if (!envAuthRef) {
    return null;
  }
  const controlPlane = await readControlPlaneConfig({});
  if (controlPlane.config.secrets.allowEnvAuthRefs) {
    return envAuthRef;
  }
  throw new Error(
    "Environment auth refs are disabled by controlPlane.secrets.allowEnvAuthRefs=false."
  );
}

async function resolveNodeAuthSecretStore() {
  const controlPlane = await readControlPlaneConfig({});
  if (controlPlane.config.secrets.backend === "keychain") {
    const securityStore = resolveMacOsNodeAuthSecretStore();
    if (securityStore) {
      return securityStore;
    }
  }
  return await resolveSecretStore({
    projectName: NODE_SECRET_STORE_PROJECT_NAME,
  });
}

function resolveMacOsNodeAuthSecretStore(): SecretStore | null {
  if (!(process.platform === "darwin" && Bun.which("security"))) {
    return null;
  }
  return {
    descriptor: {
      backend: "keychain",
      location: NODE_KEYCHAIN_SERVICE,
      mode: "native",
    },
    get: async ({ key }) => {
      const found = await exec(
        [
          "security",
          "find-generic-password",
          "-s",
          NODE_KEYCHAIN_SERVICE,
          "-a",
          key,
          "-w",
        ],
        { stdin: "ignore" }
      );
      if (found.exitCode === 0) {
        const token = found.stdout.trim();
        return token.length > 0 ? token : null;
      }
      const errorText = `${found.stderr}\n${found.stdout}`.toLowerCase();
      if (
        errorText.includes("could not be found") ||
        errorText.includes("item could not be found")
      ) {
        return null;
      }
      throw new Error(
        normalizeSecurityErrorMessage({
          action: "read",
          detail: found.stderr || found.stdout,
        })
      );
    },
    set: async ({ key, value }) => {
      const saved = await exec(
        [
          "security",
          "add-generic-password",
          "-U",
          "-s",
          NODE_KEYCHAIN_SERVICE,
          "-a",
          key,
          "-w",
          value,
        ],
        { stdin: "ignore" }
      );
      if (saved.exitCode === 0) {
        return;
      }
      throw new Error(
        normalizeSecurityErrorMessage({
          action: "write",
          detail: saved.stderr || saved.stdout,
        })
      );
    },
    delete: async ({ key }) => {
      const deleted = await exec(
        [
          "security",
          "delete-generic-password",
          "-s",
          NODE_KEYCHAIN_SERVICE,
          "-a",
          key,
        ],
        { stdin: "ignore" }
      );
      if (deleted.exitCode === 0) {
        return true;
      }
      const errorText = `${deleted.stderr}\n${deleted.stdout}`.toLowerCase();
      if (
        errorText.includes("could not be found") ||
        errorText.includes("item could not be found")
      ) {
        return false;
      }
      throw new Error(
        normalizeSecurityErrorMessage({
          action: "delete",
          detail: deleted.stderr || deleted.stdout,
        })
      );
    },
  };
}

function normalizeSecurityErrorMessage(input: {
  readonly action: "read" | "write" | "delete";
  readonly detail: string;
}): string {
  const detail = input.detail.trim();
  if (detail.length > 0) {
    return `Node auth keychain ${input.action} failed: ${detail}`;
  }
  return `Node auth keychain ${input.action} failed.`;
}

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRegistryLock();
  try {
    return await fn();
  } finally {
    await releaseRegistryLock();
  }
}

async function acquireRegistryLock(): Promise<void> {
  const lockPath = getRegistryLockPath();
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
      if (Date.now() - start > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for nodes registry lock");
      }
      await Bun.sleep(REGISTRY_LOCK_RETRY_MS);
    }
  }
}

async function releaseRegistryLock(): Promise<void> {
  const lockPath = getRegistryLockPath();
  await unlink(lockPath).catch(() => undefined);
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > REGISTRY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}
