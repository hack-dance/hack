import { Elysia, t } from "elysia";

import type { LinearConnectionStore } from "./service.ts";

const listConnectionsQuerySchema = t.Object({
  profileId: t.Optional(t.String()),
  organizationId: t.Optional(t.String()),
});

type CreateLinearConnectionsPluginOptions = {
  readonly connectionStore: LinearConnectionStore;
};

export function createLinearConnectionsPlugin({
  connectionStore,
}: CreateLinearConnectionsPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.linear-connections",
  }).get(
    "/v1/auth/linear/connections",
    async ({ query }) => ({
      ok: true,
      accessControlMode: "manual_unenforced",
      connections: await connectionStore.listConnections({
        profileId: normalizeOptionalQueryValue(query.profileId),
        organizationId: normalizeOptionalQueryValue(query.organizationId),
      }),
    }),
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
