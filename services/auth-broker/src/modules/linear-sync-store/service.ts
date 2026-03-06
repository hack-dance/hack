import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, type SQL, sql } from "drizzle-orm";

import { linearWebhookEvents } from "../../db/schema.ts";
import { createDbClient } from "../../db.ts";

export type LinearWebhookDeliveryStatus = "pending" | "applied" | "ignored";

export type RecordLinearWebhookDeliveryInput = {
  readonly path: string;
  readonly rawBody: string;
  readonly payloadJson: unknown;
  readonly signatureVerified: boolean;
  readonly eventType: string | null;
  readonly action: string | null;
  readonly webhookTimestamp: string | null;
  readonly deliveryKey?: string | null;
  readonly profileId?: string | null;
  readonly projectId?: string | null;
  readonly issueId?: string | null;
  readonly issueIdentifier?: string | null;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
};

export type ListLinearWebhookDeliveriesInput = {
  readonly status?: LinearWebhookDeliveryStatus;
  readonly profileId?: string | null;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
};

export type LinearWebhookDelivery = {
  readonly id: string;
  readonly path: string;
  readonly rawBody: string;
  readonly payloadJson: unknown;
  readonly signatureVerified: boolean;
  readonly eventType: string | null;
  readonly action: string | null;
  readonly webhookTimestamp: string | null;
  readonly profileId: string | null;
  readonly projectId: string | null;
  readonly teamId: string | null;
  readonly issueId: string | null;
  readonly issueIdentifier: string | null;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly organizationId: string | null;
  readonly ownerTeamId: string | null;
  readonly claimedBy: string | null;
  readonly status: LinearWebhookDeliveryStatus;
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
};

export type LinearSyncStore = {
  readonly recordWebhookDelivery: (
    input: RecordLinearWebhookDeliveryInput
  ) => Promise<LinearWebhookDelivery>;
  readonly listWebhookDeliveries: (
    input?: ListLinearWebhookDeliveriesInput
  ) => Promise<readonly LinearWebhookDelivery[]>;
  readonly getWebhookDelivery: (input: {
    readonly deliveryId: string;
  }) => Promise<LinearWebhookDelivery | null>;
  readonly markWebhookDeliveryApplied: (input: {
    readonly deliveryId: string;
    readonly claimedBy?: string | null;
  }) => Promise<LinearWebhookDelivery | null>;
};

/**
 * Temporary in-memory Linear sync store used by tests and local runtime wiring.
 *
 * The interface is shaped so a Postgres-backed implementation can replace this
 * without changing route contracts when shared DB schema wiring lands.
 */
export class InMemoryLinearSyncStore implements LinearSyncStore {
  private readonly deliveriesById = new Map<string, LinearWebhookDelivery>();

  recordWebhookDelivery(
    input: RecordLinearWebhookDeliveryInput
  ): Promise<LinearWebhookDelivery> {
    const now = new Date().toISOString();
    const delivery: LinearWebhookDelivery = {
      id: randomUUID(),
      path: input.path,
      rawBody: input.rawBody,
      payloadJson: input.payloadJson,
      signatureVerified: input.signatureVerified,
      eventType: input.eventType,
      action: input.action,
      webhookTimestamp: input.webhookTimestamp,
      profileId: normalizeText(input.profileId),
      projectId: normalizeText(input.projectId),
      teamId: normalizeText(input.teamId),
      issueId: normalizeText(input.issueId),
      issueIdentifier: normalizeText(input.issueIdentifier),
      betterAuthUserId: input.betterAuthUserId,
      betterAuthOrganizationId: input.betterAuthOrganizationId ?? null,
      betterAuthTeamId: input.betterAuthTeamId ?? null,
      organizationId: input.organizationId,
      ownerTeamId: normalizeText(input.teamId),
      claimedBy: null,
      status: "pending",
      receivedAt: now,
      updatedAt: now,
      appliedAt: null,
    };
    this.deliveriesById.set(delivery.id, delivery);
    return Promise.resolve(delivery);
  }

  listWebhookDeliveries(
    input: ListLinearWebhookDeliveriesInput = {}
  ): Promise<readonly LinearWebhookDelivery[]> {
    return Promise.resolve(
      [...this.deliveriesById.values()]
        .filter((delivery) =>
          matchesDeliveryFilter({ delivery, filter: input })
        )
        .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
    );
  }

