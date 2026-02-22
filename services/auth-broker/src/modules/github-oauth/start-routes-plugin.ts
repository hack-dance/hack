import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { GitHubOAuthModel } from "./model.ts";
import { createFlow, isTruthy, redirect } from "./service.ts";

type CreateGitHubOAuthStartRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
};

/**
 * Start routes for GitHub OAuth flows.
 */
export function createGitHubOAuthStartRoutesPlugin({
  config,
  flowStore,
}: CreateGitHubOAuthStartRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.github-oauth.start-routes",
  })
    .all(
      "/v1/auth/github/start",
      ({ query }) => {
        const flow = createFlow({
          config,
          flowStore,
          query,
        });
        if (isTruthy(query.redirect)) {
          return redirect(flow.authorizeUrl);
        }
        return {
          ok: true,
          flow,
        } as const;
      },
      { query: GitHubOAuthModel.startQuery }
    )
    .all(
      "/gh/start",
      ({ query }) => {
        const flow = createFlow({
          config,
          flowStore,
          query,
        });
        return redirect(flow.authorizeUrl);
      },
      { query: GitHubOAuthModel.startQuery }
    );
}
