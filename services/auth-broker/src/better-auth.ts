import { createDbClient } from "@hack/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { z } from "zod";

type BetterAuthInstance = ReturnType<typeof betterAuth>;

type BetterAuthRuntime = {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly auth?: BetterAuthInstance;
};

const betterAuthEnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
});

/**
 * Create a Better Auth runtime from process environment.
 *
 * If required values are missing, runtime is returned as disabled so existing
 * broker routes can still start in local/dev modes.
 */
export function createBetterAuthRuntimeFromEnv(): BetterAuthRuntime {
  const env = betterAuthEnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  });

  if (!env.DATABASE_URL) {
    return {
      enabled: false,
      reason: "DATABASE_URL is not configured.",
    };
  }
  if (!env.BETTER_AUTH_SECRET) {
    return {
      enabled: false,
      reason: "BETTER_AUTH_SECRET is not configured.",
    };
  }

  const trustedOrigins = parseCsv(env.BETTER_AUTH_TRUSTED_ORIGINS);
  const githubEnabled = Boolean(
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
  );

  const auth = betterAuth({
    database: drizzleAdapter(
      createDbClient({ databaseUrl: env.DATABASE_URL }),
      {
        provider: "pg",
      }
    ),
    secret: env.BETTER_AUTH_SECRET,
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    emailAndPassword: {
      enabled: true,
    },
    ...(githubEnabled
      ? {
          socialProviders: {
            github: {
              clientId: env.GITHUB_CLIENT_ID ?? "",
              clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
            },
          },
        }
      : {}),
    plugins: [
      organization({
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
  };
}

export type { BetterAuthRuntime };

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
