import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import type { FlowStore } from "../../flow-store.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import { LinearOAuthModel } from "./model.ts";
import { createFlow, isTruthy, redirect } from "./service.ts";

type CreateLinearOAuthStartRoutesPluginOptions = {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

export function createLinearOAuthStartRoutesPlugin({
  config,
  flowStore,
  betterAuthRuntime,
}: CreateLinearOAuthStartRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-oauth.start-routes",
  })
    .all(
      "/v1/auth/linear/start",
      async ({ query, request, set }) => {
        if (!config.linearClientId) {
          set.status = 412;
          return {
            ok: false,
            error: "linear_oauth_not_configured",
          } as const;
        }
        const sessionResolution = await resolveBetterAuthSession({
          runtime: betterAuthRuntime,
          request,
        });
        if (sessionResolution.enabled && !sessionResolution.session) {
          set.status = 401;
          return {
            ok: false,
            error: "better_auth_session_required",
          } as const;
        }
        const flow = createFlow({
          config,
          flowStore,
          query,
          requestedBy: sessionResolution.session
            ? {
                betterAuthUserId: sessionResolution.session.userId,
                betterAuthOrganizationId:
                  sessionResolution.session.organizationId,
                betterAuthTeamId: sessionResolution.session.teamId,
              }
            : null,
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
      async ({ query, request, set }) => {
        if (!config.linearClientId) {
          set.status = 412;
          return {
            ok: false,
            error: "linear_oauth_not_configured",
          } as const;
        }
        const sessionResolution = await resolveBetterAuthSession({
          runtime: betterAuthRuntime,
          request,
        });
        if (sessionResolution.enabled && !sessionResolution.session) {
          set.status = 401;
          return {
            ok: false,
            error: "better_auth_session_required",
          } as const;
        }
        const flow = createFlow({
          config,
          flowStore,
          query,
          requestedBy: sessionResolution.session
            ? {
                betterAuthUserId: sessionResolution.session.userId,
                betterAuthOrganizationId:
                  sessionResolution.session.organizationId,
                betterAuthTeamId: sessionResolution.session.teamId,
              }
            : null,
        });
        return redirect(flow.authorizeUrl);
      },
      { query: LinearOAuthModel.startQuery }
    );
}
