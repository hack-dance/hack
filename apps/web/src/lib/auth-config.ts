import {
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
