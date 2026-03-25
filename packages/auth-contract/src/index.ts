export type BetterAuthSocialProviderId = "github" | "google";

export type BetterAuthSocialProvider = {
  readonly id: BetterAuthSocialProviderId;
  readonly label: string;
};

export type BetterAuthAccountLinkingPolicy = {
  readonly requireVerifiedEmail: boolean;
  readonly allowDifferentEmails: boolean;
  readonly trustedProviders: readonly string[];
};

export type BetterAuthPublicPaths = {
  readonly basePath: string;
  readonly shellPath: string;
  readonly accountPath: string;
  readonly sessionStartPath: string;
  readonly mePath: string;
};

export type BetterAuthProviderMetadata = {
  readonly id: "better-auth";
  readonly enabled: boolean;
  readonly mode: "session";
  readonly basePath: string;
  readonly shellPath: string;
  readonly accountPath: string;
  readonly sessionStartPath: string;
  readonly mePath: string;
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly accountLinkingPolicy: BetterAuthAccountLinkingPolicy;
  readonly trustedOrigins: readonly string[];
};

export type BetterAuthSocialProviderOptions = {
  readonly github?: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly google?: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
};

export type SharedBetterAuthContract = {
  readonly paths: BetterAuthPublicPaths;
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly accountLinkingPolicy: BetterAuthAccountLinkingPolicy;
  readonly trustedOrigins: readonly string[];
};

export type BetterAuthSocialProviderConfigInput = {
  readonly betterAuthGitHubClientId?: string;
  readonly betterAuthGitHubClientSecret?: string;
  readonly githubClientId?: string;
  readonly githubClientSecret?: string;
  readonly betterAuthGoogleClientId?: string;
  readonly betterAuthGoogleClientSecret?: string;
  readonly googleClientId?: string;
  readonly googleClientSecret?: string;
};

export type CreateSharedBetterAuthContractInput = {
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly trustedOrigins?: string | readonly string[];
  readonly authBaseUrl?: string;
  readonly publicBaseUrl?: string;
  readonly localDevHost?: string;
};

export type CreateWebAuthStartupConfigInput = {
  readonly authBrokerBaseUrl: string;
  readonly contract: SharedBetterAuthContract;
  readonly enabled?: boolean;
};

export type WebAuthStartupConfig = {
  readonly authBrokerBaseUrl: string;
  readonly betterAuth: BetterAuthProviderMetadata;
};

const PROVIDER_LABELS = {
  github: "GitHub",
  google: "Google",
} as const satisfies Record<BetterAuthSocialProviderId, string>;

const WILDCARD_PATTERN = /[*?]/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const RELATIVE_PATH_PATTERN =
  /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/i;

export const SHARED_BETTER_AUTH_PATHS = {
  basePath: "/api/auth",
  shellPath: "/auth",
  accountPath: "/auth/account",
  sessionStartPath: "/v1/auth/session/start",
  mePath: "/v1/auth/me",
} as const satisfies BetterAuthPublicPaths;

export const HACK_WEB_BROKER_SESSION_COOKIE_NAME = "hack_web_broker_session";

export const DEFAULT_BETTER_AUTH_ACCOUNT_LINKING_POLICY = {
  requireVerifiedEmail: true,
  allowDifferentEmails: false,
  trustedProviders: [],
} as const satisfies BetterAuthAccountLinkingPolicy;

export function resolveBetterAuthSocialProviderOptions(
  input: BetterAuthSocialProviderConfigInput
): BetterAuthSocialProviderOptions | null {
  const github = resolveProviderCredentials({
    preferredClientId: input.betterAuthGitHubClientId,
    preferredClientSecret: input.betterAuthGitHubClientSecret,
    fallbackClientId: input.githubClientId,
    fallbackClientSecret: input.githubClientSecret,
  });
  const google = resolveProviderCredentials({
    preferredClientId: input.betterAuthGoogleClientId,
    preferredClientSecret: input.betterAuthGoogleClientSecret,
    fallbackClientId: input.googleClientId,
    fallbackClientSecret: input.googleClientSecret,
  });

  const options = {
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
  } satisfies BetterAuthSocialProviderOptions;

  return Object.keys(options).length > 0 ? options : null;
}