  getWebhookDelivery(input: {
    readonly deliveryId: string;
  }): Promise<LinearWebhookDelivery | null> {
    return Promise.resolve(this.deliveriesById.get(input.deliveryId) ?? null);
  }

  markWebhookDeliveryApplied(input: {
    readonly deliveryId: string;
    readonly claimedBy?: string | null;
  }): Promise<LinearWebhookDelivery | null> {
    const delivery = this.deliveriesById.get(input.deliveryId);
    if (!delivery) {
      return Promise.resolve(null);
    }
    const appliedAt = delivery.appliedAt ?? new Date().toISOString();
    const updated: LinearWebhookDelivery = {
      ...delivery,
      claimedBy: normalizeText(input.claimedBy) ?? delivery.claimedBy,
      status: "applied",
      updatedAt: new Date().toISOString(),
      appliedAt,
    };
    this.deliveriesById.set(updated.id, updated);
    return Promise.resolve(updated);
  }
}

export function createLinearSyncStoreFromDb(input: {
  readonly databaseUrl: string;
}): LinearSyncStore {
  const db = createDbClient({
    databaseUrl: input.databaseUrl,
  });
  const ensureOwnershipColumns = createOwnershipColumnsEnsurer({
    db,
    tableName: "linear_webhook_events",
  });
  return {
    recordWebhookDelivery: async ({
      path,
      rawBody,
      payloadJson,
      signatureVerified,
      eventType,
      action,
      webhookTimestamp,
      deliveryKey,
      profileId,
      projectId,
      issueId,
      issueIdentifier,
      betterAuthUserId,
      betterAuthOrganizationId,
      betterAuthTeamId,
      organizationId,
      teamId,
    }) => {
      await ensureOwnershipColumns();
      const resolvedDeliveryKey =
        normalizeText(deliveryKey) ??
        buildDeliveryKey({
          path,
          rawBody,
          eventType,
          action,
          webhookTimestamp,
        });
      const inserted = await db
        .insert(linearWebhookEvents)
        .values({
          deliveryKey: resolvedDeliveryKey,
          profileId: normalizeText(profileId),
          projectId: normalizeText(projectId),
          teamId: normalizeText(teamId),
          issueId: normalizeText(issueId),
          issueIdentifier: normalizeText(issueIdentifier),
          eventType: eventType ?? "unknown",
          action: action ?? "unknown",
          status: "pending",
          payloadJson: JSON.stringify({
            path,
            rawBody,
            payload: payloadJson,
            signatureVerified,
            webhookTimestamp,
            [BETTER_AUTH_ORGANIZATION_PAYLOAD_KEY]: betterAuthOrganizationId,
            [BETTER_AUTH_TEAM_PAYLOAD_KEY]: betterAuthTeamId,
          }),
          applyError: null,
          claimedBy: null,
          betterAuthUserId,
          betterAuthOrganizationId: normalizeText(betterAuthOrganizationId),
          betterAuthTeamId: normalizeText(betterAuthTeamId),
          organizationId,
          ownerTeamId: teamId,
        })
        .onConflictDoNothing({
          target: linearWebhookEvents.deliveryKey,
        })
        .returning();

      if (inserted[0]) {
        return toWebhookDelivery({ row: inserted[0] });
      }

      const existing = await db
        .select()
        .from(linearWebhookEvents)
        .where(eq(linearWebhookEvents.deliveryKey, resolvedDeliveryKey))
        .limit(1);
      if (!existing[0]) {
        throw new Error("Failed to persist Linear webhook delivery.");
      }
      return toWebhookDelivery({ row: existing[0] });
    },

    listWebhookDeliveries: async (input = {}) => {
      await ensureOwnershipColumns();
      const filters = buildListFilters({ input });
      const rows =
        filters.length === 0
          ? await db
              .select()
              .from(linearWebhookEvents)
              .orderBy(desc(linearWebhookEvents.createdAt))
          : await db
              .select()
              .from(linearWebhookEvents)
              .where(and(...filters))
              .orderBy(desc(linearWebhookEvents.createdAt));
      return rows
        .map((row) => toWebhookDelivery({ row }))
        .filter((delivery) =>
          matchesDeliveryFilter({ delivery, filter: input })
        );
    },

    getWebhookDelivery: async ({ deliveryId }) => {
      await ensureOwnershipColumns();
      const rows = await db
        .select()
        .from(linearWebhookEvents)
        .where(eq(linearWebhookEvents.id, deliveryId))
        .limit(1);
      return rows[0] ? toWebhookDelivery({ row: rows[0] }) : null;
    },

    markWebhookDeliveryApplied: async ({ deliveryId, claimedBy }) => {
      await ensureOwnershipColumns();
      const now = new Date();
      const updated = await db
        .update(linearWebhookEvents)
        .set({
          status: "applied",
          applyError: null,
          claimedBy:
            normalizeText(claimedBy) ??
            sql`coalesce(${linearWebhookEvents.claimedBy}, 'manual')`,
          updatedAt: now,
          appliedAt: now,
        })
        .where(eq(linearWebhookEvents.id, deliveryId))
        .returning();
      return updated[0] ? toWebhookDelivery({ row: updated[0] }) : null;
    },
  };
}

