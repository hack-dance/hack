export type BrokerConfig = {
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly githubClientId: string;
  readonly githubClientSecret: string;
  readonly githubAppId?: string;
  readonly githubAppSlug?: string;
  readonly githubAppInstallUrl?: string;
  readonly githubScopes: string;
  readonly githubAuthorizeUrl: string;
  readonly githubTokenUrl: string;
  readonly githubApiBaseUrl: string;
  readonly githubRedirectUri: string;
  readonly betterAuthGitHubAutoProvisionUsers: boolean;
  readonly flowTtlMs: number;
  readonly flowSweepIntervalMs: number;
};

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PUBLIC_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_GITHUB_SCOPES = "read:user,user:email,read:org";
const DEFAULT_GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FLOW_SWEEP_INTERVAL_MS = 30 * 1000;
const TRAILING_SLASH_PATTERN = /\/$/;
const GITHUB_SCOPE_SPLIT_PATTERN = /[,\s]+/;

/**
 * Resolve auth broker runtime config from environment variables.
 */
export function resolveConfig(): BrokerConfig {
  const publicBaseUrl =
    normalizeUrl(process.env.AUTH_BROKER_PUBLIC_BASE_URL) ??
    DEFAULT_PUBLIC_BASE_URL;
  const githubClientId = normalizeRequiredEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = normalizeRequiredEnv("GITHUB_CLIENT_SECRET");
  const githubRedirectUri =
    normalizeUrl(process.env.GITHUB_REDIRECT_URI) ??
    `${publicBaseUrl}/gh/callback`;
  const githubAppSlug =
    normalizeString(process.env.GITHUB_APP_SLUG) ?? undefined;
  const githubAppInstallUrl =
    normalizeUrl(process.env.GITHUB_APP_INSTALL_URL) ??
    (githubAppSlug
      ? `https://github.com/apps/${encodeURIComponent(githubAppSlug)}/installations/new`
      : undefined);

  return {
    port: parsePort(process.env.PORT) ?? DEFAULT_PORT,
    host: normalizeString(process.env.HOST) ?? DEFAULT_HOST,
    publicBaseUrl,
    githubClientId,
    githubClientSecret,
    githubAppId: normalizeString(process.env.GITHUB_APP_ID) ?? undefined,
    githubAppSlug,
    githubAppInstallUrl,
    githubScopes:
      normalizeGitHubScopes(process.env.GITHUB_SCOPES) ?? DEFAULT_GITHUB_SCOPES,
    githubAuthorizeUrl:
      normalizeUrl(process.env.GITHUB_AUTHORIZE_URL) ??
      DEFAULT_GITHUB_AUTHORIZE_URL,
    githubTokenUrl:
      normalizeUrl(process.env.GITHUB_TOKEN_URL) ?? DEFAULT_GITHUB_TOKEN_URL,
    githubApiBaseUrl:
      normalizeUrl(process.env.GITHUB_API_BASE_URL) ??
      DEFAULT_GITHUB_API_BASE_URL,
    githubRedirectUri,
    betterAuthGitHubAutoProvisionUsers:
      parseBoolean(process.env.BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS) ??
      false,
    flowTtlMs: parsePositiveInt(process.env.FLOW_TTL_MS) ?? DEFAULT_FLOW_TTL_MS,
    flowSweepIntervalMs:
      parsePositiveInt(process.env.FLOW_SWEEP_INTERVAL_MS) ??
      DEFAULT_FLOW_SWEEP_INTERVAL_MS,
  };
}

function normalizeRequiredEnv(key: string): string {
  const value = normalizeString(process.env[key]);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function normalizeString(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePort(value: string | undefined): number | null {
  const parsed = parsePositiveInt(value);
  if (!parsed) {
    return null;
  }
  if (parsed > 65_535) {
    return null;
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") {
    return false;
  }
  return null;
}

function normalizeGitHubScopes(value: string | undefined): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const token of normalized.split(GITHUB_SCOPE_SPLIT_PATTERN)) {
    const scope = token.trim();
    if (!scope || seen.has(scope)) {
      continue;
    }
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes.length > 0 ? scopes.join(",") : null;
}

function normalizeUrl(value: string | undefined): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    const normalizedPath =
      url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;
    url.pathname = normalizedPath;
    return url.toString().replace(TRAILING_SLASH_PATTERN, "");
  } catch {
    return null;
  }
}