export function resolveBetterAuthSocialProviders(
  input: BetterAuthSocialProviderConfigInput
): readonly BetterAuthSocialProvider[] {
  const options = resolveBetterAuthSocialProviderOptions(input);
  return [
    ...(options?.github
      ? [
          {
            id: "github",
            label: PROVIDER_LABELS.github,
          } as const,
        ]
      : []),
    ...(options?.google
      ? [
          {
            id: "google",
            label: PROVIDER_LABELS.google,
          } as const,
        ]
      : []),
  ];
}

export function createSharedBetterAuthContract(
  input: CreateSharedBetterAuthContractInput
): SharedBetterAuthContract {
  return {
    paths: SHARED_BETTER_AUTH_PATHS,
    socialProviders: [...input.socialProviders],
    accountLinkingPolicy: DEFAULT_BETTER_AUTH_ACCOUNT_LINKING_POLICY,
    trustedOrigins: resolveTrustedAuthOrigins({
      authBaseUrl: input.authBaseUrl,
      localDevHost: input.localDevHost,
      publicBaseUrl: input.publicBaseUrl,
      trustedOrigins: input.trustedOrigins,
    }),
  };
}

export function createBetterAuthProviderMetadata(input: {
  readonly enabled: boolean;
  readonly contract: SharedBetterAuthContract;
}): BetterAuthProviderMetadata {
  return {
    id: "better-auth",
    enabled: input.enabled,
    mode: "session",
    basePath: input.contract.paths.basePath,
    shellPath: input.contract.paths.shellPath,
    accountPath: input.contract.paths.accountPath,
    sessionStartPath: input.contract.paths.sessionStartPath,
    mePath: input.contract.paths.mePath,
    socialProviders: [...input.contract.socialProviders],
    accountLinkingPolicy: input.contract.accountLinkingPolicy,
    trustedOrigins: [...input.contract.trustedOrigins],
  };
}

export function createWebAuthStartupConfig(
  input: CreateWebAuthStartupConfigInput
): WebAuthStartupConfig {
  return {
    authBrokerBaseUrl:
      normalizeAbsoluteUrl(input.authBrokerBaseUrl) ?? input.authBrokerBaseUrl,
    betterAuth: createBetterAuthProviderMetadata({
      enabled: input.enabled ?? true,
      contract: input.contract,
    }),
  };
}

export function resolveTrustedAuthOrigins(input: {
  readonly authBaseUrl?: string;
  readonly publicBaseUrl?: string;
  readonly localDevHost?: string;
  readonly trustedOrigins?: string | readonly string[];
}): readonly string[] {
  const values = [
    normalizeAbsoluteUrl(input.authBaseUrl),
    normalizeAbsoluteUrl(input.publicBaseUrl),
    ...resolveLocalHackOriginPatterns({
      localDevHost: input.localDevHost,
    }),
    ...resolveConfiguredTrustedOrigins({
      trustedOrigins: input.trustedOrigins,
    }),
  ].filter((value): value is string => typeof value === "string");

  return [...new Set(values)];
}

export function isTrustedAuthOrigin(input: {
  readonly origin: string;
  readonly trustedOrigins: readonly string[];
}): boolean {
  return input.trustedOrigins.some((pattern) =>
    matchesOriginPattern({
      pattern,
      value: input.origin,
    })
  );
}

export function matchesOriginPattern(input: {
  readonly value: string;
  readonly pattern: string;
  readonly allowRelativePaths?: boolean;
}): boolean {
  if (input.value.startsWith("/")) {
    return input.allowRelativePaths
      ? RELATIVE_PATH_PATTERN.test(input.value)
      : false;
  }

  const hasWildcard = WILDCARD_PATTERN.test(input.pattern);
  if (hasWildcard) {
    if (input.pattern.includes("://")) {
      const candidateOrigin = getOrigin({
        value: input.value,
      });
      return wildcardMatch({
        pattern: input.pattern,
        value: candidateOrigin ?? input.value,
      });
    }

    const candidateHost = getHost({
      value: input.value,
    });
    return candidateHost
      ? wildcardMatch({
          pattern: input.pattern,
          value: candidateHost,
        })
      : false;
  }

  const protocol = getProtocol({
    value: input.value,
  });
  return protocol === "http:" || protocol === "https:" || !protocol
    ? input.pattern === getOrigin({ value: input.value })
    : input.value.startsWith(input.pattern);
}

