import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { and, desc, eq, type SQL, sql } from "drizzle-orm";

import { createTableColumnsEnsurer } from "../../db/ensure-columns.ts";
import { linearConnections } from "../../db/schema.ts";
import { createDbClient } from "../../db.ts";

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
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly localAccessAvailable: boolean;
  readonly metadata: LinearConnectionMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type LinearLocalAccessEnvelope = {
  readonly token?: string;
  readonly tokenExpiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
  readonly updatedAt: string;
};

export type SaveLinearLocalAccessInput = {
  readonly profileId: string;
  readonly token?: string | null;
  readonly tokenExpiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly refreshTokenExpiresAt?: string | null;
  readonly encryptionKey: string;
};

export type LinearStoredLocalAccess = {
  readonly connection: LinearConnectionRecord;
  readonly envelope: LinearLocalAccessEnvelope;
};

export type UpsertLinearConnectionInput = {
  readonly profileId?: string | null;
  readonly accountId?: string | null;
  readonly accountName?: string | null;
  readonly accountEmail?: string | null;
  readonly authRef?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
  readonly organizationId?: string | null;
  readonly teamId?: string | null;
  readonly metadata?: LinearConnectionMetadata;
};

export type ListLinearConnectionsInput = {
  readonly profileId?: string | null;
  readonly organizationId?: string | null;
  readonly betterAuthUserId?: string | null;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
};

export type LinearWebhookOwnership = {
  readonly status: "matched" | "ambiguous" | "unmatched";
  readonly profileId: string | null;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
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
  readonly saveLocalAccess: (
    input: SaveLinearLocalAccessInput
  ) => Promise<LinearConnectionRecord>;
  readonly readLocalAccess: (input: {
    readonly profileId: string;
    readonly encryptionKey: string;
  }) => Promise<LinearStoredLocalAccess | null>;
};

export class InMemoryLinearConnectionStore implements LinearConnectionStore {
  private readonly recordsByKey = new Map<string, LinearConnectionRecord>();
  private readonly localAccessByKey = new Map<
    string,
    LinearLocalAccessEnvelope
  >();