export function toWebhookDelivery(input: {
  readonly row: typeof linearWebhookEvents.$inferSelect;
}): LinearWebhookDelivery {
  const storedOwnership = readStoredDeliveryOwnership({
    payloadJson: input.row.payloadJson,
  });
  return {
    id: input.row.id,
    path: readStoredPath({ payloadJson: input.row.payloadJson }),
    rawBody: readStoredRawBody({ payloadJson: input.row.payloadJson }),
    payloadJson: readStoredPayload({ payloadJson: input.row.payloadJson }),
    signatureVerified: readStoredSignatureVerified({
      payloadJson: input.row.payloadJson,
    }),
    eventType: input.row.eventType,
    action: input.row.action,
    webhookTimestamp:
      readStoredWebhookTimestamp({ payloadJson: input.row.payloadJson }) ??
      null,
    profileId: input.row.profileId ?? null,
    projectId: input.row.projectId ?? null,
    teamId: input.row.teamId ?? null,
    issueId: input.row.issueId ?? null,
    issueIdentifier: input.row.issueIdentifier ?? null,
    betterAuthUserId: input.row.betterAuthUserId ?? null,
    betterAuthOrganizationId:
      input.row.betterAuthOrganizationId ??
      storedOwnership.betterAuthOrganizationId,
    betterAuthTeamId:
      input.row.betterAuthTeamId ?? storedOwnership.betterAuthTeamId,
    organizationId: input.row.organizationId ?? null,
    ownerTeamId: input.row.ownerTeamId ?? null,
    claimedBy: input.row.claimedBy ?? null,
    status: normalizeDeliveryStatus({ value: input.row.status }),
    receivedAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    appliedAt: input.row.appliedAt?.toISOString() ?? null,
  };
}

export const materializeLinearWebhookDelivery = toWebhookDelivery;

function buildListFilters(input: {
  readonly input: ListLinearWebhookDeliveriesInput;
}) {
  const filters: SQL[] = [];
  if (input.input.status) {
    filters.push(eq(linearWebhookEvents.status, input.input.status));
  }
  const profileId = normalizeText(input.input.profileId);
  if (profileId) {
    filters.push(eq(linearWebhookEvents.profileId, profileId));
  }
  const projectId = normalizeText(input.input.projectId);
  if (projectId) {
    filters.push(eq(linearWebhookEvents.projectId, projectId));
  }
  const teamId = normalizeText(input.input.teamId);
  if (teamId) {
    filters.push(eq(linearWebhookEvents.teamId, teamId));
  }
  const betterAuthUserId = normalizeText(input.input.betterAuthUserId);
  if (
    betterAuthUserId &&
    normalizeText(input.input.betterAuthOrganizationId) == null
  ) {
    filters.push(eq(linearWebhookEvents.betterAuthUserId, betterAuthUserId));
  }
  return filters;
}

