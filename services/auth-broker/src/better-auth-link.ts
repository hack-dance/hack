import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import type { BetterAuthRuntime } from "./better-auth.ts";
import type { OAuthFlowAccount } from "./types.ts";

export type BetterAuthUserLinkState =
  | "disabled"
  | "missing_email"
  | "linked_existing"
  | "created_new"
  | "not_linked"
  | "error";

export type BetterAuthUserLinkResult = {
  readonly state: BetterAuthUserLinkState;
  readonly userId?: string;
  readonly reason?: string;
};

/**
 * Resolve a Better Auth user id from GitHub identity data.
 *
 * Resolution order:
 * 1. Existing `account` link for provider `github` + account id.
 * 2. Existing Better Auth user by email.
 * 3. Optional user auto-provision by email when enabled.
 */
export async function resolveBetterAuthUserFromGitHubAccount(input: {
  readonly runtime: BetterAuthRuntime;
  readonly account: OAuthFlowAccount;
  readonly autoProvision: boolean;
}): Promise<BetterAuthUserLinkResult> {
  return await resolveBetterAuthUserFromOAuthAccount({
    runtime: input.runtime,
    account: input.account,
    autoProvision: input.autoProvision,
    providerId: "github",
  });
}

export async function resolveBetterAuthUserFromLinearAccount(input: {
  readonly runtime: BetterAuthRuntime;
  readonly account: OAuthFlowAccount;
  readonly autoProvision: boolean;
}): Promise<BetterAuthUserLinkResult> {
  return await resolveBetterAuthUserFromOAuthAccount({
    runtime: input.runtime,
    account: input.account,
    autoProvision: input.autoProvision,
    providerId: "linear",
  });
}

async function resolveBetterAuthUserFromOAuthAccount(input: {
  readonly runtime: BetterAuthRuntime;
  readonly account: OAuthFlowAccount;
  readonly autoProvision: boolean;
  readonly providerId: string;
}): Promise<BetterAuthUserLinkResult> {
  if (!hasEnabledBetterAuthDb(input.runtime)) {
    return { state: "disabled" };
  }
  const runtime = input.runtime;

  const accountId = normalizeText(input.account.accountId);
  const accountEmail = normalizeText(input.account.accountEmail);
  if (!accountEmail) {
    return { state: "missing_email" };
  }

  try {
    if (accountId) {
      const linkedUserId = await findUserIdByProviderAccountId({
        runtime,
        providerId: input.providerId,
        accountId,
      });
      if (linkedUserId) {
        return { state: "linked_existing", userId: linkedUserId };
      }
    }

    const existingUserId = await findUserIdByEmail({
      runtime,
      email: accountEmail,
    });
    if (existingUserId) {
      return { state: "linked_existing", userId: existingUserId };
    }

    if (!input.autoProvision) {
      return { state: "not_linked" };
    }

    const createdUserId = await createBetterAuthUserByEmail({
      runtime,
      email: accountEmail,
      name:
        normalizeText(input.account.accountName) ??
        normalizeText(input.account.login) ??
        normalizeText(input.account.accountHandle) ??
        accountEmail,
    });
    if (createdUserId) {
      return { state: "created_new", userId: createdUserId };
    }

    return { state: "error", reason: "user_provision_failed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "error",
      reason: normalizeText(message) ?? "unexpected_link_error",
    };
  }
}

async function findUserIdByGitHubAccountId(input: {
  readonly runtime: BetterAuthRuntime & {
    readonly db: NonNullable<BetterAuthRuntime["db"]>;
  };
  readonly providerId: string;
  readonly accountId: string;
}): Promise<string | null> {
  const result = await input.runtime.db.execute(
    sql`select "userId" as "userId"
        from "account"
        where "providerId" = ${input.providerId}
          and "accountId" = ${input.accountId}
        order by "createdAt" desc
        limit 1`
  );
  return readFirstFieldAsString({
    result,
    key: "userId",
  });
}

async function findUserIdByProviderAccountId(input: {
  readonly runtime: BetterAuthRuntime & {
    readonly db: NonNullable<BetterAuthRuntime["db"]>;
  };
  readonly providerId: string;
  readonly accountId: string;
}): Promise<string | null> {
  return await findUserIdByGitHubAccountId(input);
}

async function findUserIdByEmail(input: {
  readonly runtime: BetterAuthRuntime & {
    readonly db: NonNullable<BetterAuthRuntime["db"]>;
  };
  readonly email: string;
}): Promise<string | null> {
  const result = await input.runtime.db.execute(
    sql`select "id" as "id"
        from "user"
        where lower("email") = lower(${input.email})
        limit 1`
  );
  return readFirstFieldAsString({
    result,
    key: "id",
  });
}

async function createBetterAuthUserByEmail(input: {
  readonly runtime: BetterAuthRuntime & {
    readonly db: NonNullable<BetterAuthRuntime["db"]>;
  };
  readonly email: string;
  readonly name: string;
}): Promise<string | null> {
  const createdId = randomUUID();
  const inserted = await input.runtime.db.execute(
    sql`insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
        values (${createdId}, ${input.name}, ${input.email}, false, now(), now())
        on conflict ("email") do nothing
        returning "id" as "id"`
  );
  const insertedId = readFirstFieldAsString({
    result: inserted,
    key: "id",
  });
  if (insertedId) {
    return insertedId;
  }

  return await findUserIdByEmail({
    runtime: input.runtime,
    email: input.email,
  });
}

function readFirstFieldAsString(input: {
  readonly result: unknown;
  readonly key: string;
}): string | null {
  const first = readFirstRow(input.result);
  if (!first) {
    return null;
  }
  return readStringField({
    record: first,
    key: input.key,
  });
}

function readFirstRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    const first = result[0];
    return isRecord(first) ? first : null;
  }
  if (!isRecord(result)) {
    return null;
  }
  const rows = result.rows;
  if (!Array.isArray(rows)) {
    return null;
  }
  const first = rows[0];
  return isRecord(first) ? first : null;
}

function readStringField(input: {
  readonly record: Record<string, unknown>;
  readonly key: string;
}): string | null {
  const value = input.record[input.key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function hasEnabledBetterAuthDb(
  runtime: BetterAuthRuntime
): runtime is BetterAuthRuntime & {
  readonly db: NonNullable<BetterAuthRuntime["db"]>;
} {
  return runtime.enabled && Boolean(runtime.db);
}
