import { eq } from "drizzle-orm";

import {
  type BetterAuthRuntime,
  ensureBetterAuthRuntimeReady,
} from "../../better-auth.ts";
import { user as betterAuthUser } from "../../db/schema.ts";
import { verifyBrokerManagementToken } from "./management-token.ts";

const AUTHORIZATION_BEARER_PATTERN = /^Bearer\s+(.+)$/i;

export type BrokerBetterAuthSession = {
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly name: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly managementTokenProfileId: string | null;
};

export type BetterAuthOwnedRecord = {
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly profileId?: string | null;
};

export type BetterAuthSessionResolution =
  | {
      readonly enabled: false;
      readonly accessControlMode: "manual_unenforced";
      readonly session: null;
    }
  | {
      readonly enabled: true;
      readonly accessControlMode:
        | "better_auth_team_owned"
        | "better_auth_session_owned"
        | "better_auth_organization_owned";
      readonly session: BrokerBetterAuthSession | null;
    };

/**
 * Resolve the current Better Auth session from an inbound broker request.
 *
 * When Better Auth is disabled we intentionally fall back to permissive local
 * behavior so dev/test environments can still exercise the broker without
 * having to provision auth state.
 */
export async function resolveBetterAuthSession(input: {
  readonly runtime: BetterAuthRuntime;
  readonly request: Request;
}): Promise<BetterAuthSessionResolution> {
  if (!(input.runtime.enabled && input.runtime.auth)) {
    return {
      enabled: false,
      accessControlMode: "manual_unenforced",
      session: null,
    };
  }
  await ensureBetterAuthRuntimeReady(input.runtime);
  const session = await input.runtime.auth.api.getSession({
    headers: input.request.headers,
  });
  const resolvedSession =
    (session?.user?.id ? toResolvedSession({ session }) : null) ??
    (await resolveManagementTokenSession({
      runtime: input.runtime,
      request: input.request,
    }));
  const accessControlMode = resolveAccessControlMode({
    session: resolvedSession,
  });
  return {
    enabled: true,
    accessControlMode,
    session: resolvedSession,
  };
}

async function resolveManagementTokenSession(input: {
  readonly runtime: BetterAuthRuntime;
  readonly request: Request;
}): Promise<BrokerBetterAuthSession | null> {
  const token = readBearerToken({
    authorizationHeader: input.request.headers.get("authorization"),
  });
  if (!token) {
    return null;
  }
  const verification = verifyBrokerManagementToken({ token });
  if (!verification.ok) {
    return null;
  }
  const user = await readUserRecord({
    runtime: input.runtime,
    userId: verification.claims.sub,
  });
  return {
    userId: verification.claims.sub,
    email: user?.email ?? null,
    emailVerified: user?.emailVerified ?? null,
    name: user?.name ?? null,
    organizationId: verification.claims.organizationId ?? null,
    teamId: verification.claims.teamId ?? null,
    managementTokenProfileId: verification.claims.profileId ?? null,
  };
}

function toResolvedSession(input: {
  readonly session: NonNullable<
    Awaited<
      ReturnType<
        NonNullable<NonNullable<BetterAuthRuntime["auth"]>["api"]>["getSession"]
      >
    >
  >;
}): BrokerBetterAuthSession {
  return {
    userId: input.session.user.id,
    email: normalizeOptionalString(input.session.user.email),
    emailVerified: readOptionalBoolean(input.session.user.emailVerified),
    name: normalizeOptionalString(input.session.user.name),
    organizationId: extractBetterAuthOrganizationId(input.session),
    teamId: extractBetterAuthTeamId(input.session),
    managementTokenProfileId: null,
  };
}

function resolveAccessControlMode(input: {
  readonly session: BrokerBetterAuthSession | null;
}):
  | "better_auth_team_owned"
  | "better_auth_session_owned"
  | "better_auth_organization_owned" {
  if (input.session?.teamId) {
    return "better_auth_team_owned";
  }
  if (input.session?.organizationId) {
    return "better_auth_organization_owned";
  }
  return "better_auth_session_owned";
}

