import { Elysia } from "elysia";

import type { FlowStore } from "../../flow-store.ts";
import { GitHubOAuthModel } from "./model.ts";
import { isTruthy } from "./service.ts";

type CreateGitHubOAuthFlowStatusRoutesPluginOptions = {
  readonly flowStore: FlowStore;
};

/**
 * Polling routes used by local clients to claim OAuth completion.
 */
export function createGitHubOAuthFlowStatusRoutesPlugin({
  flowStore,
}: CreateGitHubOAuthFlowStatusRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.github-oauth.flow-status-routes",
  }).all(
    "/v1/auth/github/flows/:flowId",
    ({ params, query, set }) => {
      const status = flowStore.getStatus({
        flowId: params.flowId,
        deviceCode: query.deviceCode,
        claimToken: isTruthy(query.claim),
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
      params: GitHubOAuthModel.flowStatusParams,
      query: GitHubOAuthModel.flowStatusQuery,
    }
  );
}
