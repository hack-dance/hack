import { expect, test } from "bun:test";
import { __testOnlyNodeStatus } from "../src/commands/node.ts";

type TestNodeAuthLookupCacheEntry = {
  readonly token: string | null;
  readonly error: string | null;
  readonly expiresAtMs: number;
};

test("resolveNodeAuthLookup caches successful token reads within ttl", async () => {
  const cache = new Map<string, TestNodeAuthLookupCacheEntry>();
  let reads = 0;
  const readToken = async () => {
    reads += 1;
    return "token-1";
  };

  const first = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.1",
    nowMs: 1000,
    ttlMs: 10_000,
    cache,
    readToken: async () => await readToken(),
  });
  const second = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.1",
    nowMs: 5000,
    ttlMs: 10_000,
    cache,
    readToken: async () => {
      reads += 1;
      return "token-2";
    },
  });

  expect(first).toEqual({ ok: true, token: "token-1" });
  expect(second).toEqual({ ok: true, token: "token-1" });
  expect(reads).toBe(1);
});

test("resolveNodeAuthLookup refreshes cached token after ttl", async () => {
  const cache = new Map<string, TestNodeAuthLookupCacheEntry>();
  let reads = 0;
  const readToken = async () => {
    reads += 1;
    return `token-${reads}`;
  };

  const first = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.2",
    nowMs: 1000,
    ttlMs: 1000,
    cache,
    readToken: async () => await readToken(),
  });
  const second = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.2",
    nowMs: 2500,
    ttlMs: 1000,
    cache,
    readToken: async () => await readToken(),
  });

  expect(first).toEqual({ ok: true, token: "token-1" });
  expect(second).toEqual({ ok: true, token: "token-2" });
  expect(reads).toBe(2);
});

test("resolveNodeAuthLookup caches auth lookup errors to avoid repeat prompts", async () => {
  const cache = new Map<string, TestNodeAuthLookupCacheEntry>();
  let reads = 0;

  const first = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.3",
    nowMs: 1000,
    ttlMs: 1000,
    cache,
    readToken: async () => {
      reads += 1;
      throw new Error("keychain denied");
    },
  });
  const second = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.3",
    nowMs: 1500,
    ttlMs: 1000,
    cache,
    readToken: async () => {
      reads += 1;
      throw new Error("should not run");
    },
  });
  expect(second.ok).toBe(false);
  expect(reads).toBe(1);

  __testOnlyNodeStatus.clearNodeAuthLookupCache({
    authRef: "node.auth.3",
    cache,
  });
  const third = await __testOnlyNodeStatus.resolveNodeAuthLookup({
    authRef: "node.auth.3",
    nowMs: 1600,
    ttlMs: 1000,
    cache,
    readToken: async () => {
      reads += 1;
      return "token-3";
    },
  });

  expect(first.ok).toBe(false);
  if (first.ok) {
    return;
  }
  expect(first.error).toContain("node.auth.3");
  expect(first.error).toContain("keychain denied");

  expect(third).toEqual({ ok: true, token: "token-3" });
  expect(reads).toBe(2);
});
