import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import type { LinearConnectionStore } from "./service.ts";

const listConnectionsQuerySchema = t.Object({
  profileId: t.Optional(t.String()),
  organizationId: t.Optional(t.String()),
});

type CreateLinearConnectionsPluginOptions = {
  readonly connectionStore: LinearConnectionStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

export function createLinearConnectionsPlugin({
  connectionStore,
  betterAuthRuntime,
}: CreateLinearConnectionsPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-connections",
  }).get(
    "/v1/auth/linear/connections",
    async ({ query, request, set }) => {
      const session = await resolveBetterAuthSession({
        runtime: betterAuthRuntime,
        request,
      });
      if (session.enabled && !session.session) {
        set.status = 401;
        return {
          ok: false,
          error: "better_auth_session_required",
        } as const;
      }
      return {
        ok: true,
        accessControlMode: session.accessControlMode,
        connections: await connectionStore.listConnections({
          profileId: normalizeOptionalQueryValue(query.profileId),
          organizationId: normalizeOptionalQueryValue(query.organizationId),
          betterAuthUserId: session.session?.userId ?? null,
          betterAuthOrganizationId: session.session?.organizationId ?? null,
        }),
      } as const;
    },
    { query: listConnectionsQuerySchema }
  );
}

function normalizeOptionalQueryValue(value?: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
