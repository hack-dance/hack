import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";

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
  }).all("/v1/auth/providers", () => ({
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
        redirectUri: config.githubRedirectUri,
      },
    ] as const,
  }));
}