  upsertConnection(
    input: UpsertLinearConnectionInput
  ): Promise<LinearConnectionRecord> {
    const connectionKey = buildConnectionKey(input);
    const existing = this.recordsByKey.get(connectionKey);
    const now = new Date().toISOString();
    const metadata = composeConnectionMetadata({
      metadata: input.metadata,
      betterAuthOrganizationId: input.betterAuthOrganizationId,
      betterAuthTeamId: input.betterAuthTeamId,
    });
    const record: LinearConnectionRecord = {
      id: existing?.id ?? randomUUID(),
      connectionKey,
      profileId: normalizeText(input.profileId),
      accountId: normalizeText(input.accountId),
      accountName: normalizeText(input.accountName),
      accountEmail: normalizeText(input.accountEmail),
      authRef: normalizeText(input.authRef),
      betterAuthUserId: normalizeText(input.betterAuthUserId),
      betterAuthOrganizationId: normalizeText(input.betterAuthOrganizationId),
      betterAuthTeamId: normalizeText(input.betterAuthTeamId),
      organizationId: normalizeText(input.organizationId),
      teamId: normalizeText(input.teamId),
      localAccessAvailable: this.localAccessByKey.has(connectionKey),
      metadata,
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
        betterAuthOrganizationId: null,
        betterAuthTeamId: null,
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

  saveLocalAccess(
    input: SaveLinearLocalAccessInput
  ): Promise<LinearConnectionRecord> {
    const profileId = normalizeText(input.profileId);
    if (!profileId) {
      throw new Error("Missing Linear profile id for local access.");
    }
    const connection = [...this.recordsByKey.values()]
      .filter((record) => record.profileId === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!connection) {
      throw new Error(
        `Linear connection not found for profile "${profileId}".`
      );
    }
    const envelope = normalizeLocalAccessEnvelope({
      token: input.token,
      tokenExpiresAt: input.tokenExpiresAt,
      refreshToken: input.refreshToken,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    });
    if (!envelope) {
      throw new Error("Linear local access requires a token or refresh token.");
    }
    const updatedAt = new Date().toISOString();
    const storedEnvelope: LinearLocalAccessEnvelope = {
      ...envelope,
      updatedAt,
    };
    this.localAccessByKey.set(connection.connectionKey, storedEnvelope);
    const nextRecord: LinearConnectionRecord = {
      ...connection,
      localAccessAvailable: true,
      updatedAt,
    };
    this.recordsByKey.set(connection.connectionKey, nextRecord);
    return nextRecord;
  }

  readLocalAccess(input: {
    readonly profileId: string;
    readonly encryptionKey: string;
  }): Promise<LinearStoredLocalAccess | null> {
    const profileId = normalizeText(input.profileId);
    if (!profileId) {
      return null;
    }
    const connection = [...this.recordsByKey.values()]
      .filter((record) => record.profileId === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!connection) {
      return null;
    }
    const envelope = this.localAccessByKey.get(connection.connectionKey);
    if (!envelope) {
      return null;
    }
    return {
      connection: {
        ...connection,
        localAccessAvailable: true,
      },
      envelope,
    };
  }
}

export function createLinearConnectionStoreFromDb(input: {
  readonly databaseUrl: string;
}): LinearConnectionStore {
  const db = createDbClient({ databaseUrl: input.databaseUrl });
  const ensureTable = createLinearConnectionsTableEnsurer({
    db,
  });
  return {
    upsertConnection: async (connection) => {
      await ensureTable();
      const connectionKey = buildConnectionKey(connection);
      const now = new Date();
      const id = randomUUID();
      const metadataJson = JSON.stringify(
        composeConnectionMetadata({
          metadata: connection.metadata,
          betterAuthOrganizationId: connection.betterAuthOrganizationId,
          betterAuthTeamId: connection.betterAuthTeamId,
        })
      );
      const inserted = await db
        .insert(linearConnections)
        .values({
          id,
          connectionKey,
          profileId: normalizeText(connection.profileId),
          accountId: normalizeText(connection.accountId),
          accountName: normalizeText(connection.accountName),
          accountEmail: normalizeText(connection.accountEmail),
          authRef: normalizeText(connection.authRef),
          betterAuthUserId: normalizeText(connection.betterAuthUserId),
          betterAuthOrganizationId: normalizeText(
            connection.betterAuthOrganizationId
          ),
          betterAuthTeamId: normalizeText(connection.betterAuthTeamId),
          organizationId: normalizeText(connection.organizationId),
          teamId: normalizeText(connection.teamId),
          metadataJson,
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
            betterAuthOrganizationId: normalizeText(
              connection.betterAuthOrganizationId
            ),
            betterAuthTeamId: normalizeText(connection.betterAuthTeamId),
            organizationId: normalizeText(connection.organizationId),
            teamId: normalizeText(connection.teamId),
            metadataJson,
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
      await ensureTable();
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
      return rows
        .map((row) => toConnectionRecord({ row }))
        .filter((record) => matchesConnectionFilter({ record, filter: input }));
    },

    resolveWebhookOwnership: async ({ profileId, organizationId }) => {
      await ensureTable();
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
          betterAuthOrganizationId: null,
          betterAuthTeamId: null,
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
    saveLocalAccess: async (input) => {
      await ensureTable();
      const profileId = normalizeText(input.profileId);
      if (!profileId) {
        throw new Error("Missing Linear profile id for local access.");
      }
      const row = (
        await db
          .select()
          .from(linearConnections)
          .where(eq(linearConnections.profileId, profileId))
          .orderBy(desc(linearConnections.updatedAt))
          .limit(1)
      )[0];
      if (!row) {
        throw new Error(
          `Linear connection not found for profile "${profileId}".`
        );
      }
      const envelope = normalizeLocalAccessEnvelope({
        token: input.token,
        tokenExpiresAt: input.tokenExpiresAt,
        refreshToken: input.refreshToken,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      });
      if (!envelope) {
        throw new Error(
          "Linear local access requires a token or refresh token."
        );
      }
      const updatedAt = new Date();
      const storedEnvelope: LinearLocalAccessEnvelope = {
        ...envelope,
        updatedAt: updatedAt.toISOString(),
      };
      const updated = await db
        .update(linearConnections)
        .set({
          localAccessSealed: sealLocalAccessEnvelope({
            encryptionKey: input.encryptionKey,
            envelope: storedEnvelope,
          }),
          localAccessUpdatedAt: updatedAt,
          updatedAt,
        })
        .where(eq(linearConnections.id, row.id))
        .returning();
      const saved = updated[0];
      if (!saved) {
        throw new Error("Failed to persist Linear local access custody.");
      }
      return toConnectionRecord({ row: saved });
    },
    readLocalAccess: async (input) => {
      await ensureTable();
      const profileId = normalizeText(input.profileId);
      if (!profileId) {
        return null;
      }
      const row = (
        await db
          .select()
          .from(linearConnections)
          .where(eq(linearConnections.profileId, profileId))
          .orderBy(desc(linearConnections.updatedAt))
          .limit(1)
      )[0];
      if (!(row && normalizeText(row.localAccessSealed))) {
        return null;
      }
      return {
        connection: toConnectionRecord({ row }),
        envelope: unsealLocalAccessEnvelope({
          encryptionKey: input.encryptionKey,
          sealed: row.localAccessSealed ?? "",
        }),
      };
    },
  };
}

function createLinearConnectionsTableEnsurer(input: {
  readonly db: ReturnType<typeof createDbClient>;
}) {
  const ensureOwnershipColumns = createTableColumnsEnsurer({
    db: input.db,
    tableName: "linear_connections",
    columns: [
      {
        name: "better_auth_organization_id",
        definition: "text",
      },
      {
        name: "better_auth_team_id",
        definition: "text",
      },
      {
        name: "local_access_sealed",
        definition: "text",
      },
      {
        name: "local_access_updated_at",
        definition: "timestamptz",
      },
    ],
  });
  let promise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!promise) {
      promise = ensureLinearConnectionsTable({ db: input.db })
        .then(() => ensureOwnershipColumns())
        .catch((error) => {
          promise = null;
          throw error;
        });
    }
    await promise;
  };
}

export async function ensureLinearConnectionsTable(input: {
  readonly db: ReturnType<typeof createDbClient>;
}): Promise<void> {
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS linear_connections (
      id uuid PRIMARY KEY,
      connection_key text NOT NULL UNIQUE,
      profile_id text,
      account_id text,
      account_name text,
      account_email text,
      auth_ref text,
      better_auth_user_id text,
      better_auth_organization_id text,
      better_auth_team_id text,
      organization_id text,
      team_id text,
      local_access_sealed text,
      local_access_updated_at timestamptz,
      metadata_json text NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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
  const betterAuthUserId = normalizeText(input.input.betterAuthUserId);
  if (
    betterAuthUserId &&
    normalizeText(input.input.betterAuthOrganizationId) == null
  ) {
    filters.push(eq(linearConnections.betterAuthUserId, betterAuthUserId));
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
  const betterAuthOrganizationId = normalizeText(
    input.filter.betterAuthOrganizationId
  );
  if (
    betterAuthOrganizationId &&
    input.record.betterAuthOrganizationId !== betterAuthOrganizationId
  ) {
    const fallbackBetterAuthUserId = normalizeText(
      input.filter.betterAuthUserId
    );
    if (
      input.record.betterAuthOrganizationId != null ||
      fallbackBetterAuthUserId == null ||
      input.record.betterAuthUserId !== fallbackBetterAuthUserId
    ) {
      return false;
    }
  } else if (betterAuthOrganizationId) {
    return true;
  }
  const betterAuthTeamId = normalizeText(input.filter.betterAuthTeamId);
  if (betterAuthTeamId && input.record.betterAuthTeamId !== betterAuthTeamId) {
    return false;
  }
  const betterAuthUserId = normalizeText(input.filter.betterAuthUserId);
  if (betterAuthUserId && input.record.betterAuthUserId !== betterAuthUserId) {
    return false;
  }
  return true;
}

export function toConnectionRecord(input: {
  readonly row: typeof linearConnections.$inferSelect;
}): LinearConnectionRecord {
  const storedOwnership = readStoredConnectionOwnership({
    raw: input.row.metadataJson,
  });
  return {
    id: input.row.id,
    connectionKey: input.row.connectionKey,
    profileId: input.row.profileId ?? null,
    accountId: input.row.accountId ?? null,
    accountName: input.row.accountName ?? null,
    accountEmail: input.row.accountEmail ?? null,
    authRef: input.row.authRef ?? null,
    betterAuthUserId: input.row.betterAuthUserId ?? null,
    betterAuthOrganizationId:
      input.row.betterAuthOrganizationId ??
      storedOwnership.betterAuthOrganizationId,
    betterAuthTeamId:
      input.row.betterAuthTeamId ?? storedOwnership.betterAuthTeamId,
    organizationId: input.row.organizationId ?? null,
    teamId: input.row.teamId ?? null,
    localAccessAvailable: Boolean(
      normalizeText(input.row.localAccessSealed ?? null)
    ),
    metadata: parseMetadata({ raw: input.row.metadataJson }),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

export const materializeLinearConnectionRecord = toConnectionRecord;

function parseMetadata(input: {
  readonly raw: string;
}): LinearConnectionMetadata {
  try {
    const parsed = JSON.parse(input.raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const metadata = {
      ...(parsed as LinearConnectionMetadata),
    };
    delete metadata[BETTER_AUTH_ORGANIZATION_METADATA_KEY];
    delete metadata[BETTER_AUTH_TEAM_METADATA_KEY];
    return metadata;
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
      betterAuthOrganizationId: preferred.betterAuthOrganizationId,
      betterAuthTeamId: preferred.betterAuthTeamId,
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
      betterAuthOrganizationId: null,
      betterAuthTeamId: null,
      organizationId: input.fallbackOrganizationId,
      teamId: null,
    };
  }
  return {
    status: "unmatched",
    profileId: null,
    betterAuthUserId: null,
    betterAuthOrganizationId: null,
    betterAuthTeamId: null,
    organizationId: input.fallbackOrganizationId,
    teamId: null,
  };
}

const BETTER_AUTH_ORGANIZATION_METADATA_KEY = "_betterAuthOrganizationId";
const BETTER_AUTH_TEAM_METADATA_KEY = "_betterAuthTeamId";
const LOCAL_ACCESS_CIPHERTEXT_VERSION = 1;
const LOCAL_ACCESS_IV_BYTES = 12;
const LOCAL_ACCESS_ALGORITHM = "aes-256-gcm";

function composeConnectionMetadata(input: {
  readonly metadata?: LinearConnectionMetadata;
  readonly betterAuthOrganizationId?: string | null;
  readonly betterAuthTeamId?: string | null;
}): LinearConnectionMetadata {
  const metadata = { ...(input.metadata ?? {}) };
  const betterAuthOrganizationId = normalizeText(
    input.betterAuthOrganizationId
  );
  if (betterAuthOrganizationId) {
    metadata[BETTER_AUTH_ORGANIZATION_METADATA_KEY] = betterAuthOrganizationId;
  } else {
    delete metadata[BETTER_AUTH_ORGANIZATION_METADATA_KEY];
  }
  const betterAuthTeamId = normalizeText(input.betterAuthTeamId);
  if (betterAuthTeamId) {
    metadata[BETTER_AUTH_TEAM_METADATA_KEY] = betterAuthTeamId;
  } else {
    delete metadata[BETTER_AUTH_TEAM_METADATA_KEY];
  }
  return metadata;
}

export function readStoredConnectionOwnership(input: {
  readonly raw: string;
}): {
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
} {
  try {
    const parsed = JSON.parse(input.raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {
        betterAuthOrganizationId: null,
        betterAuthTeamId: null,
      };
    }
    const record = parsed as Record<string, unknown>;
    return {
      betterAuthOrganizationId: normalizeText(
        record[BETTER_AUTH_ORGANIZATION_METADATA_KEY]
      ),
      betterAuthTeamId: normalizeText(record[BETTER_AUTH_TEAM_METADATA_KEY]),
    };
  } catch {
    return {
      betterAuthOrganizationId: null,
      betterAuthTeamId: null,
    };
  }
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLocalAccessEnvelope(input: {
  readonly token?: unknown;
  readonly tokenExpiresAt?: unknown;
  readonly refreshToken?: unknown;
  readonly refreshTokenExpiresAt?: unknown;
}): Omit<LinearLocalAccessEnvelope, "updatedAt"> | null {
  const token = normalizeText(input.token);
  const refreshToken = normalizeText(input.refreshToken);
  if (!(token || refreshToken)) {
    return null;
  }
  return {
    ...(token ? { token } : {}),
    ...(normalizeText(input.tokenExpiresAt)
      ? { tokenExpiresAt: normalizeText(input.tokenExpiresAt) ?? undefined }
      : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(normalizeText(input.refreshTokenExpiresAt)
      ? {
          refreshTokenExpiresAt:
            normalizeText(input.refreshTokenExpiresAt) ?? undefined,
        }
      : {}),
  };
}

function sealLocalAccessEnvelope(input: {
  readonly encryptionKey: string;
  readonly envelope: LinearLocalAccessEnvelope;
}): string {
  const key = deriveEncryptionKey({ source: input.encryptionKey });
  const iv = randomBytes(LOCAL_ACCESS_IV_BYTES);
  const cipher = createCipheriv(LOCAL_ACCESS_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.envelope), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: LOCAL_ACCESS_CIPHERTEXT_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function unsealLocalAccessEnvelope(input: {
  readonly encryptionKey: string;
  readonly sealed: string;
}): LinearLocalAccessEnvelope {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.sealed) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid stored Linear local access envelope.");
  }
  const ciphertext = normalizeText(parsed.ciphertext);
  const iv = normalizeText(parsed.iv);
  const tag = normalizeText(parsed.tag);
  if (!(ciphertext && iv && tag)) {
    throw new Error("Stored Linear local access envelope is incomplete.");
  }
  const decipher = createDecipheriv(
    LOCAL_ACCESS_ALGORITHM,
    deriveEncryptionKey({ source: input.encryptionKey }),
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(plaintext) as Record<string, unknown>;
  } catch {
    throw new Error("Stored Linear local access payload is invalid.");
  }
  const updatedAt = normalizeText(payload.updatedAt);
  const normalized = normalizeLocalAccessEnvelope({
    token: payload.token,
    tokenExpiresAt: payload.tokenExpiresAt,
    refreshToken: payload.refreshToken,
    refreshTokenExpiresAt: payload.refreshTokenExpiresAt,
  });
  if (!(updatedAt && normalized)) {
    throw new Error("Stored Linear local access payload is incomplete.");
  }
  return {
    ...normalized,
    updatedAt,
  };
}

function deriveEncryptionKey(input: { readonly source: string }): Buffer {
  const source = input.source.trim();
  if (!source) {
    throw new Error("Missing provider token encryption key.");
  }
  return createHash("sha256").update(source).digest();
}
