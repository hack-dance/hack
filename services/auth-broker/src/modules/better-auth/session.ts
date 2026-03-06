import type { BetterAuthRuntime } from "../../better-auth.ts";

export type BrokerBetterAuthSession = {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly organizationId: string | null;
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
  const session = await input.runtime.auth.api.getSession({
    headers: input.request.headers,
  });
  const resolvedSession = session?.user?.id
    ? {
        userId: session.user.id,
        email: normalizeOptionalString(session.user.email),
        name: normalizeOptionalString(session.user.name),
        organizationId: extractBetterAuthOrganizationId(session),
      }
    : null;
  return {
    enabled: true,
    accessControlMode: resolvedSession?.organizationId
      ? "better_auth_organization_owned"
      : "better_auth_session_owned",
    session: resolvedSession,
  };
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
