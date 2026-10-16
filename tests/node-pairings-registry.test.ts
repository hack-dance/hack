import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelNodePairingSession,
  consumeNodePairingSession,
  createNodePairingSession,
  getNodePairingSession,
  listNodePairingSessions,
  readNodePairingsRegistry,
} from "../src/lib/node-pairings-registry.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-pairings-"));
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

test("pairing session can be created and consumed once", async () => {
  const created = await createNodePairingSession({
    source: "remote-user@node-a.tailnet.ts.net",
    endpoint: "http://127.0.0.1:7788",
    nowIso: "2026-02-21T00:00:00.000Z",
    ttlMs: 5 * 60 * 1000,
  });
  expect(created.code).toMatch(/^\d{6}$/);
  expect(created.session.status).toBe("pending");

  const consumed = await consumeNodePairingSession({
    sessionId: created.session.id,
    code: created.code,
    nowIso: "2026-02-21T00:01:00.000Z",
  });
  expect(consumed.ok).toBe(true);
  if (!consumed.ok) {
    return;
  }
  expect(consumed.session.status).toBe("consumed");

  const second = await consumeNodePairingSession({
    sessionId: created.session.id,
    code: created.code,
    nowIso: "2026-02-21T00:02:00.000Z",
  });
  expect(second.ok).toBe(false);
  if (second.ok) {
    return;
  }
  expect(second.error).toContain("already consumed");
});

test("pairing session rejects invalid code and can be cancelled", async () => {
  const created = await createNodePairingSession({
    source: "hack@old-macbook.local",
    endpoint: "http://198.51.100.37:7788",
  });
  const rejected = await consumeNodePairingSession({
    sessionId: created.session.id,
    code: "000000",
  });
  expect(rejected.ok).toBe(false);
  if (rejected.ok) {
    return;
  }
  expect(rejected.error).toContain("Invalid pairing code");

  const cancelled = await cancelNodePairingSession({
    sessionId: created.session.id,
  });
  expect(cancelled.cancelled).toBe(true);

  const afterCancel = await consumeNodePairingSession({
    sessionId: created.session.id,
    code: created.code,
  });
  expect(afterCancel.ok).toBe(false);
  if (afterCancel.ok) {
    return;
  }
  expect(afterCancel.error).toContain("cancelled");
});

test("pairing session expires after ttl", async () => {
  const created = await createNodePairingSession({
    source: "ubuntu@aws-dev-1",
    endpoint: "http://127.0.0.1:7788",
    nowIso: "2026-02-21T00:00:00.000Z",
    ttlMs: 60_000,
  });
  const expired = await consumeNodePairingSession({
    sessionId: created.session.id,
    code: created.code,
    nowIso: "2026-02-21T00:02:30.000Z",
  });
  expect(expired.ok).toBe(false);
  if (expired.ok) {
    return;
  }
  expect(expired.error).toContain("expired");

  const registry = await readNodePairingsRegistry();
  const entry = registry.sessions.find(
    (session) => session.id === created.session.id
  );
  expect(entry?.status).toBe("expired");
});

test("pairing sessions can be listed and fetched by id", async () => {
  const first = await createNodePairingSession({
    source: "user@node-a",
    endpoint: "http://127.0.0.1:7788",
    nowIso: "2026-02-21T10:00:00.000Z",
  });
  const second = await createNodePairingSession({
    source: "user@node-b",
    endpoint: "http://127.0.0.1:7788",
    nowIso: "2026-02-21T10:01:00.000Z",
  });
  const cancelled = await cancelNodePairingSession({
    sessionId: first.session.id,
    nowIso: "2026-02-21T10:02:00.000Z",
  });
  expect(cancelled.cancelled).toBe(true);

  const pendingOnly = await listNodePairingSessions({
    status: "pending",
    nowIso: "2026-02-21T10:03:00.000Z",
  });
  expect(pendingOnly.map((session) => session.id)).toEqual([second.session.id]);

  const all = await listNodePairingSessions({
    status: "all",
    nowIso: "2026-02-21T10:03:00.000Z",
  });
  expect(all.length).toBe(2);
  expect(all[0]?.id).toBe(second.session.id);

  const fetched = await getNodePairingSession({
    sessionId: first.session.id,
    nowIso: "2026-02-21T10:03:00.000Z",
  });
  expect(fetched?.status).toBe("cancelled");
});
