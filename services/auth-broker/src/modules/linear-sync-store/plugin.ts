import { Elysia, t } from "elysia";

import type {
  LinearSyncStore,
  LinearWebhookDeliveryStatus,
} from "./service.ts";

const LINEAR_DELIVERY_STATUSES = ["pending", "applied", "ignored"] as const;

type CreateLinearSyncStorePluginOptions = {
  readonly syncStore: LinearSyncStore;
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

/**
 * Routes for pending Linear webhook deliveries consumed by local clients.
 */
export function createLinearSyncStorePlugin({
  syncStore,
}: CreateLinearSyncStorePluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-sync-store",
  })
    .get(
      "/v1/auth/linear/deliveries",
      async ({ query, set }) => {
        const statusResult = normalizeStatusQuery({ value: query.status });
        if (!statusResult.ok) {
          set.status = 400;
          return {
            ok: false,
            error: statusResult.error,
          } as const;
        }

        const deliveries = await syncStore.listWebhookDeliveries({
          status: statusResult.status,
          profileId: normalizeOptionalQueryValue({ value: query.profileId }),
          projectId: normalizeOptionalQueryValue({ value: query.projectId }),
          teamId: normalizeOptionalQueryValue({ value: query.teamId }),
        });
        return {
          ok: true,
          deliveries,
        } as const;
      },
      {
        query: listDeliveriesQuerySchema,
      }
    )
    .post(
      "/v1/auth/linear/deliveries/:deliveryId/apply",
      async ({ params, set }) => {
        const delivery = await syncStore.markWebhookDeliveryApplied({
          deliveryId: params.deliveryId,
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
