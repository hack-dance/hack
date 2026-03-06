import { Elysia } from "elysia";

import {
  type BetterAuthRuntime,
  ensureBetterAuthRuntimeReady,
} from "../../better-auth.ts";

type CreateBetterAuthPluginOptions = {
  readonly runtime: BetterAuthRuntime;
};

const ALLOWED_BETTER_AUTH_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
]);

/**
 * Better Auth route adapter plugin.
 *
 * This plugin isolates Better Auth transport concerns so shared middleware and
 * provider routes remain decoupled from auth implementation details.
 */
export function createBetterAuthPlugin({
  runtime,
}: CreateBetterAuthPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.better-auth",
  }).all("/api/auth/*", async ({ request, set }) => {
    if (!(runtime.enabled && runtime.auth)) {
      set.status = 503;
      return {
        ok: false,
        error: runtime.reason ?? "Better Auth is not configured.",
      } as const;
    }
    if (!ALLOWED_BETTER_AUTH_METHODS.has(request.method)) {
      set.status = 405;
      return {
        ok: false,
        error: `Unsupported method: ${request.method}`,
      } as const;
    }
    try {
      await ensureBetterAuthRuntimeReady(runtime);
    } catch (error) {
      set.status = 503;
      return {
        ok: false,
        error: "better_auth_storage_unavailable",
        message: error instanceof Error ? error.message : String(error),
      } as const;
    }
    return runtime.auth.handler(request);
  });
}
