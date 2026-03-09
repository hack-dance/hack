import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import {
  hasBetterAuthAccess,
  hasBetterAuthProfileAccess,
  resolveBetterAuthSession,
} from "../better-auth/session.ts";
import type {
  LinearAutosyncMode,
  LinearAutosyncStatus,
  LinearAutosyncStore,
} from "./service.ts";

const AUTOSYNC_MODES = ["manual", "auto_apply"] as const;
const AUTOSYNC_STATUSES = ["active", "paused"] as const;

const listSubscriptionsQuerySchema = t.Object({
  profileId: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  teamId: t.Optional(t.String()),
});

const upsertSubscriptionBodySchema = t.Object({
  profileId: t.String(),
  projectId: t.Optional(t.String()),
  teamId: t.Optional(t.String()),
  mode: t.Optional(t.String()),
  status: t.Optional(t.String()),
});

const removeSubscriptionBodySchema = t.Object({
  profileId: t.String(),
  projectId: t.Optional(t.String()),
  teamId: t.Optional(t.String()),
});

type CreateLinearAutosyncPluginOptions = {
  readonly autosyncStore: LinearAutosyncStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

export function createLinearAutosyncPlugin({
  autosyncStore,
  betterAuthRuntime,
}: CreateLinearAutosyncPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-autosync",
  })
    .get(
      "/v1/auth/linear/subscriptions",
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

        const subscriptions = await autosyncStore.listSubscriptions({
          profileId,
          projectId: normalizeOptionalQueryValue(query.projectId),
          teamId: normalizeOptionalQueryValue(query.teamId),
        });

        const activeSession = session.session;

        return {
          ok: true,
          accessControlMode: session.accessControlMode,
          subscriptions: activeSession
            ? subscriptions.filter((subscription) =>
                hasBetterAuthAccess({
                  session: activeSession,
                  record: subscription,
                })
              )
            : subscriptions,
        } as const;
      },
      { query: listSubscriptionsQuerySchema }
    )
    .post(
      "/v1/auth/linear/subscriptions",
      async ({ body, request, set }) => {
        const mode = normalizeMode(body.mode);
        if (!mode) {
          set.status = 400;
          return { ok: false, error: "invalid_linear_autosync_mode" } as const;
        }
        const status = normalizeStatus(body.status);
        if (!status) {
          set.status = 400;
          return {
            ok: false,
            error: "invalid_linear_autosync_status",
          } as const;
        }

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
            profileId: body.profileId,
          })
        ) {
          set.status = 403;
          return {
            ok: false,
            error: "better_auth_profile_forbidden",
          } as const;
        }

        const subscription = await autosyncStore.upsertSubscription({
          profileId: body.profileId,
          projectId: normalizeOptionalQueryValue(body.projectId),
          teamId: normalizeOptionalQueryValue(body.teamId),
          mode,
          status,
          betterAuthUserId: session.session?.userId ?? null,
          betterAuthOrganizationId: session.session?.organizationId ?? null,
          betterAuthTeamId: session.session?.teamId ?? null,
        });
        return { ok: true, subscription } as const;
      },
      { body: upsertSubscriptionBodySchema }
    )
    .post(
      "/v1/auth/linear/subscriptions/remove",
      async ({ body, request, set }) => {
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
            profileId: body.profileId,
          })
        ) {
          set.status = 403;
          return {
            ok: false,
            error: "better_auth_profile_forbidden",
          } as const;
        }

        const existing =
          (
            await autosyncStore.listSubscriptions({
              profileId: body.profileId,
              projectId: normalizeOptionalQueryValue(body.projectId),
              teamId: normalizeOptionalQueryValue(body.teamId),
            })
          ).find(
            (subscription) =>
              !session.session ||
              hasBetterAuthAccess({
                session: session.session,
                record: subscription,
              })
          ) ?? null;
        if (!existing) {
          set.status = 404;
          return {
            ok: false,
            error: "linear_autosync_subscription_not_found",
          } as const;
        }

        const removed = await autosyncStore.removeSubscription({
          profileId: body.profileId,
          projectId: normalizeOptionalQueryValue(body.projectId),
          teamId: normalizeOptionalQueryValue(body.teamId),
          betterAuthUserId: existing.betterAuthUserId,
          betterAuthOrganizationId: existing.betterAuthOrganizationId,
          betterAuthTeamId: existing.betterAuthTeamId,
        });
        if (!removed) {
          set.status = 404;
          return {
            ok: false,
            error: "linear_autosync_subscription_not_found",
          } as const;
        }
        return { ok: true, subscription: removed } as const;
      },
      { body: removeSubscriptionBodySchema }
    );
}

function normalizeOptionalQueryValue(value?: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMode(value?: string): LinearAutosyncMode | null {
  if (AUTOSYNC_MODES.includes(value as LinearAutosyncMode)) {
    return value as LinearAutosyncMode;
  }
  if (value == null) {
    return "auto_apply";
  }
  return null;
}

function normalizeStatus(value?: string): LinearAutosyncStatus | null {
  if (AUTOSYNC_STATUSES.includes(value as LinearAutosyncStatus)) {
    return value as LinearAutosyncStatus;
  }
  if (value == null) {
    return "active";
  }
  return null;
}
