import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { GitHubOAuthModel } from "./model.ts";
import { handleGitHubCallback } from "./service.ts";

type CreateGitHubOAuthCallbackRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

/**
 * Browser callback routes for OAuth completion.
 */
export function createGitHubOAuthCallbackRoutesPlugin({
  config,
  flowStore,
  betterAuthRuntime,
}: CreateGitHubOAuthCallbackRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.github-oauth.callback-routes",
  }).all(
    "/gh/callback",
    async ({ query }) => {
      return await handleGitHubCallback({
        config,
        flowStore,
        betterAuthRuntime,
        query,
      });
    },
    { query: GitHubOAuthModel.callbackQuery }
  );
}
