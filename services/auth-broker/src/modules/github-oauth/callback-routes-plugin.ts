import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { GitHubOAuthModel } from "./model.ts";
import { handleGitHubCallback } from "./service.ts";

type CreateGitHubOAuthCallbackRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
};

/**
 * Browser callback routes for OAuth completion.
 */
export function createGitHubOAuthCallbackRoutesPlugin({
  config,
  flowStore,
}: CreateGitHubOAuthCallbackRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.github-oauth.callback-routes",
  }).all(
    "/gh/callback",
    async ({ query }) => {
      return await handleGitHubCallback({
        config,
        flowStore,
        query,
      });
    },
    { query: GitHubOAuthModel.callbackQuery }
  );
}
