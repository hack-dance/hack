import { Elysia } from "elysia";

import type { FlowStore } from "../../flow-store.ts";
import { LinearOAuthModel } from "./model.ts";
import { isTruthy } from "./service.ts";

type CreateLinearOAuthFlowStatusRoutesPluginOptions = {
  readonly flowStore: FlowStore;
};

export function createLinearOAuthFlowStatusRoutesPlugin({
  flowStore,
}: CreateLinearOAuthFlowStatusRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.flow-status-routes",
  }).all(
    "/v1/auth/linear/flows/:flowId",
    ({ params, query, set }) => {
      const status = flowStore.getStatus({
        flowId: params.flowId,
        deviceCode: query.deviceCode,
        claimToken: isTruthy(query.claim),
        requireInstallation: false,
      });
      if (!status.ok) {
        set.status = status.statusCode;
        return {
          ok: false,
          error: status.error,
        } as const;
      }
      return {
        ok: true,
        status: status.status,
      } as const;
    },
    {
      params: LinearOAuthModel.flowStatusParams,
      query: LinearOAuthModel.flowStatusQuery,
    }
  );
}
