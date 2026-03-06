import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization as organizationPlugin } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authBrokerSchema } from "./db/schema.ts";
import { createDbClient } from "./db.ts";

type BetterAuthInstance = ReturnType<typeof betterAuth>;
type AuthBrokerDbClient = ReturnType<typeof createDbClient>;
type BetterAuthEnv = z.infer<typeof betterAuthEnvSchema>;

export type BetterAuthSocialProvider = {
  readonly id: string;
  readonly label: string;
};

export type BetterAuthAccountLinkingPolicy = {
  readonly requireVerifiedEmail: boolean;
  readonly allowDifferentEmails: boolean;
  readonly trustedProviders: readonly string[];
};

type BetterAuthRuntime = {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly auth?: BetterAuthInstance;
  readonly db?: AuthBrokerDbClient;
  readonly ready?: Promise<void>;
  readonly socialProviders?: readonly BetterAuthSocialProvider[];
  readonly accountLinkingPolicy?: BetterAuthAccountLinkingPolicy;
};

const betterAuthEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  BETTER_AUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  BETTER_AUTH_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  BETTER_AUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  BETTER_AUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

/**
 * Create a Better Auth runtime from process environment.
 *
 * If required values are missing, runtime is returned as disabled so existing
 * broker routes can still start in local/dev modes.
 */
export function createBetterAuthRuntimeFromEnv(): BetterAuthRuntime {
  const env = readBetterAuthEnv();
  const requiredConfig = resolveBetterAuthRequiredConfig(env);
  if (!requiredConfig.ok) {
    return {
      enabled: false,
      reason: requiredConfig.reason,
    };
  }

  const trustedOrigins = parseCsv(env.BETTER_AUTH_TRUSTED_ORIGINS);
  const socialProviderConfig = resolveBetterAuthSocialProviderConfig(env);
  const accountLinkingPolicy = {
    requireVerifiedEmail: true,
    allowDifferentEmails: false,
    trustedProviders: [],
  } as const satisfies BetterAuthAccountLinkingPolicy;
  const db = createDbClient({ databaseUrl: requiredConfig.databaseUrl });
  const ready = ensureBetterAuthTables({ db });

  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authBrokerSchema,
    }),
    secret: requiredConfig.authSecret,
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    emailAndPassword: {
      enabled: true,
    },
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: accountLinkingPolicy.allowDifferentEmails,
        trustedProviders: [...accountLinkingPolicy.trustedProviders],
      },
    },
    ...(socialProviderConfig.providerOptions
      ? {
          socialProviders: socialProviderConfig.providerOptions,
        }
      : {}),
    plugins: [
      organizationPlugin({
        membershipLimit: 500,
        teams: {
          enabled: true,
          defaultTeam: {
            enabled: true,
          },
          maximumTeams: 100,
          allowRemovingAllTeams: false,
        },
      }),
    ],
  });

  return {
    enabled: true,
    auth,
    db,
    ready,
    socialProviders: socialProviderConfig.socialProviders,
    accountLinkingPolicy,
  };
}

export type { BetterAuthRuntime };

export async function ensureBetterAuthRuntimeReady(
  runtime: BetterAuthRuntime
): Promise<void> {
  await runtime.ready;
}

function readBetterAuthEnv(): BetterAuthEnv {
  return betterAuthEnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    BETTER_AUTH_GITHUB_CLIENT_ID: process.env.BETTER_AUTH_GITHUB_CLIENT_ID,
    BETTER_AUTH_GITHUB_CLIENT_SECRET:
      process.env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    BETTER_AUTH_GOOGLE_CLIENT_ID: process.env.BETTER_AUTH_GOOGLE_CLIENT_ID,
    BETTER_AUTH_GOOGLE_CLIENT_SECRET:
      process.env.BETTER_AUTH_GOOGLE_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  });
}

function resolveBetterAuthRequiredConfig(env: BetterAuthEnv):
  | {
      readonly ok: true;
      readonly databaseUrl: string;
      readonly authSecret: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (!env.DATABASE_URL) {
    return {
      ok: false,
      reason: "DATABASE_URL is not configured.",
    };
  }
  if (!env.BETTER_AUTH_SECRET) {
    return {
      ok: false,
      reason: "BETTER_AUTH_SECRET is not configured.",
    };
  }
  return {
    ok: true,
    databaseUrl: env.DATABASE_URL,
    authSecret: env.BETTER_AUTH_SECRET,
  };
}

