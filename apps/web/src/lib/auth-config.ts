import {
  type BetterAuthProviderMetadata,
  createBetterAuthProviderMetadata,
  createSharedBetterAuthContract,
  resolveBetterAuthSocialProviders,
  type SharedBetterAuthContract,
} from "@hack/auth-contract";

const DEFAULT_APP_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_AUTH_BROKER_BASE_URL = "http://127.0.0.1:8080";
const TRAILING_SLASH_PATTERN = /\/$/;

export type WebAuthConfig = {
  readonly appBaseUrl: string;
  readonly authBrokerBaseUrl: string;
  readonly authBrokerProxyBaseUrl: string;
  readonly contract: SharedBetterAuthContract;
};

export type AuthoritativeWebAuthConfig = WebAuthConfig & {
  readonly betterAuth: BetterAuthProviderMetadata;
  readonly betterAuthSource: "broker" | "fail_closed";
};

export function getWebAuthConfig(): WebAuthConfig {
  const appBaseUrl =
    normalizeAbsoluteUrl(
      readFirstDefinedValue([
        process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL,
        process.env.HACK_WEB_APP_BASE_URL,
        process.env.NEXT_PUBLIC_APP_BASE_URL,
        process.env.APP_BASE_URL,
      ])
    ) ?? DEFAULT_APP_BASE_URL;
  const authBrokerBaseUrl =
    normalizeAbsoluteUrl(
      readFirstDefinedValue([
        process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL,
        process.env.HACK_AUTH_BROKER_URL,
        process.env.AUTH_BROKER_PUBLIC_BASE_URL,
      ])
    ) ?? DEFAULT_AUTH_BROKER_BASE_URL;
  const authBrokerProxyBaseUrl =
    normalizeAbsoluteUrl(
      readFirstDefinedValue([
        process.env.HACK_AUTH_BROKER_INTERNAL_URL,
        process.env.AUTH_BROKER_INTERNAL_URL,
      ])
    ) ?? authBrokerBaseUrl;

  return {
    appBaseUrl,
    authBrokerBaseUrl,
    authBrokerProxyBaseUrl,
    contract: createSharedBetterAuthContract({
      socialProviders: resolveBetterAuthSocialProviders({
        betterAuthGitHubClientId: process.env.BETTER_AUTH_GITHUB_CLIENT_ID,
        betterAuthGitHubClientSecret:
          process.env.BETTER_AUTH_GITHUB_CLIENT_SECRET,
        githubClientId: process.env.GITHUB_CLIENT_ID,
        githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
        betterAuthGoogleClientId: process.env.BETTER_AUTH_GOOGLE_CLIENT_ID,
        betterAuthGoogleClientSecret:
          process.env.BETTER_AUTH_GOOGLE_CLIENT_SECRET,
        googleClientId: process.env.GOOGLE_CLIENT_ID,
        googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
      authBaseUrl: authBrokerBaseUrl,
      publicBaseUrl: appBaseUrl,
      localDevHost: resolveLocalDevHost({ appBaseUrl }),
      trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    }),
  };
}

export async function getAuthoritativeWebAuthConfig(): Promise<AuthoritativeWebAuthConfig> {
  const config = getWebAuthConfig();
  const betterAuth = await resolveBrokerBetterAuthMetadata({ config });

  return {
    ...config,
    betterAuth: betterAuth.metadata,
    betterAuthSource: betterAuth.source,
  };
}

function readFirstDefinedValue(
  values: readonly (string | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeAbsoluteUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).toString().replace(TRAILING_SLASH_PATTERN, "");
  } catch {
    return null;
  }
}

async function resolveBrokerBetterAuthMetadata(input: {
  readonly config: WebAuthConfig;
}): Promise<{
  readonly metadata: BetterAuthProviderMetadata;
  readonly source: "broker" | "fail_closed";
}> {
  const fallbackMetadata = createFailClosedBetterAuthMetadata({
    appBaseUrl: input.config.appBaseUrl,
    authBrokerBaseUrl: input.config.authBrokerBaseUrl,
  });

  try {
    const response = await fetch(
      `${input.config.authBrokerProxyBaseUrl}/v1/auth/providers`,
      {
        headers: {
          accept: "application/json",
        },
        cache: "no-store",
      }
    );
    if (!response.ok) {
      return {
        metadata: fallbackMetadata,
        source: "fail_closed",
      };
    }

    const payload = (await response.json()) as {
      readonly providers?: readonly BetterAuthProviderMetadata[];
    };
    const betterAuthProvider = payload.providers?.find(
      (provider) => provider.id === "better-auth"
    );
    if (!betterAuthProvider) {
      return {
        metadata: fallbackMetadata,
        source: "fail_closed",
      };
    }

    return {
      metadata: normalizeBrokerBetterAuthMetadata({
        metadata: betterAuthProvider,
      }),
      source: "broker",
    };
  } catch {
    return {
      metadata: fallbackMetadata,
      source: "fail_closed",
    };
  }
}

function resolveLocalDevHost(input: {
  readonly appBaseUrl: string;
}): string | undefined {
  const explicit = readFirstDefinedValue([
    process.env.HACK_LOCAL_DEV_HOST,
    process.env.NEXT_PUBLIC_HACK_LOCAL_DEV_HOST,
  ]);
  if (explicit) {
    return explicit;
  }
  try {
    const hostname = new URL(input.appBaseUrl).hostname;
    return hostname.endsWith(".hack") || hostname.endsWith(".hack.gy")
      ? hostname
      : undefined;
  } catch {
    return undefined;
  }
}

function createFailClosedBetterAuthMetadata(input: {
  readonly appBaseUrl: string;
  readonly authBrokerBaseUrl: string;
}): BetterAuthProviderMetadata {
  return {
    ...createBetterAuthProviderMetadata({
      enabled: false,
      contract: createSharedBetterAuthContract({
        socialProviders: [],
        authBaseUrl: input.authBrokerBaseUrl,
        publicBaseUrl: input.appBaseUrl,
      }),
    }),
    trustedOrigins: [],
  };
}

function normalizeBrokerBetterAuthMetadata(input: {
  readonly metadata: BetterAuthProviderMetadata;
}): BetterAuthProviderMetadata {
  return {
    ...input.metadata,
    socialProviders: input.metadata.enabled
      ? [...input.metadata.socialProviders]
      : [],
    accountLinkingPolicy: {
      ...input.metadata.accountLinkingPolicy,
      trustedProviders: [
        ...input.metadata.accountLinkingPolicy.trustedProviders,
      ],
    },
    trustedOrigins: [...input.metadata.trustedOrigins],
  };
}
