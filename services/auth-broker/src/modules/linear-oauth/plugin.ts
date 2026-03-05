import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import type { LinearConnectionStore } from "../linear-connections/service.ts";
import { createLinearOAuthCallbackRoutesPlugin } from "./callback-routes-plugin.ts";
import { createLinearOAuthFlowStatusRoutesPlugin } from "./flow-status-routes-plugin.ts";
import { createLinearOAuthRefreshRoutesPlugin } from "./refresh-routes-plugin.ts";
import { createLinearOAuthStartRoutesPlugin } from "./start-routes-plugin.ts";

type CreateLinearOAuthPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly connectionStore: LinearConnectionStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

export function createLinearOAuthPlugin({
  config,
  flowStore,
  connectionStore,
  betterAuthRuntime,
}: CreateLinearOAuthPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth",
  })
    .use(
      createLinearOAuthStartRoutesPlugin({
        config,
        flowStore,
      })
    )
    .use(
      createLinearOAuthCallbackRoutesPlugin({
        config,
        flowStore,
        connectionStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearOAuthRefreshRoutesPlugin({
        config,
      })
    )
    .use(
      createLinearOAuthFlowStatusRoutesPlugin({
        flowStore,
      })
    );
}
