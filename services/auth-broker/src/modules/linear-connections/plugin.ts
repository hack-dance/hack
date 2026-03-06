import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import {
  hasBetterAuthAccess,
  hasBetterAuthProfileAccess,
  resolveBetterAuthSession,
} from "../better-auth/session.ts";
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
      if (
        !hasBetterAuthProfileAccess({
          session: session.session,
          profileId: normalizeOptionalQueryValue(query.profileId),
        })
      ) {
        set.status = 403;
        return {
          ok: false,
          error: "better_auth_profile_forbidden",
        } as const;
      }
      const activeSession = session.session;
      const allConnections = await connectionStore.listConnections({
        profileId: normalizeOptionalQueryValue(query.profileId),
        organizationId: normalizeOptionalQueryValue(query.organizationId),
      });
      const connections =
        session.enabled && activeSession
          ? allConnections.filter((connection) =>
              hasBetterAuthAccess({
                session: activeSession,
                record: connection,
              })
            )
          : allConnections;
      return {
        ok: true,
        accessControlMode: session.accessControlMode,
        connections,
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
