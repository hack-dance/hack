import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import { LinearOAuthModel } from "./model.ts";
import { handleRefreshToken } from "./service.ts";

type CreateLinearOAuthRefreshRoutesPluginOptions = {
  readonly config: BrokerConfig;
};

export function createLinearOAuthRefreshRoutesPlugin({
  config,
}: CreateLinearOAuthRefreshRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.refresh-routes",
  }).post(
    "/v1/auth/linear/refresh",
    async ({ body, set }) => {
      const refreshed = await handleRefreshToken({
        config,
        body,
      });
      if (!refreshed.ok) {
        set.status = refreshed.statusCode;
        return {
          ok: false,
          error: refreshed.error,
        } as const;
      }
      return {
        ok: true,
        token: refreshed.token,
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        ...(refreshed.refreshToken
          ? { refreshToken: refreshed.refreshToken }
          : {}),
        ...(refreshed.refreshTokenExpiresAt
          ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
          : {}),
      } as const;
    },
    {
      body: LinearOAuthModel.refreshBody,
    }
  );
}
