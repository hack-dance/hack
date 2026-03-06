import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import {
  hasBetterAuthAccess,
  hasBetterAuthProfileAccess,
  resolveBetterAuthSession,
} from "../better-auth/session.ts";
import type {
  LinearSyncStore,
  LinearWebhookDeliveryStatus,
} from "./service.ts";

const LINEAR_DELIVERY_STATUSES = ["pending", "applied", "ignored"] as const;

type CreateLinearSyncStorePluginOptions = {
  readonly syncStore: LinearSyncStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
};

const listDeliveriesQuerySchema = t.Object({
  status: t.Optional(t.String()),
  profileId: t.Optional(t.String()),
  projectId: t.Optional(t.String()),
  teamId: t.Optional(t.String()),
});

const applyDeliveryParamsSchema = t.Object({
  deliveryId: t.String(),
});

const applyDeliveryBodySchema = t.Optional(
  t.Object({
    claimedBy: t.Optional(t.String()),
  })
);

/**
 * Routes for pending Linear webhook deliveries consumed by local clients.
 */
export function createLinearSyncStorePlugin({
  syncStore,
  betterAuthRuntime,
}: CreateLinearSyncStorePluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-sync-store",
  })
    .get(
      "/v1/auth/linear/deliveries",
      async ({ query, request, set }) => {
        const statusResult = normalizeStatusQuery({ value: query.status });
        if (!statusResult.ok) {
          set.status = 400;
          return {
            ok: false,
            error: statusResult.error,
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
            profileId: normalizeOptionalQueryValue({ value: query.profileId }),
          })
        ) {
          set.status = 403;
          return {
            ok: false,
            error: "better_auth_profile_forbidden",
          } as const;
        }
        const activeSession = session.session;

        const allDeliveries = await syncStore.listWebhookDeliveries({
          status: statusResult.status,
          profileId: normalizeOptionalQueryValue({ value: query.profileId }),
          projectId: normalizeOptionalQueryValue({ value: query.projectId }),
          teamId: normalizeOptionalQueryValue({ value: query.teamId }),
        });
        const deliveries =
          session.enabled && activeSession
            ? allDeliveries.filter((delivery) =>
                hasBetterAuthAccess({
                  session: activeSession,
                  record: delivery,
                })
              )
            : allDeliveries;
        return {
          ok: true,
          accessControlMode: session.accessControlMode,
          deliveries,
        } as const;
      },
      {
        query: listDeliveriesQuerySchema,
      }
    )
    .post(
      "/v1/auth/linear/deliveries/:deliveryId/apply",
      async ({ body, params, request, set }) => {
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
        if (session.session) {
          const existing = await syncStore.getWebhookDelivery({
            deliveryId: params.deliveryId,
          });
          if (
            !(
              existing &&
              hasBetterAuthAccess({
                session: session.session,
                record: existing,
              })
            )
          ) {
            set.status = 404;
            return {
              ok: false,
              error: "linear_delivery_not_found",
            } as const;
          }
        }
        const delivery = await syncStore.markWebhookDeliveryApplied({
          deliveryId: params.deliveryId,
          claimedBy:
            typeof body?.claimedBy === "string" &&
            body.claimedBy.trim().length > 0
              ? body.claimedBy.trim()
              : null,
        });
        if (!delivery) {
          set.status = 404;
          return {
            ok: false,
            error: "linear_delivery_not_found",
          } as const;
        }
        return {
          ok: true,
          delivery,
        } as const;
      },
      {
        body: applyDeliveryBodySchema,
        params: applyDeliveryParamsSchema,
      }
    );
}

function normalizeStatusQuery(input: {
  readonly value?: string;
}):
  | { readonly ok: true; readonly status: LinearWebhookDeliveryStatus }
  | { readonly ok: false; readonly error: string } {
  if (!input.value) {
    return {
      ok: true,
      status: "pending",
    };
  }
  const normalized = input.value.trim();
  if (isLinearWebhookDeliveryStatus(normalized)) {
    return {
      ok: true,
      status: normalized,
    };
  }
  return {
    ok: false,
    error: "invalid_linear_delivery_status",
  };
}

function normalizeOptionalQueryValue(input: {
  readonly value?: string;
}): string | null {
  if (typeof input.value !== "string") {
    return null;
  }
  const trimmed = input.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLinearWebhookDeliveryStatus(
  value: string
): value is LinearWebhookDeliveryStatus {
  return LINEAR_DELIVERY_STATUSES.includes(
    value as (typeof LINEAR_DELIVERY_STATUSES)[number]
  );
}
