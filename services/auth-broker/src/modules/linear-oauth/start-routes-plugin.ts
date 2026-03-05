import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { LinearOAuthModel } from "./model.ts";
import { createFlow, isTruthy, redirect } from "./service.ts";

type CreateLinearOAuthStartRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
};

export function createLinearOAuthStartRoutesPlugin({
  config,
  flowStore,
}: CreateLinearOAuthStartRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.start-routes",
  })
    .all(
      "/v1/auth/linear/start",
      ({ query, set }) => {
        if (!config.linearClientId) {
          set.status = 412;
          return {
            ok: false,
            error: "linear_oauth_not_configured",
          } as const;
        }
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
      { query: LinearOAuthModel.startQuery }
    )
    .all(
      "/linear/start",
      ({ query, set }) => {
        if (!config.linearClientId) {
          set.status = 412;
          return {
            ok: false,
            error: "linear_oauth_not_configured",
          } as const;
        }
        const flow = createFlow({
          config,
          flowStore,
          query,
        });
        return redirect(flow.authorizeUrl);
      },
      { query: LinearOAuthModel.startQuery }
    );
}
