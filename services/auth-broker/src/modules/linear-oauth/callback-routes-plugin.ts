import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { LinearOAuthModel } from "./model.ts";
import { handleLinearCallback } from "./service.ts";

type CreateLinearOAuthCallbackRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
};

export function createLinearOAuthCallbackRoutesPlugin({
  config,
  flowStore,
}: CreateLinearOAuthCallbackRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.callback-routes",
  }).get(
    "/linear/callback",
    ({ query }) =>
      handleLinearCallback({
        config,
        flowStore,
        query,
      }),
    { query: LinearOAuthModel.callbackQuery }
  );
}