export function hasBetterAuthAccess(input: {
  readonly session: BrokerBetterAuthSession;
  readonly record: BetterAuthOwnedRecord;
}): boolean {
  if (
    !hasBetterAuthProfileAccess({
      session: input.session,
      profileId: normalizeOptionalString(input.record.profileId),
    })
  ) {
    return false;
  }

  const recordTeamId = normalizeOptionalString(input.record.betterAuthTeamId);
  if (recordTeamId) {
    if (normalizeOptionalString(input.session.teamId) !== recordTeamId) {
      return false;
    }
    const recordOrganizationId = normalizeOptionalString(
      input.record.betterAuthOrganizationId
    );
    const sessionOrganizationId = normalizeOptionalString(
      input.session.organizationId
    );
    if (
      recordOrganizationId &&
      sessionOrganizationId &&
      recordOrganizationId !== sessionOrganizationId
    ) {
      return false;
    }
    return true;
  }

  const recordOrganizationId = normalizeOptionalString(
    input.record.betterAuthOrganizationId
  );
  if (recordOrganizationId) {
    return (
      normalizeOptionalString(input.session.organizationId) ===
      recordOrganizationId
    );
  }

  return (
    normalizeOptionalString(input.record.betterAuthUserId) ===
    normalizeOptionalString(input.session.userId)
  );
}

export function hasBetterAuthProfileAccess(input: {
  readonly session: BrokerBetterAuthSession | null;
  readonly profileId?: string | null;
}): boolean {
  if (!input.session) {
    return false;
  }
  const managementTokenProfileId = normalizeOptionalString(
    input.session.managementTokenProfileId
  );
  if (!managementTokenProfileId) {
    return true;
  }
  const requestedProfileId = normalizeOptionalString(input.profileId);
  if (!requestedProfileId) {
    return false;
  }
  return requestedProfileId === managementTokenProfileId;
}

function extractBetterAuthOrganizationId(session: unknown): string | null {
  const record = readRecord(session);
  const sessionRecord = readRecord(record?.session);
  return (
    normalizeOptionalString(sessionRecord?.activeOrganizationId) ??
    normalizeOptionalString(sessionRecord?.organizationId) ??
    readNestedRecordId(sessionRecord?.activeOrganization) ??
    normalizeOptionalString(record?.activeOrganizationId) ??
    normalizeOptionalString(record?.organizationId) ??
    readNestedRecordId(record?.activeOrganization) ??
    null
  );
}

function extractBetterAuthTeamId(session: unknown): string | null {
  const record = readRecord(session);
  const sessionRecord = readRecord(record?.session);
  return (
    normalizeOptionalString(sessionRecord?.activeTeamId) ??
    normalizeOptionalString(sessionRecord?.teamId) ??
    readNestedRecordId(sessionRecord?.activeTeam) ??
    normalizeOptionalString(record?.activeTeamId) ??
    normalizeOptionalString(record?.teamId) ??
    readNestedRecordId(record?.activeTeam) ??
    null
  );
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readNestedRecordId(value: unknown): string | null {
  const record = readRecord(value);
  return normalizeOptionalString(record?.id);
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function readUserRecord(input: {
  readonly runtime: BetterAuthRuntime;
  readonly userId: string;
}): Promise<{
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
} | null> {
  const db = input.runtime.db;
  const userId = normalizeOptionalString(input.userId);
  if (!(db && userId)) {
    return null;
  }
  if (!("select" in db) || typeof db.select !== "function") {
    return null;
  }

  const [record] = await db
    .select({
      email: betterAuthUser.email,
      emailVerified: betterAuthUser.emailVerified,
      name: betterAuthUser.name,
    })
    .from(betterAuthUser)
    .where(eq(betterAuthUser.id, userId))
    .limit(1);
  if (!record) {
    return null;
  }

  return {
    email: normalizeOptionalString(record.email),
    emailVerified: record.emailVerified === true,
    name: normalizeOptionalString(record.name),
  };
}

function readBearerToken(input: {
  readonly authorizationHeader: string | null;
}): string | null {
  const header = normalizeOptionalString(input.authorizationHeader);
  if (!header) {
    return null;
  }
  const match = AUTHORIZATION_BEARER_PATTERN.exec(header);
  return match ? normalizeOptionalString(match[1]) : null;
}