function resolveProviderCredentials(input: {
  readonly preferredClientId?: string;
  readonly preferredClientSecret?: string;
  readonly fallbackClientId?: string;
  readonly fallbackClientSecret?: string;
}): {
  readonly clientId: string;
  readonly clientSecret: string;
} | null {
  const clientId =
    normalizeText(input.preferredClientId) ??
    normalizeText(input.fallbackClientId);
  const clientSecret =
    normalizeText(input.preferredClientSecret) ??
    normalizeText(input.fallbackClientSecret);
  return clientId && clientSecret
    ? {
        clientId,
        clientSecret,
      }
    : null;
}

function resolveConfiguredTrustedOrigins(input: {
  readonly trustedOrigins?: string | readonly string[];
}): string[] {
  const entries =
    typeof input.trustedOrigins === "string"
      ? input.trustedOrigins.split(",")
      : [...(input.trustedOrigins ?? [])];

  return entries
    .map((value) => normalizeTrustedOriginPattern({ value }))
    .filter((value): value is string => typeof value === "string");
}

function resolveLocalHackOriginPatterns(input: {
  readonly localDevHost?: string;
}): string[] {
  const host = normalizeHost({
    value: input.localDevHost,
  });
  if (!host) {
    return [];
  }

  const patterns = [`https://${host}`, `https://*.${host}`];
  if (host.endsWith(".hack")) {
    const aliasHost = `${host}.gy`;
    patterns.push(`https://${aliasHost}`, `https://*.${aliasHost}`);
  }
  return patterns;
}

function normalizeTrustedOriginPattern(input: {
  readonly value: string;
}): string | null {
  const value = normalizeText(input.value);
  if (!value) {
    return null;
  }
  if (WILDCARD_PATTERN.test(value)) {
    return value.replace(TRAILING_SLASHES_PATTERN, "");
  }
  return (
    normalizeAbsoluteUrl(value) ?? value.replace(TRAILING_SLASHES_PATTERN, "")
  );
}

function normalizeAbsoluteUrl(value: string | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

function normalizeHost(input: { readonly value?: string }): string | null {
  const normalized = normalizeText(input.value);
  if (!normalized) {
    return null;
  }
  if (normalized.includes("://")) {
    try {
      return new URL(normalized).host;
    } catch {
      return null;
    }
  }
  return normalized.replace(TRAILING_SLASHES_PATTERN, "");
}

function normalizeText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function wildcardMatch(input: {
  readonly pattern: string;
  readonly value: string;
}): boolean {
  return buildWildcardExpression({
    pattern: input.pattern,
  }).test(input.value);
}

function buildWildcardExpression(input: { readonly pattern: string }): RegExp {
  let pattern = "^";
  for (const character of input.pattern) {
    if (character === "*") {
      pattern += ".*";
      continue;
    }
    if (character === "?") {
      pattern += ".";
      continue;
    }
    pattern += escapeRegularExpressionCharacter({
      value: character,
    });
  }
  pattern += "$";
  return new RegExp(pattern);
}

function escapeRegularExpressionCharacter(input: {
  readonly value: string;
}): string {
  return input.value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function getOrigin(input: { readonly value: string }): string | null {
  try {
    return new URL(input.value).origin;
  } catch {
    return null;
  }
}

function getHost(input: { readonly value: string }): string | null {
  try {
    return new URL(input.value).host;
  } catch {
    return null;
  }
}

function getProtocol(input: { readonly value: string }): string | null {
  try {
    return new URL(input.value).protocol;
  } catch {
    return null;
  }
}