function resolveBetterAuthSocialProviderConfig(env: BetterAuthEnv): {
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly providerOptions: {
    readonly github?: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
    readonly google?: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
  } | null;
} {
  const resolvedGitHubClientId =
    env.BETTER_AUTH_GITHUB_CLIENT_ID ?? env.GITHUB_CLIENT_ID;
  const resolvedGitHubClientSecret =
    env.BETTER_AUTH_GITHUB_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET;
  const resolvedGoogleClientId =
    env.BETTER_AUTH_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
  const resolvedGoogleClientSecret =
    env.BETTER_AUTH_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
  const providerOptions = {
    ...(resolvedGitHubClientId && resolvedGitHubClientSecret
      ? {
          github: {
            clientId: resolvedGitHubClientId,
            clientSecret: resolvedGitHubClientSecret,
          },
        }
      : {}),
    ...(resolvedGoogleClientId && resolvedGoogleClientSecret
      ? {
          google: {
            clientId: resolvedGoogleClientId,
            clientSecret: resolvedGoogleClientSecret,
          },
        }
      : {}),
  };
  const socialProviders = [
    ...(providerOptions.github ? [{ id: "github", label: "GitHub" }] : []),
    ...(providerOptions.google ? [{ id: "google", label: "Google" }] : []),
  ] as const satisfies readonly BetterAuthSocialProvider[];

  return {
    socialProviders,
    providerOptions:
      Object.keys(providerOptions).length > 0 ? providerOptions : null,
  };
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function ensureBetterAuthTables(input: {
  readonly db: AuthBrokerDbClient;
}): Promise<void> {
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "email_verified" boolean NOT NULL DEFAULT false,
      "image" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "organization" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "logo" text,
      "metadata" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "team" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "organization_id" text NOT NULL REFERENCES "organization"("id"),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text PRIMARY KEY,
      "expires_at" timestamptz NOT NULL,
      "token" text NOT NULL UNIQUE,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "ip_address" text,
      "user_agent" text,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "active_organization_id" text,
      "active_team_id" text
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text PRIMARY KEY,
      "account_id" text NOT NULL,
      "provider_id" text NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "access_token" text,
      "refresh_token" text,
      "id_token" text,
      "access_token_expires_at" timestamptz,
      "refresh_token_expires_at" timestamptz,
      "scope" text,
      "password" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "member" (
      "id" text PRIMARY KEY,
      "organization_id" text NOT NULL REFERENCES "organization"("id"),
      "user_id" text NOT NULL REFERENCES "user"("id"),
      "role" text NOT NULL DEFAULT 'member',
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "invitation" (
      "id" text PRIMARY KEY,
      "organization_id" text NOT NULL REFERENCES "organization"("id"),
      "email" text NOT NULL,
      "role" text,
      "team_id" text,
      "status" text NOT NULL DEFAULT 'pending',
      "expires_at" timestamptz NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "inviter_id" text NOT NULL REFERENCES "user"("id")
    )
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS "team_member" (
      "id" text PRIMARY KEY,
      "team_id" text NOT NULL REFERENCES "team"("id"),
      "user_id" text NOT NULL REFERENCES "user"("id"),
      "created_at" timestamptz DEFAULT now()
    )
  `);

  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" ("user_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_idx" ON "account" ("provider_id", "account_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" ("user_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "member_organization_id_idx" ON "member" ("organization_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "member_user_id_idx" ON "member" ("user_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS "member_organization_user_idx" ON "member" ("organization_id", "user_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "team_organization_id_idx" ON "team" ("organization_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "invitation_organization_id_idx" ON "invitation" ("organization_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "team_member_team_id_idx" ON "team_member" ("team_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE INDEX IF NOT EXISTS "team_member_user_id_idx" ON "team_member" ("user_id")'
    )
  );
  await input.db.execute(
    sql.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS "team_member_team_user_idx" ON "team_member" ("team_id", "user_id")'
    )
  );
}
