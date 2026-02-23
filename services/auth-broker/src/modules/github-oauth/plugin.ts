import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { createGitHubOAuthCallbackRoutesPlugin } from "./callback-routes-plugin.ts";
import { createGitHubOAuthFlowStatusRoutesPlugin } from "./flow-status-routes-plugin.ts";
import { createGitHubOAuthStartRoutesPlugin } from "./start-routes-plugin.ts";

type CreateGitHubOAuthPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

/**
 * GitHub OAuth controller plugin.
 *
 * Controller responsibilities are intentionally limited to HTTP concerns:
 * route wiring, schema validation, and response shaping.
 */
export function createGitHubOAuthPlugin({
  config,
  flowStore,
  betterAuthRuntime,
}: CreateGitHubOAuthPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.github-oauth",
  })
    .use(
      createGitHubOAuthStartRoutesPlugin({
        config,
        flowStore,
      })
    )
    .use(
      createGitHubOAuthCallbackRoutesPlugin({
        config,
        flowStore,
        betterAuthRuntime,
      })
    )
    .use(
      createGitHubOAuthFlowStatusRoutesPlugin({
        config,
        flowStore,
      })
    );
}
