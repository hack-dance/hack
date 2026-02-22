import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
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
});

test("node registry supports upsert/default/touch/remove", async () => {
  const created = await upsertNodeRecord({
    name: "alpha",
    endpoint: "http://127.0.0.1:7788/",
    authRef: "node.auth.alpha",
  });

  expect(created.created).toBe(true);
  expect(created.node.endpoint).toBe("http://127.0.0.1:7788");
  expect(created.node.name).toBe("alpha");

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

test("node auth refs can resolve from environment variables", async () => {
  const authRef = "env:HACK_NODE_AUTH_TOKEN_TEST";

  await saveNodeAuthToken({
    authRef,
    token: "env-token",
  });
  const resolved = await readNodeAuthToken({ authRef });
  expect(resolved).toBe("env-token");

  const deleted = await deleteNodeAuthToken({ authRef });
  expect(deleted).toBe(true);
  const afterDelete = await readNodeAuthToken({ authRef });
  expect(afterDelete).toBeNull();
});
