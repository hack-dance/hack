import { randomUUID } from "node:crypto";

import { type AnyColumn, and, desc, eq, type SQL, sql } from "drizzle-orm";

import { linearSyncSubscriptions } from "../../db/schema.ts";
import { createDbClient } from "../../db.ts";

export type LinearAutosyncMode = "manual" | "auto_apply";
export type LinearAutosyncStatus = "active" | "paused";
export type LinearAutosyncConfig = Record<string, unknown>;

export type LinearAutosyncSubscription = {
  readonly id: string;
  readonly subscriptionKey: string;
  readonly profileId: string;
  readonly projectId: string | null;
  readonly teamId: string | null;
  readonly mode: LinearAutosyncMode;
  readonly status: LinearAutosyncStatus;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly config: LinearAutosyncConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type UpsertLinearAutosyncSubscriptionInput = {
  readonly profileId: string;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
  readonly mode?: LinearAutosyncMode;
  readonly status?: LinearAutosyncStatus;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
  readonly config?: LinearAutosyncConfig;
};

export type ListLinearAutosyncSubscriptionsInput = {
  readonly profileId?: string | null;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
};

export type RemoveLinearAutosyncSubscriptionInput = {
  readonly profileId: string;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
};

export type MatchLinearAutosyncSubscriptionInput = {
  readonly profileId?: string | null;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
};

type SubscriptionScopeInput = {
  readonly profileId: string;
  readonly projectId?: string | null;
  readonly teamId?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
};

export type LinearAutosyncStore = {
  readonly upsertSubscription: (
    input: UpsertLinearAutosyncSubscriptionInput
  ) => Promise<LinearAutosyncSubscription>;
  readonly listSubscriptions: (
    input?: ListLinearAutosyncSubscriptionsInput
  ) => Promise<readonly LinearAutosyncSubscription[]>;
  readonly removeSubscription: (
    input: RemoveLinearAutosyncSubscriptionInput
  ) => Promise<LinearAutosyncSubscription | null>;
  readonly findMatchingSubscription: (
    input: MatchLinearAutosyncSubscriptionInput
  ) => Promise<LinearAutosyncSubscription | null>;
};

export class InMemoryLinearAutosyncStore implements LinearAutosyncStore {
  private readonly recordsByKey = new Map<string, LinearAutosyncSubscription>();

  upsertSubscription(
    input: UpsertLinearAutosyncSubscriptionInput
  ): Promise<LinearAutosyncSubscription> {
    const existing = this.findExistingSubscription({ input });
    const subscriptionKey = buildSubscriptionKey(input);
    const now = new Date().toISOString();
    const record: LinearAutosyncSubscription = {
      id: existing?.id ?? randomUUID(),
      subscriptionKey,
      profileId: normalizeRequiredText(input.profileId),
      projectId: normalizeText(input.projectId),
      teamId: normalizeText(input.teamId),
      mode: normalizeMode(input.mode),
      status: normalizeStatus(input.status),
      betterAuthUserId: normalizeText(input.betterAuthUserId),
      betterAuthOrganizationId: normalizeText(input.betterAuthOrganizationId),
      betterAuthTeamId: normalizeText(input.betterAuthTeamId),
      config: { ...(input.config ?? {}) },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.removeMatchingSubscriptions({ input });
    this.recordsByKey.set(subscriptionKey, record);
    return Promise.resolve(record);
  }

  listSubscriptions(
    input: ListLinearAutosyncSubscriptionsInput = {}
  ): Promise<readonly LinearAutosyncSubscription[]> {
    return Promise.resolve(
      dedupeSubscriptions({
        records: [...this.recordsByKey.values()],
      })
        .filter((record) =>
          matchesSubscriptionFilter({ record, filter: input })
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    );
  }

  removeSubscription(
    input: RemoveLinearAutosyncSubscriptionInput
  ): Promise<LinearAutosyncSubscription | null> {
    const existing = this.findExistingSubscription({ input });
    if (!existing) {
      return Promise.resolve(null);
    }
    this.removeMatchingSubscriptions({ input });
    return Promise.resolve(existing);
  }

  async findMatchingSubscription(
    input: MatchLinearAutosyncSubscriptionInput
  ): Promise<LinearAutosyncSubscription | null> {
    const matches = (
      await this.listSubscriptions({
        profileId: input.profileId,
        projectId: input.projectId,
        teamId: input.teamId,
      })
    ).filter(
      (record) =>
        record.status === "active" &&
        record.mode === "auto_apply" &&
        matchesOwnership({
          record,
          betterAuthUserId: input.betterAuthUserId,
          betterAuthOrganizationId: input.betterAuthOrganizationId,
          betterAuthTeamId: input.betterAuthTeamId,
        })
    );

    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  private findExistingSubscription(input: {
    readonly input: SubscriptionScopeInput;
  }): LinearAutosyncSubscription | null {
    return (
      dedupeSubscriptions({
        records: [...this.recordsByKey.values()],
      }).find((record) =>
        matchesSubscriptionScope({
          record,
          input: input.input,
        })
      ) ?? null
    );
  }

  private removeMatchingSubscriptions(input: {
    readonly input: SubscriptionScopeInput;
  }): void {
    for (const [subscriptionKey, record] of this.recordsByKey.entries()) {
      if (
        matchesSubscriptionScope({
          record,
          input: input.input,
        })
      ) {
        this.recordsByKey.delete(subscriptionKey);
      }
    }
  }
}

export function createLinearAutosyncStoreFromDb(input: {
  readonly databaseUrl: string;
}): LinearAutosyncStore {
  const db = createDbClient({ databaseUrl: input.databaseUrl });
  const ensureTable = createSubscriptionsTableEnsurer({ db });

  return {
    upsertSubscription: async (subscription) => {
      await ensureTable();
      const subscriptionKey = buildSubscriptionKey(subscription);
      const now = new Date();
      const configJson = JSON.stringify(subscription.config ?? {});
      const inserted = await db
        .insert(linearSyncSubscriptions)
        .values({
          id: randomUUID(),
          subscriptionKey,
          profileId: normalizeRequiredText(subscription.profileId),
          projectId: normalizeText(subscription.projectId),
          teamId: normalizeText(subscription.teamId),
          mode: normalizeMode(subscription.mode),
          status: normalizeStatus(subscription.status),
          betterAuthUserId: normalizeText(subscription.betterAuthUserId),
          betterAuthOrganizationId: normalizeText(
            subscription.betterAuthOrganizationId
          ),
          betterAuthTeamId: normalizeText(subscription.betterAuthTeamId),
          configJson,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: linearSyncSubscriptions.subscriptionKey,
          set: {
            mode: normalizeMode(subscription.mode),
            status: normalizeStatus(subscription.status),
            betterAuthUserId: normalizeText(subscription.betterAuthUserId),
            betterAuthOrganizationId: normalizeText(
              subscription.betterAuthOrganizationId
            ),
            betterAuthTeamId: normalizeText(subscription.betterAuthTeamId),
            configJson,
            updatedAt: now,
          },
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to persist Linear autosync subscription.");
      }

      await deleteSubscriptionAliases({
        db,
        keepId: row.id,
        input: subscription,
      });

      return toAutosyncSubscription({ row });
    },

    listSubscriptions: async (input = {}) => {
      await ensureTable();
      const filters = buildListFilters({ input });
      const rows =
        filters.length === 0
          ? await db
              .select()
              .from(linearSyncSubscriptions)
              .orderBy(desc(linearSyncSubscriptions.updatedAt))
          : await db
              .select()
              .from(linearSyncSubscriptions)
              .where(and(...filters))
              .orderBy(desc(linearSyncSubscriptions.updatedAt));
      return dedupeSubscriptions({
        records: rows.map((row) => toAutosyncSubscription({ row })),
      }).filter((record) =>
        matchesSubscriptionFilter({ record, filter: input })
      );
    },

    removeSubscription: async (inputToRemove) => {
      await ensureTable();
      const rows = await listMatchingSubscriptionRows({
        db,
        input: inputToRemove,
      });
      const existing =
        dedupeSubscriptions({
          records: rows.map((row) => toAutosyncSubscription({ row })),
        })[0] ?? null;
      if (!existing) {
        return null;
      }

      await deleteSubscriptionAliases({
        db,
        keepId: null,
        input: inputToRemove,
      });

      return existing;
    },

    findMatchingSubscription: async (inputToMatch) => {
      await ensureTable();
      const profileId = normalizeRequiredText(inputToMatch.profileId);
      const projectId = normalizeText(inputToMatch.projectId);
      const teamId = normalizeText(inputToMatch.teamId);
      const matches = dedupeSubscriptions({
        records: (
          await db
            .select()
            .from(linearSyncSubscriptions)
            .where(
              and(
                eq(linearSyncSubscriptions.profileId, profileId),
                ...(projectId
                  ? [eq(linearSyncSubscriptions.projectId, projectId)]
                  : []),
                ...(teamId ? [eq(linearSyncSubscriptions.teamId, teamId)] : []),
                eq(linearSyncSubscriptions.status, "active"),
                eq(linearSyncSubscriptions.mode, "auto_apply")
              )
            )
        ).map((row) => toAutosyncSubscription({ row })),
      }).filter((record) =>
        matchesOwnership({
          record,
          betterAuthUserId: inputToMatch.betterAuthUserId,
          betterAuthOrganizationId: inputToMatch.betterAuthOrganizationId,
          betterAuthTeamId: inputToMatch.betterAuthTeamId,
        })
      );

      return matches.length === 1 ? (matches[0] ?? null) : null;
    },
  };
}

function createSubscriptionsTableEnsurer(input: {
  readonly db: ReturnType<typeof createDbClient>;
}) {
  let promise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!promise) {
      promise = ensureSubscriptionsTable({ db: input.db });
    }
    await promise;
  };
}

async function ensureSubscriptionsTable(input: {
  readonly db: ReturnType<typeof createDbClient>;
}): Promise<void> {
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS linear_sync_subscriptions (
      id uuid PRIMARY KEY,
      subscription_key text NOT NULL UNIQUE,
      profile_id text NOT NULL,
      project_id text,
      team_id text,
      mode text NOT NULL DEFAULT 'manual',
      status text NOT NULL DEFAULT 'active',
      better_auth_user_id text,
      better_auth_organization_id text,
      better_auth_team_id text,
      config_json text NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function buildSubscriptionKey(input: SubscriptionScopeInput): string {
  return [
    buildSubscriptionOwnerKey({
      betterAuthUserId: input.betterAuthUserId,
      betterAuthOrganizationId: input.betterAuthOrganizationId,
      betterAuthTeamId: input.betterAuthTeamId,
    }),
    normalizeRequiredText(input.profileId),
    normalizeText(input.projectId) ?? "*",
    normalizeText(input.teamId) ?? "*",
  ].join("::");
}

function buildSubscriptionOwnerKey(input: {
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
}): string {
  const betterAuthTeamId = normalizeText(input.betterAuthTeamId);
  if (betterAuthTeamId) {
    return `team:${betterAuthTeamId}`;
  }
  const betterAuthOrganizationId = normalizeText(
    input.betterAuthOrganizationId
  );
  if (betterAuthOrganizationId) {
    return `org:${betterAuthOrganizationId}`;
  }
  const betterAuthUserId = normalizeText(input.betterAuthUserId);
  if (betterAuthUserId) {
    return `user:${betterAuthUserId}`;
  }
  return "legacy";
}

function buildListFilters(input: {
  readonly input: ListLinearAutosyncSubscriptionsInput;
}): SQL[] {
  const filters: SQL[] = [];
  const profileId = normalizeText(input.input.profileId);
  if (profileId) {
    filters.push(eq(linearSyncSubscriptions.profileId, profileId));
  }
  const projectId = normalizeText(input.input.projectId);
  if (projectId) {
    filters.push(eq(linearSyncSubscriptions.projectId, projectId));
  }
  const teamId = normalizeText(input.input.teamId);
  if (teamId) {
    filters.push(eq(linearSyncSubscriptions.teamId, teamId));
  }
  return filters;
}

function matchesSubscriptionFilter(input: {
  readonly record: LinearAutosyncSubscription;
  readonly filter: ListLinearAutosyncSubscriptionsInput;
}): boolean {
  const profileId = normalizeText(input.filter.profileId);
  if (profileId && input.record.profileId !== profileId) {
    return false;
  }
  const projectId = normalizeText(input.filter.projectId);
  if (projectId && input.record.projectId !== projectId) {
    return false;
  }
  const teamId = normalizeText(input.filter.teamId);
  if (teamId && input.record.teamId !== teamId) {
    return false;
  }
  return true;
}

function matchesOwnership(input: {
  readonly record: LinearAutosyncSubscription;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
}): boolean {
  const subscriptionTeamId = normalizeText(input.record.betterAuthTeamId);
  if (subscriptionTeamId) {
    return subscriptionTeamId === normalizeText(input.betterAuthTeamId);
  }

  const subscriptionOrganizationId = normalizeText(
    input.record.betterAuthOrganizationId
  );
  if (subscriptionOrganizationId) {
    return (
      subscriptionOrganizationId ===
      normalizeText(input.betterAuthOrganizationId)
    );
  }

  const subscriptionUserId = normalizeText(input.record.betterAuthUserId);
  if (subscriptionUserId) {
    return subscriptionUserId === normalizeText(input.betterAuthUserId);
  }

  return false;
}

function matchesSubscriptionScope(input: {
  readonly record: LinearAutosyncSubscription;
  readonly input: SubscriptionScopeInput;
}): boolean {
  return (
    input.record.profileId === normalizeRequiredText(input.input.profileId) &&
    input.record.projectId === normalizeText(input.input.projectId) &&
    input.record.teamId === normalizeText(input.input.teamId) &&
    input.record.betterAuthUserId ===
      normalizeText(input.input.betterAuthUserId) &&
    input.record.betterAuthOrganizationId ===
      normalizeText(input.input.betterAuthOrganizationId) &&
    input.record.betterAuthTeamId ===
      normalizeText(input.input.betterAuthTeamId)
  );
}

function dedupeSubscriptions(input: {
  readonly records: readonly LinearAutosyncSubscription[];
}): readonly LinearAutosyncSubscription[] {
  const recordsByScope = new Map<string, LinearAutosyncSubscription>();
  for (const record of input.records) {
    const scopeKey = buildSubscriptionScopeFingerprint({ record });
    const existing = recordsByScope.get(scopeKey);
    if (!existing || existing.updatedAt.localeCompare(record.updatedAt) < 0) {
      recordsByScope.set(scopeKey, record);
    }
  }
  return [...recordsByScope.values()];
}

function buildSubscriptionScopeFingerprint(input: {
  readonly record: LinearAutosyncSubscription;
}): string {
  return [
    buildSubscriptionOwnerKey({
      betterAuthUserId: input.record.betterAuthUserId,
      betterAuthOrganizationId: input.record.betterAuthOrganizationId,
      betterAuthTeamId: input.record.betterAuthTeamId,
    }),
    input.record.profileId,
    input.record.projectId ?? "*",
    input.record.teamId ?? "*",
  ].join("::");
}

async function listMatchingSubscriptionRows(input: {
  readonly db: ReturnType<typeof createDbClient>;
  readonly input: SubscriptionScopeInput;
}): Promise<readonly (typeof linearSyncSubscriptions.$inferSelect)[]> {
  return await input.db
    .select()
    .from(linearSyncSubscriptions)
    .where(
      and(
        eq(
          linearSyncSubscriptions.profileId,
          normalizeRequiredText(input.input.profileId)
        ),
        ...buildNullableMatchFilters({
          column: linearSyncSubscriptions.projectId,
          value: normalizeText(input.input.projectId),
        }),
        ...buildNullableMatchFilters({
          column: linearSyncSubscriptions.teamId,
          value: normalizeText(input.input.teamId),
        }),
        ...buildNullableMatchFilters({
          column: linearSyncSubscriptions.betterAuthUserId,
          value: normalizeText(input.input.betterAuthUserId),
        }),
        ...buildNullableMatchFilters({
          column: linearSyncSubscriptions.betterAuthOrganizationId,
          value: normalizeText(input.input.betterAuthOrganizationId),
        }),
        ...buildNullableMatchFilters({
          column: linearSyncSubscriptions.betterAuthTeamId,
          value: normalizeText(input.input.betterAuthTeamId),
        })
      )
    )
    .orderBy(desc(linearSyncSubscriptions.updatedAt));
}

async function deleteSubscriptionAliases(input: {
  readonly db: ReturnType<typeof createDbClient>;
  readonly keepId: string | null;
  readonly input: SubscriptionScopeInput;
}): Promise<void> {
  const rows = await listMatchingSubscriptionRows(input);
  for (const row of rows) {
    if (input.keepId && row.id === input.keepId) {
      continue;
    }
    await input.db
      .delete(linearSyncSubscriptions)
      .where(eq(linearSyncSubscriptions.id, row.id));
  }
}

function buildNullableMatchFilters(input: {
  readonly column: AnyColumn;
  readonly value: string | null;
}): SQL[] {
  return input.value === null
    ? [sql`${input.column} IS NULL`]
    : [eq(input.column, input.value)];
}

function toAutosyncSubscription(input: {
  readonly row: typeof linearSyncSubscriptions.$inferSelect;
}): LinearAutosyncSubscription {
  return {
    id: input.row.id,
    subscriptionKey: input.row.subscriptionKey,
    profileId: input.row.profileId,
    projectId: input.row.projectId ?? null,
    teamId: input.row.teamId ?? null,
    mode: normalizeMode(input.row.mode),
    status: normalizeStatus(input.row.status),
    betterAuthUserId: input.row.betterAuthUserId ?? null,
    betterAuthOrganizationId: input.row.betterAuthOrganizationId ?? null,
    betterAuthTeamId: input.row.betterAuthTeamId ?? null,
    config: parseConfigJson({ raw: input.row.configJson }),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function parseConfigJson(input: {
  readonly raw: string;
}): LinearAutosyncConfig {
  try {
    const parsed = JSON.parse(input.raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as LinearAutosyncConfig)
      : {};
  } catch {
    return {};
  }
}

function normalizeMode(value: string | null | undefined): LinearAutosyncMode {
  return value === "auto_apply" ? "auto_apply" : "manual";
}

function normalizeStatus(
  value: string | null | undefined
): LinearAutosyncStatus {
  return value === "paused" ? "paused" : "active";
}

function normalizeRequiredText(value: string | null | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error("Linear autosync subscription requires profileId.");
  }
  return normalized;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
