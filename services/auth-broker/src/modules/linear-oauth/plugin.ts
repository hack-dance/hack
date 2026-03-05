import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { createLinearOAuthCallbackRoutesPlugin } from "./callback-routes-plugin.ts";
import { createLinearOAuthFlowStatusRoutesPlugin } from "./flow-status-routes-plugin.ts";
import { createLinearOAuthRefreshRoutesPlugin } from "./refresh-routes-plugin.ts";
import { createLinearOAuthStartRoutesPlugin } from "./start-routes-plugin.ts";

type CreateLinearOAuthPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
};

export function createLinearOAuthPlugin({
  config,
  flowStore,
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
