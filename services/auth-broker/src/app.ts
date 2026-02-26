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
import { createProvidersPlugin } from "./modules/providers/plugin.ts";
import { createSharedMiddlewarePlugin } from "./plugins/shared-middleware.ts";

export type CreateAuthBrokerAppOptions = {
  readonly config: BrokerConfig;
  readonly flowStore?: FlowStore;
  readonly betterAuthRuntime?: BetterAuthRuntime;
};

/**
 * Build auth-broker HTTP app from composable feature plugins.
 */
export function createAuthBrokerApp({
  config,
  flowStore: externalStore,
  betterAuthRuntime: externalBetterAuthRuntime,
}: CreateAuthBrokerAppOptions) {
  const flowStore =
    externalStore ?? new FlowStore({ filePath: config.flowStorePath });
  const betterAuthRuntime =
    externalBetterAuthRuntime ?? createBetterAuthRuntimeFromEnv();
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
  if (input.path.startsWith("/gh/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/github/")) {
    return true;
  }
  return false;
}
