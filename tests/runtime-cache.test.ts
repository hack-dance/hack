import { beforeEach, expect, mock, test } from "bun:test";

import type { RuntimeProject } from "../src/lib/runtime-projects.ts";

const runtimeQueue: Array<{
  readonly ok: boolean;
  readonly runtime: readonly RuntimeProject[];
  readonly error: string | null;
  readonly checkedAtMs: number;
}> = [];
const identityQueue: Array<
  | {
      readonly ok: true;
      readonly identity: {
        readonly dockerHost: string | null;
        readonly socketPath: string | null;
        readonly socketInode: number | null;
        readonly engineId: string | null;
        readonly engineName: string | null;
        readonly engineVersion: string | null;
      };
    }
  | { readonly ok: false; readonly error: string }
> = [];
const autoRegisterCalls: RuntimeProject[][] = [];

mock.module("../src/lib/runtime-projects.ts", () => ({
  readRuntimeProjects: async () =>
    runtimeQueue.shift() ?? {
      ok: true,
      runtime: [],
      error: null,
      checkedAtMs: Date.now(),
    },
  autoRegisterRuntimeHackProjects: async (opts: {
    readonly runtime: RuntimeProject[];
  }) => {
    autoRegisterCalls.push(opts.runtime);
  },
  filterRuntimeProjects: (opts: {
    readonly runtime: readonly RuntimeProject[];
    readonly includeGlobal: boolean;
  }) =>
    opts.includeGlobal
      ? opts.runtime
      : opts.runtime.filter((project) => !project.isGlobal),
}));

mock.module("../src/daemon/runtime-health.ts", () => ({
  readRuntimeIdentity: async () =>
    identityQueue.shift() ?? {
      ok: true,
      identity: {
        dockerHost: null,
        socketPath: null,
        socketInode: null,
        engineId: "default",
        engineName: null,
        engineVersion: null,
      },
    },
  buildRuntimeFingerprint: (opts: {
    readonly identity: { readonly engineId: string | null };
  }) => opts.identity.engineId ?? "unknown",
}));

import { createRuntimeCache } from "../src/daemon/runtime-cache.ts";

beforeEach(() => {
  runtimeQueue.length = 0;
  identityQueue.length = 0;
  autoRegisterCalls.length = 0;
});

test("runtime cache refresh records healthy snapshot", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map(),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "test" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.runtime).toEqual(runtime);
  expect(snapshot?.health.ok).toBe(true);
  expect(snapshot?.health.error).toBe(null);
  expect(autoRegisterCalls.length).toBe(1);
});

test("runtime cache retains last runtime on failure", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map(),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: false,
    runtime: [],
    error: "docker down",
    checkedAtMs: Date.now(),
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "prime" });
  await cache.refresh({ reason: "fail" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.runtime).toEqual(runtime);
  expect(snapshot?.health.ok).toBe(false);
  expect(snapshot?.health.error).toBe("docker down");
});

test("runtime cache detects runtime resets via fingerprint", async () => {
  const runtime: RuntimeProject[] = [
    {
      project: "alpha",
      workingDir: null,
      services: new Map(),
      isGlobal: false,
    },
  ];
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-a",
      engineName: null,
      engineVersion: null,
    },
  });
  runtimeQueue.push({
    ok: true,
    runtime,
    error: null,
    checkedAtMs: Date.now(),
  });
  identityQueue.push({
    ok: true,
    identity: {
      dockerHost: null,
      socketPath: null,
      socketInode: null,
      engineId: "engine-b",
      engineName: null,
      engineVersion: null,
    },
  });

  const cache = createRuntimeCache({});
  await cache.refresh({ reason: "prime" });
  await cache.refresh({ reason: "reset" });

  const snapshot = cache.getSnapshot();
  expect(snapshot?.health.resetCount).toBe(1);
  expect(snapshot?.health.lastResetAtMs).not.toBeNull();
});
