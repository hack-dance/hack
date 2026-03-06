import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";

type CreateProvidersPluginOptions = {
  readonly config: BrokerConfig;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

/**
 * Provider discovery routes consumed by desktop/CLI settings surfaces.
 */
export function createProvidersPlugin({
  config,
  betterAuthRuntime,
}: CreateProvidersPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.providers",
  }).all("/v1/auth/providers", async ({ request }) => {
    const session = await resolveBetterAuthSession({
      runtime: betterAuthRuntime,
      request,
    });
    return {
      providers: [
        {
          id: "better-auth",
          enabled: betterAuthRuntime.enabled,
          mode: "session",
          basePath: "/api/auth",
        },
        {
          id: "github",
          enabled: true,
          mode: "oauth",
          requestedScopes: config.githubScopes,
          redirectUri: config.githubRedirectUri,
          appId: config.githubAppId,
          appSlug: config.githubAppSlug,
          appInstallUrl: config.githubAppInstallUrl,
        },
        {
          id: "linear",
          enabled: Boolean(config.linearClientId),
          mode: "oauth+agent",
          requestedScopes: config.linearScopes,
          redirectUri: config.linearRedirectUri,
          authorizeUrl: config.linearAuthorizeUrl,
          tokenUrl: config.linearTokenUrl,
          apiBaseUrl: config.linearApiBaseUrl,
          webhookPath: config.linearWebhookPath,
          connectionsPath: "/v1/auth/linear/connections",
          subscriptionsPath: "/v1/auth/linear/subscriptions",
          accessControlMode: session.accessControlMode,
          developerAppTokenConfigured: Boolean(config.linearDeveloperAppToken),
          webhookSignatureVerification: config.linearWebhookSigningSecret
            ? "hmac-sha256"
            : "disabled",
        },
      ] as const,
    };
  });
}
