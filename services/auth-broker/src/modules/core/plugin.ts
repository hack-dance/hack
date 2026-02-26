import { Elysia } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";

type CreateCoreRoutesPluginOptions = {
  readonly betterAuthRuntime: BetterAuthRuntime;
};

/**
 * Core informational routes for broker health and runtime status.
 */
export function createCoreRoutesPlugin({
  betterAuthRuntime,
}: CreateCoreRoutesPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.core-routes",
  })
    .get("/health", () => ({
      ok: true,
      service: "hack-auth-broker",
      now: new Date().toISOString(),
    }))
    .get("/v1/auth/better-auth/status", () => ({
      enabled: betterAuthRuntime.enabled,
      reason: betterAuthRuntime.reason ?? null,
      basePath: "/api/auth",
    }));
}