function matchesDeliveryFilter(input: {
  readonly delivery: LinearWebhookDelivery;
  readonly filter: ListLinearWebhookDeliveriesInput;
}): boolean {
  if (input.filter.status && input.delivery.status !== input.filter.status) {
    return false;
  }
  const profileId = normalizeText(input.filter.profileId);
  if (profileId && input.delivery.profileId !== profileId) {
    return false;
  }
  const projectId = normalizeText(input.filter.projectId);
  if (projectId && input.delivery.projectId !== projectId) {
    return false;
  }
  const teamId = normalizeText(input.filter.teamId);
  if (teamId && input.delivery.teamId !== teamId) {
    return false;
  }
  const betterAuthOrganizationId = normalizeText(
    input.filter.betterAuthOrganizationId
  );
  if (
    betterAuthOrganizationId &&
    input.delivery.betterAuthOrganizationId !== betterAuthOrganizationId
  ) {
    const fallbackBetterAuthUserId = normalizeText(
      input.filter.betterAuthUserId
    );
    if (
      input.delivery.betterAuthOrganizationId != null ||
      fallbackBetterAuthUserId == null ||
      input.delivery.betterAuthUserId !== fallbackBetterAuthUserId
    ) {
      return false;
    }
  } else if (betterAuthOrganizationId) {
    return true;
  }
  const betterAuthTeamId = normalizeText(input.filter.betterAuthTeamId);
  if (
    betterAuthTeamId &&
    input.delivery.betterAuthTeamId !== betterAuthTeamId
  ) {
    return false;
  }
  const betterAuthUserId = normalizeText(input.filter.betterAuthUserId);
  if (
    betterAuthUserId &&
    input.delivery.betterAuthUserId !== betterAuthUserId
  ) {
    return false;
  }
  return true;
}

function buildDeliveryKey(input: {
  readonly path: string;
  readonly rawBody: string;
  readonly eventType: string | null;
  readonly action: string | null;
  readonly webhookTimestamp: string | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.path,
        input.eventType ?? "",
        input.action ?? "",
        input.webhookTimestamp ?? "",
        input.rawBody,
      ].join("\n"),
      "utf8"
    )
    .digest("hex");
}

const BETTER_AUTH_ORGANIZATION_PAYLOAD_KEY = "_betterAuthOrganizationId";
const BETTER_AUTH_TEAM_PAYLOAD_KEY = "_betterAuthTeamId";

function readStoredEnvelope(input: {
  readonly payloadJson: string;
}): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.payloadJson) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStoredPath(input: { readonly payloadJson: string }): string {
  return (
    readStringField({ record: readStoredEnvelope(input), key: "path" }) ?? ""
  );
}

function readStoredRawBody(input: { readonly payloadJson: string }): string {
  return (
    readStringField({ record: readStoredEnvelope(input), key: "rawBody" }) ?? ""
  );
}

function readStoredPayload(input: { readonly payloadJson: string }): unknown {
  return readStoredEnvelope(input)?.payload ?? null;
}

function readStoredWebhookTimestamp(input: {
  readonly payloadJson: string;
}): string | null {
  return readStringField({
    record: readStoredEnvelope(input),
    key: "webhookTimestamp",
  });
}

export function readStoredDeliveryOwnership(input: {
  readonly payloadJson: string;
}): {
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
} {
  const record = readStoredEnvelope(input);
  return {
    betterAuthOrganizationId: readStringField({
      record,
      key: BETTER_AUTH_ORGANIZATION_PAYLOAD_KEY,
    }),
    betterAuthTeamId: readStringField({
      record,
      key: BETTER_AUTH_TEAM_PAYLOAD_KEY,
    }),
  };
}

function readStoredSignatureVerified(input: {
  readonly payloadJson: string;
}): boolean {
  const record = readStoredEnvelope(input);
  return record?.signatureVerified === true;
}

function readStringField(input: {
  readonly record: Record<string, unknown> | null;
  readonly key: string;
}): string | null {
  const value = input.record?.[input.key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function createOwnershipColumnsEnsurer(input: {
  readonly db: ReturnType<typeof createDbClient>;
  readonly tableName: "linear_webhook_events";
}) {
  let promise: Promise<void> | null = null;
  return async () => {
    promise ??= ensureOwnershipColumns(input);
    await promise;
  };
}

async function ensureOwnershipColumns(input: {
  readonly db: ReturnType<typeof createDbClient>;
  readonly tableName: "linear_webhook_events";
}) {
  await input.db.execute(
    sql.raw(
      `ALTER TABLE "${input.tableName}" ADD COLUMN IF NOT EXISTS "better_auth_organization_id" text`
    )
  );
  await input.db.execute(
    sql.raw(
      `ALTER TABLE "${input.tableName}" ADD COLUMN IF NOT EXISTS "better_auth_team_id" text`
    )
  );
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDeliveryStatus(input: {
  readonly value: string;
}): LinearWebhookDeliveryStatus {
  if (
    input.value === "pending" ||
    input.value === "applied" ||
    input.value === "ignored"
  ) {
    return input.value;
  }
  return "pending";
}
