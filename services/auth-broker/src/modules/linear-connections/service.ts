import { randomUUID } from "node:crypto";

import { createDbClient } from "@hack/db";
import { linearConnections } from "@hack/db/schema/core";
import { and, desc, eq, type SQL } from "drizzle-orm";

export type LinearConnectionMetadata = Record<string, unknown>;

export type LinearConnectionRecord = {
  readonly id: string;
  readonly connectionKey: string;
  readonly profileId: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly authRef: string | null;
  readonly betterAuthUserId: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly metadata: LinearConnectionMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type UpsertLinearConnectionInput = {
  readonly profileId?: string | null;
  readonly accountId?: string | null;
  readonly accountName?: string | null;
  readonly accountEmail?: string | null;
  readonly authRef?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly organizationId?: string | null;
  readonly teamId?: string | null;
  readonly metadata?: LinearConnectionMetadata;
};

export type ListLinearConnectionsInput = {
  readonly profileId?: string | null;
  readonly organizationId?: string | null;
};

export type LinearWebhookOwnership = {
  readonly status: "matched" | "ambiguous" | "unmatched";
  readonly profileId: string | null;
  readonly betterAuthUserId: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly connectionId?: string;
};

export type LinearConnectionStore = {
  readonly upsertConnection: (
    input: UpsertLinearConnectionInput
  ) => Promise<LinearConnectionRecord>;
  readonly listConnections: (
    input?: ListLinearConnectionsInput
  ) => Promise<readonly LinearConnectionRecord[]>;
  readonly resolveWebhookOwnership: (input: {
    readonly profileId?: string | null;
    readonly organizationId?: string | null;
  }) => Promise<LinearWebhookOwnership>;
};

export class InMemoryLinearConnectionStore implements LinearConnectionStore {
  private readonly recordsByKey = new Map<string, LinearConnectionRecord>();

  upsertConnection(
    input: UpsertLinearConnectionInput
  ): Promise<LinearConnectionRecord> {
    const connectionKey = buildConnectionKey(input);
    const existing = this.recordsByKey.get(connectionKey);
    const now = new Date().toISOString();
    const record: LinearConnectionRecord = {
      id: existing?.id ?? randomUUID(),
      connectionKey,
      profileId: normalizeText(input.profileId),
      accountId: normalizeText(input.accountId),
      accountName: normalizeText(input.accountName),
      accountEmail: normalizeText(input.accountEmail),
      authRef: normalizeText(input.authRef),
      betterAuthUserId: normalizeText(input.betterAuthUserId),
      organizationId: normalizeText(input.organizationId),
      teamId: normalizeText(input.teamId),
      metadata: input.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.recordsByKey.set(connectionKey, record);
    return Promise.resolve(record);
  }

  listConnections(
    input: ListLinearConnectionsInput = {}
  ): Promise<readonly LinearConnectionRecord[]> {
    return Promise.resolve(
      [...this.recordsByKey.values()]
        .filter((record) => matchesConnectionFilter({ record, filter: input }))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    );
  }

  async resolveWebhookOwnership(input: {
    readonly profileId?: string | null;
    readonly organizationId?: string | null;
  }): Promise<LinearWebhookOwnership> {
    const profileId = normalizeText(input.profileId);
    if (profileId) {
      const matches = await this.listConnections({ profileId });
      if (matches.length > 0) {
        return toWebhookOwnership({
          matches,
          fallbackOrganizationId: normalizeText(input.organizationId),
          preferred: matches[0] ?? null,
        });
      }
    }

    const organizationId = normalizeText(input.organizationId);
    if (!organizationId) {
      return {
        status: "unmatched",
        profileId: null,
        betterAuthUserId: null,
        organizationId: null,
        teamId: null,
      };
    }

    const matches = await this.listConnections({ organizationId });
    return toWebhookOwnership({
      matches,
      fallbackOrganizationId: organizationId,
    });
  }
}

export function createLinearConnectionStoreFromDb(input: {
  readonly databaseUrl: string;
}): LinearConnectionStore {
  const db = createDbClient({ databaseUrl: input.databaseUrl });
  return {
    upsertConnection: async (connection) => {
      const connectionKey = buildConnectionKey(connection);
      const now = new Date();
      const inserted = await db
        .insert(linearConnections)
        .values({
          connectionKey,
          profileId: normalizeText(connection.profileId),
          accountId: normalizeText(connection.accountId),
          accountName: normalizeText(connection.accountName),
          accountEmail: normalizeText(connection.accountEmail),
          authRef: normalizeText(connection.authRef),
          betterAuthUserId: normalizeText(connection.betterAuthUserId),
          organizationId: normalizeText(connection.organizationId),
          teamId: normalizeText(connection.teamId),
          metadataJson: JSON.stringify(connection.metadata ?? {}),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: linearConnections.connectionKey,
          set: {
            profileId: normalizeText(connection.profileId),
            accountId: normalizeText(connection.accountId),
            accountName: normalizeText(connection.accountName),
            accountEmail: normalizeText(connection.accountEmail),
            authRef: normalizeText(connection.authRef),
            betterAuthUserId: normalizeText(connection.betterAuthUserId),
            organizationId: normalizeText(connection.organizationId),
            teamId: normalizeText(connection.teamId),
            metadataJson: JSON.stringify(connection.metadata ?? {}),
            updatedAt: now,
          },
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to persist Linear connection.");
      }
      return toConnectionRecord({ row });
    },

    listConnections: async (input = {}) => {
      const filters = buildListFilters({ input });
      const rows =
        filters.length === 0
          ? await db
              .select()
              .from(linearConnections)
              .orderBy(desc(linearConnections.updatedAt))
          : await db
              .select()
              .from(linearConnections)
              .where(and(...filters))
              .orderBy(desc(linearConnections.updatedAt));
      return rows.map((row) => toConnectionRecord({ row }));
    },

    resolveWebhookOwnership: async ({ profileId, organizationId }) => {
      const normalizedProfileId = normalizeText(profileId);
      if (normalizedProfileId) {
        const rows = await db
          .select()
          .from(linearConnections)
          .where(eq(linearConnections.profileId, normalizedProfileId))
          .orderBy(desc(linearConnections.updatedAt))
          .limit(2);
        if (rows.length > 0) {
          return toWebhookOwnership({
            matches: rows.map((row) => toConnectionRecord({ row })),
            fallbackOrganizationId: normalizeText(organizationId),
          });
        }
      }

      const normalizedOrganizationId = normalizeText(organizationId);
      if (!normalizedOrganizationId) {
        return {
          status: "unmatched",
          profileId: null,
          betterAuthUserId: null,
          organizationId: null,
          teamId: null,
        };
      }

      const rows = await db
        .select()
        .from(linearConnections)
        .where(eq(linearConnections.organizationId, normalizedOrganizationId))
        .orderBy(desc(linearConnections.updatedAt))
        .limit(2);
      return toWebhookOwnership({
        matches: rows.map((row) => toConnectionRecord({ row })),
        fallbackOrganizationId: normalizedOrganizationId,
      });
    },
  };
}

function buildConnectionKey(input: UpsertLinearConnectionInput): string {
  const profileId = normalizeText(input.profileId);
  if (profileId) {
    return `profile:${profileId}`;
  }
  const accountId = normalizeText(input.accountId);
  if (accountId) {
    return `account:${accountId}`;
  }
  const accountEmail = normalizeText(input.accountEmail);
  if (accountEmail) {
    return `email:${accountEmail.toLowerCase()}`;
  }
  throw new Error(
    "Linear connection requires profileId, accountId, or accountEmail."
  );
}

function buildListFilters(input: {
  readonly input: ListLinearConnectionsInput;
}): SQL[] {
  const filters: SQL[] = [];
  const profileId = normalizeText(input.input.profileId);
  if (profileId) {
    filters.push(eq(linearConnections.profileId, profileId));
  }
  const organizationId = normalizeText(input.input.organizationId);
  if (organizationId) {
    filters.push(eq(linearConnections.organizationId, organizationId));
  }
  return filters;
}

function matchesConnectionFilter(input: {
  readonly record: LinearConnectionRecord;
  readonly filter: ListLinearConnectionsInput;
}): boolean {
  const profileId = normalizeText(input.filter.profileId);
  if (profileId && input.record.profileId !== profileId) {
    return false;
  }
  const organizationId = normalizeText(input.filter.organizationId);
  if (organizationId && input.record.organizationId !== organizationId) {
    return false;
  }
  return true;
}

function toConnectionRecord(input: {
  readonly row: typeof linearConnections.$inferSelect;
}): LinearConnectionRecord {
  return {
    id: input.row.id,
    connectionKey: input.row.connectionKey,
    profileId: input.row.profileId ?? null,
    accountId: input.row.accountId ?? null,
    accountName: input.row.accountName ?? null,
    accountEmail: input.row.accountEmail ?? null,
    authRef: input.row.authRef ?? null,
    betterAuthUserId: input.row.betterAuthUserId ?? null,
    organizationId: input.row.organizationId ?? null,
    teamId: input.row.teamId ?? null,
    metadata: parseMetadata({ raw: input.row.metadataJson }),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function parseMetadata(input: {
  readonly raw: string;
}): LinearConnectionMetadata {
  try {
    const parsed = JSON.parse(input.raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as LinearConnectionMetadata)
      : {};
  } catch {
    return {};
  }
}

function toWebhookOwnership(input: {
  readonly matches: readonly LinearConnectionRecord[];
  readonly fallbackOrganizationId: string | null;
  readonly preferred?: LinearConnectionRecord | null;
}): LinearWebhookOwnership {
  const preferred = input.preferred ?? input.matches[0] ?? null;
  if (input.matches.length === 1 && preferred) {
    return {
      status: "matched",
      profileId: preferred.profileId,
      betterAuthUserId: preferred.betterAuthUserId,
      organizationId: preferred.organizationId ?? input.fallbackOrganizationId,
      teamId: preferred.teamId,
      connectionId: preferred.id,
    };
  }
  if (input.matches.length > 1) {
    return {
      status: "ambiguous",
      profileId: null,
      betterAuthUserId: null,
      organizationId: input.fallbackOrganizationId,
      teamId: null,
    };
  }
  return {
    status: "unmatched",
    profileId: null,
    betterAuthUserId: null,
    organizationId: input.fallbackOrganizationId,
    teamId: null,
  };
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
