import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import {
  hasBetterAuthAccess,
  hasBetterAuthProfileAccess,
  resolveBetterAuthSession,
} from "../better-auth/session.ts";
import {
  persistLinearLocalAccessCustody,
  seedLinearLocalAccess,
} from "./local-access.ts";
import type { LinearConnectionStore } from "./service.ts";

const listConnectionsQuerySchema = t.Object({
  profileId: t.Optional(t.String()),
  organizationId: t.Optional(t.String()),
});

type CreateLinearConnectionsPluginOptions = {
  readonly connectionStore: LinearConnectionStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
  readonly config: {
    readonly providerTokenEncryptionKey?: string;
    readonly linearTokenUrl: string;
    readonly linearClientId?: string;
    readonly linearClientSecret?: string;
  };
};

export function createLinearConnectionsPlugin({
  connectionStore,
  betterAuthRuntime,
  config,
}: CreateLinearConnectionsPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-connections",
  })
    .get(
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
        const profileId =
          normalizeOptionalQueryValue(query.profileId) ??
          session.session?.managementTokenProfileId ??
          null;
        if (
          !hasBetterAuthProfileAccess({
            session: session.session,
            profileId,
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
          profileId,
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
    )
    .post(
      "/v1/auth/linear/connections/seed",
      async ({ body, request, set }) => {
        const session = await resolveBetterAuthSession({
          runtime: betterAuthRuntime,
          request,
        });
        if (session.enabled && !session.session) {
          set.status = 401;
          return { ok: false, error: "better_auth_session_required" } as const;
        }
        const profileId =
          normalizeOptionalQueryValue(body.profileId) ??
          session.session?.managementTokenProfileId ??
          null;
        if (
          !hasBetterAuthProfileAccess({
            session: session.session,
            profileId,
          })
        ) {
          set.status = 403;
          return {
            ok: false,
            error: "better_auth_profile_forbidden",
          } as const;
        }
        const allConnections = await connectionStore.listConnections({
          ...(profileId ? { profileId } : {}),
        });
        const activeSession = session.session;
        const connection =
          session.enabled && activeSession
            ? (allConnections.find((record) =>
                hasBetterAuthAccess({
                  session: activeSession,
                  record,
                })
              ) ?? null)
            : (allConnections[0] ?? null);
        if (!connection) {
          set.status = 404;
          return {
            ok: false,
            error: "linear_connection_not_found",
          } as const;
        }
        const seeded = await seedLinearLocalAccess({
          config,
          connectionStore,
          profileId: connection.profileId ?? profileId ?? "",
        });
        if (!seeded.ok) {
          set.status = seeded.statusCode;
          return {
            ok: false,
            error: seeded.error,
          } as const;
        }
        return {
          ok: true,
          seed: seeded,
        } as const;
      },
      {
        body: t.Object({
          profileId: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/v1/auth/linear/connections/update-local-access",
      async ({ body, request, set }) => {
        const session = await resolveBetterAuthSession({
          runtime: betterAuthRuntime,
          request,
        });
        if (session.enabled && !session.session) {
          set.status = 401;
          return { ok: false, error: "better_auth_session_required" } as const;
        }
        const profileId =
          normalizeOptionalQueryValue(body.profileId) ??
          session.session?.managementTokenProfileId ??
          null;
        if (
          !hasBetterAuthProfileAccess({
            session: session.session,
            profileId,
          })
        ) {
          set.status = 403;
          return {
            ok: false,
            error: "better_auth_profile_forbidden",
          } as const;
        }
        const allConnections = await connectionStore.listConnections({
          ...(profileId ? { profileId } : {}),
        });
        const activeSession = session.session;
        const connection =
          session.enabled && activeSession
            ? (allConnections.find((record) =>
                hasBetterAuthAccess({
                  session: activeSession,
                  record,
                })
              ) ?? null)
            : (allConnections[0] ?? null);
        if (!connection) {
          set.status = 404;
          return {
            ok: false,
            error: "linear_connection_not_found",
          } as const;
        }
        const persisted = await persistLinearLocalAccessCustody({
          config,
          connectionStore,
          profileId: connection.profileId ?? profileId ?? "",
          token: body.token,
          tokenExpiresAt: body.tokenExpiresAt,
          refreshToken: body.refreshToken,
          refreshTokenExpiresAt: body.refreshTokenExpiresAt,
        });
        if (!persisted.ok) {
          set.status = persisted.statusCode;
          return {
            ok: false,
            error: persisted.error,
          } as const;
        }
        return {
          ok: true,
          connection: persisted.connection,
        } as const;
      },
      {
        body: t.Object({
          profileId: t.Optional(t.String()),
          token: t.Optional(t.String()),
          tokenExpiresAt: t.Optional(t.String()),
          refreshToken: t.Optional(t.String()),
          refreshTokenExpiresAt: t.Optional(t.String()),
        }),
      }
    );
}

function normalizeOptionalQueryValue(value?: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
