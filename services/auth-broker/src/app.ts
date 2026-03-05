import { Elysia } from "elysia";

import {
  type BetterAuthRuntime,
  createBetterAuthRuntimeFromEnv,
} from "./better-auth.ts";
import type { BrokerConfig } from "./config.ts";
import { FlowStore } from "./flow-store.ts";
import { createBetterAuthPlugin } from "./modules/better-auth/plugin.ts";
import { createCoreRoutesPlugin } from "./modules/core/plugin.ts";
import { createGitHubOAuthPlugin } from "./modules/github-oauth/plugin.ts";
import { createLinearAgentPlugin } from "./modules/linear-agent/plugin.ts";
import { createLinearConnectionsPlugin } from "./modules/linear-connections/plugin.ts";
import {
  createLinearConnectionStoreFromDb,
  InMemoryLinearConnectionStore,
  type LinearConnectionStore,
} from "./modules/linear-connections/service.ts";
import { createLinearOAuthPlugin } from "./modules/linear-oauth/plugin.ts";
import { createLinearSyncStorePlugin } from "./modules/linear-sync-store/plugin.ts";
import {
  createLinearSyncStoreFromDb,
  InMemoryLinearSyncStore,
  type LinearSyncStore,
} from "./modules/linear-sync-store/service.ts";
import { createProvidersPlugin } from "./modules/providers/plugin.ts";
import { createSharedMiddlewarePlugin } from "./plugins/shared-middleware.ts";

export type CreateAuthBrokerAppOptions = {
  readonly config: BrokerConfig;
  readonly flowStore?: FlowStore;
  readonly betterAuthRuntime?: BetterAuthRuntime;
  readonly linearSyncStore?: LinearSyncStore;
  readonly linearConnectionStore?: LinearConnectionStore;
};

/**
 * Build auth-broker HTTP app from composable feature plugins.
 */
export function createAuthBrokerApp({
  config,
  flowStore: externalStore,
  betterAuthRuntime: externalBetterAuthRuntime,
  linearSyncStore: externalLinearSyncStore,
  linearConnectionStore: externalLinearConnectionStore,
}: CreateAuthBrokerAppOptions) {
  const flowStore =
    externalStore ?? new FlowStore({ filePath: config.flowStorePath });
  const betterAuthRuntime =
    externalBetterAuthRuntime ?? createBetterAuthRuntimeFromEnv();
  const linearSyncStore =
    externalLinearSyncStore ?? createDefaultLinearSyncStore();
  const linearConnectionStore =
    externalLinearConnectionStore ?? createDefaultLinearConnectionStore();
  let flowSweepTimer: ReturnType<typeof setInterval> | null = null;

  return new Elysia({
    name: "hack-auth-broker",
  })
    .onBeforeHandle(({ request, set }) => {
      if (!isReadOnlyRoutePath({ path: new URL(request.url).pathname })) {
        return;
      }
      if (request.method === "GET") {
        return;
      }
      set.status = 405;
      return {
        ok: false,
        error: "method_not_allowed",
      } as const;
    })
    .use(createSharedMiddlewarePlugin())
    .use(
      createCoreRoutesPlugin({
        betterAuthRuntime,
      })
    )
    .use(
      createProvidersPlugin({
        config,
        betterAuthRuntime,
      })
    )
    .use(
      createBetterAuthPlugin({
        runtime: betterAuthRuntime,
      })
    )
    .use(
      createGitHubOAuthPlugin({
        config,
        flowStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearAgentPlugin({
        config,
        syncStore: linearSyncStore,
        connectionStore: linearConnectionStore,
      })
    )
    .use(
      createLinearConnectionsPlugin({
        connectionStore: linearConnectionStore,
      })
    )
    .use(
      createLinearSyncStorePlugin({
        syncStore: linearSyncStore,
      })
    )
    .use(
      createLinearOAuthPlugin({
        config,
        flowStore,
        connectionStore: linearConnectionStore,
        betterAuthRuntime,
      })
    )
    .onStart(() => {
      const intervalMs = Math.max(config.flowSweepIntervalMs, 5000);
      flowSweepTimer = setInterval(() => {
        flowStore.pruneExpired();
      }, intervalMs);
      flowSweepTimer.unref?.();
    })
    .onStop(() => {
      if (!flowSweepTimer) {
        return;
      }
      clearInterval(flowSweepTimer);
      flowSweepTimer = null;
    });
}

function createDefaultLinearSyncStore(): LinearSyncStore {
  if (!process.env.DATABASE_URL) {
    return new InMemoryLinearSyncStore();
  }
  try {
    return createLinearSyncStoreFromDb({
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch {
    return new InMemoryLinearSyncStore();
  }
}

function createDefaultLinearConnectionStore(): LinearConnectionStore {
  if (!process.env.DATABASE_URL) {
    return new InMemoryLinearConnectionStore();
  }
  try {
    return createLinearConnectionStoreFromDb({
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch {
    return new InMemoryLinearConnectionStore();
  }
}

/**
 * Identify route paths that are intentionally GET-only in broker v1.
 */
function isReadOnlyRoutePath(input: { readonly path: string }): boolean {
  if (input.path === "/health") {
    return true;
  }
  if (input.path === "/v1/auth/providers") {
    return true;
  }
  if (input.path === "/v1/auth/better-auth/status") {
    return true;
  }
  if (input.path === "/linear/callback") {
    return true;
  }
  if (input.path === "/linear/start") {
    return true;
  }
  if (input.path === "/v1/auth/linear/refresh") {
    return false;
  }
  if (
    input.path.startsWith("/v1/auth/linear/deliveries/") &&
    input.path.endsWith("/apply")
  ) {
    return false;
  }
  if (input.path.startsWith("/gh/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/github/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/linear/")) {
    return true;
  }
  return false;
}
