import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import type { LinearConnectionStore } from "../linear-connections/service.ts";
import { LinearOAuthModel } from "./model.ts";
import { handleLinearCallback } from "./service.ts";

type CreateLinearOAuthCallbackRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly connectionStore: LinearConnectionStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

export function createLinearOAuthCallbackRoutesPlugin({
  config,
  flowStore,
  connectionStore,
  betterAuthRuntime,
}: CreateLinearOAuthCallbackRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.callback-routes",
  }).get(
    "/linear/callback",
    ({ query }) =>
      handleLinearCallback({
        config,
        flowStore,
        connectionStore,
        betterAuthRuntime,
        query,
      }),
    { query: LinearOAuthModel.callbackQuery }
  );
}
