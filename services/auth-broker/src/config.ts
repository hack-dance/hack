import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BrokerConfig = {
  readonly port: number;
  readonly host: string;
  readonly publicBaseUrl: string;
  readonly webAppBaseUrl?: string;
  readonly flowStorePath: string;
  readonly providerTokenEncryptionKey?: string;
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
  readonly betterAuthLinearAutoProvisionUsers: boolean;
  readonly linearClientId?: string;
  readonly linearClientSecret?: string;
  readonly linearDeveloperAppToken?: string;
  readonly linearActor: "user" | "app";
  readonly linearScopes: string;
  readonly linearAuthorizeUrl: string;
  readonly linearTokenUrl: string;
  readonly linearApiBaseUrl: string;
  readonly linearRedirectUri: string;
  readonly linearWebhookPath: string;
  readonly linearWebhookSigningSecret?: string;
  readonly flowTtlMs: number;
  readonly flowSweepIntervalMs: number;
};

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PUBLIC_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_FLOW_STORE_PATH = ".data/oauth-flows.json";
const DEFAULT_GITHUB_SCOPES = "read:user,user:email,read:org";
const DEFAULT_GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_LINEAR_SCOPES = "read,write,app:mentionable,app:assignable";
const DEFAULT_LINEAR_ACTOR = "app";
const DEFAULT_LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const DEFAULT_LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_LINEAR_API_BASE_URL = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_WEBHOOK_PATH = "/linear/webhooks";
const DEFAULT_FLOW_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FLOW_SWEEP_INTERVAL_MS = 30 * 1000;
const TRAILING_SLASH_PATTERN = /\/$/;
const TRAILING_PATH_SLASHES_PATTERN = /\/+$/;
const GITHUB_SCOPE_SPLIT_PATTERN = /[,\s]+/;
const NEWLINE_SPLIT_PATTERN = /\r?\n/;
const ROOT_ENV_FALLBACK_DISABLED_ENV =
  "HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK";
const ROOT_ENV_FALLBACK_FILES = [
  resolve(import.meta.dir, "../../..", ".env.local"),
  resolve(import.meta.dir, "../../..", ".env"),
] as const;
let cachedRootEnvFallback: Map<string, string> | null = null;
let rootEnvFallbackOverride: Map<string, string> | undefined;

/**
 * Test hook for supplying deterministic repo-root dotenv fallback contents.
 */
export function configureRootEnvFallbackForTests(input?: {
  readonly values?: Readonly<Record<string, string | undefined>>;
}): void {
  cachedRootEnvFallback = null;
  if (!input?.values) {
    rootEnvFallbackOverride = undefined;
    return;
  }
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(input.values)) {
    if (value === undefined) {
      continue;
    }
    values.set(key, value);
  }
  rootEnvFallbackOverride = values;
}

/**
 * Resolve auth broker runtime config from environment variables.
 */
export function resolveConfig(): BrokerConfig {
  const publicBaseUrl =
    normalizeUrl(process.env.AUTH_BROKER_PUBLIC_BASE_URL) ??
    DEFAULT_PUBLIC_BASE_URL;
  const github = resolveGitHubConfig({
    publicBaseUrl,
  });
  const linear = resolveLinearConfig({
    publicBaseUrl,
  });

  return {
    port: parsePort(process.env.PORT) ?? DEFAULT_PORT,
    host: normalizeString(process.env.HOST) ?? DEFAULT_HOST,
    publicBaseUrl,
    webAppBaseUrl:
      normalizeUrl(process.env.HACK_WEB_APP_BASE_URL) ?? publicBaseUrl,
    flowStorePath:
      normalizeString(process.env.FLOW_STORE_PATH) ?? DEFAULT_FLOW_STORE_PATH,
    providerTokenEncryptionKey:
      normalizeString(
        readFirstEnv([
          "HACK_PROVIDER_TOKEN_ENCRYPTION_KEY",
          "PROVIDER_TOKEN_ENCRYPTION_KEY",
        ])
      ) ?? undefined,
    ...github,
    betterAuthGitHubAutoProvisionUsers:
      parseBoolean(process.env.BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS) ??
      false,
    betterAuthLinearAutoProvisionUsers:
      parseBoolean(process.env.BETTER_AUTH_LINEAR_AUTO_PROVISION_USERS) ??
      false,
    ...linear,
    flowTtlMs: parsePositiveInt(process.env.FLOW_TTL_MS) ?? DEFAULT_FLOW_TTL_MS,
    flowSweepIntervalMs:
      parsePositiveInt(process.env.FLOW_SWEEP_INTERVAL_MS) ??
      DEFAULT_FLOW_SWEEP_INTERVAL_MS,
  };
}

export function buildBrokerOAuthCallbackUrl(input: {
  readonly publicBaseUrl: string;
  readonly callbackPath: `/${string}`;
}): string {
  return new URL(
    input.callbackPath.slice(1),
    ensureTrailingSlash(input.publicBaseUrl)
  )
    .toString()
    .replace(TRAILING_SLASH_PATTERN, "");
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

function resolveGitHubConfig(input: {
  readonly publicBaseUrl: string;
}): Pick<
  BrokerConfig,
  | "githubClientId"
  | "githubClientSecret"
  | "githubAppId"
  | "githubAppSlug"
  | "githubAppInstallUrl"
  | "githubScopes"
  | "githubAuthorizeUrl"
  | "githubTokenUrl"
  | "githubApiBaseUrl"
  | "githubRedirectUri"
> {
  const githubClientId = normalizeRequiredEnv("GITHUB_CLIENT_ID");
  const githubClientSecret = normalizeRequiredEnv("GITHUB_CLIENT_SECRET");
  const githubAppSlug =
    normalizeString(process.env.GITHUB_APP_SLUG) ?? undefined;
  const githubAppInstallUrl =
    normalizeUrl(process.env.GITHUB_APP_INSTALL_URL) ??
    (githubAppSlug
      ? `https://github.com/apps/${encodeURIComponent(githubAppSlug)}/installations/new`
      : undefined);
  return {
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
    // This callback belongs to the broker's custom GitHub OAuth flow
    // (`/gh/callback`). Better Auth browser social login uses the Better Auth
    // base URL plus `/api/auth/callback/github`.
    githubRedirectUri:
      normalizeUrl(process.env.GITHUB_REDIRECT_URI) ??
      buildBrokerOAuthCallbackUrl({
        publicBaseUrl: input.publicBaseUrl,
        callbackPath: "/gh/callback",
      }),
  };
}

function resolveLinearConfig(input: {
  readonly publicBaseUrl: string;
}): Pick<
  BrokerConfig,
  | "linearClientId"
  | "linearClientSecret"
  | "linearDeveloperAppToken"
  | "linearActor"
  | "linearScopes"
  | "linearAuthorizeUrl"
  | "linearTokenUrl"
  | "linearApiBaseUrl"
  | "linearRedirectUri"
  | "linearWebhookPath"
  | "linearWebhookSigningSecret"
> {
  const linearClientId = normalizeString(
    readFirstEnv(["HACK_LINEAR_CLIENT_ID", "LINEAR_CLIENT_ID"])
  );
  const linearClientSecret = normalizeString(
    readFirstEnv(["HACK_LINEAR_SECRET", "LINEAR_CLIENT_SECRET"])
  );
  const linearDeveloperAppToken = normalizeString(
    readFirstEnv([
      "HACK_LINEAR_DEVELOPER_APP_TOKEN",
      "LINEAR_DEVELOPER_APP_TOKEN",
    ])
  );
  return {
    linearClientId: linearClientId ?? undefined,
    linearClientSecret: linearClientSecret ?? undefined,
    linearDeveloperAppToken: linearDeveloperAppToken ?? undefined,
    linearActor:
      normalizeLinearActor(
        readFirstEnv(["HACK_LINEAR_OAUTH_ACTOR", "LINEAR_OAUTH_ACTOR"])
      ) ?? DEFAULT_LINEAR_ACTOR,
    linearScopes:
      normalizeOAuthScopes({
        value: readFirstEnv(["HACK_LINEAR_SCOPES", "LINEAR_SCOPES"]),
      }) ?? DEFAULT_LINEAR_SCOPES,
    linearAuthorizeUrl:
      normalizeUrl(
        readFirstEnv(["HACK_LINEAR_AUTHORIZE_URL", "LINEAR_AUTHORIZE_URL"])
      ) ?? DEFAULT_LINEAR_AUTHORIZE_URL,
    linearTokenUrl:
      normalizeUrl(
        readFirstEnv(["HACK_LINEAR_TOKEN_URL", "LINEAR_TOKEN_URL"])
      ) ?? DEFAULT_LINEAR_TOKEN_URL,
    linearApiBaseUrl:
      normalizeLinearApiBaseUrl(
        readFirstEnv(["HACK_LINEAR_API_BASE_URL", "LINEAR_API_BASE_URL"])
      ) ?? DEFAULT_LINEAR_API_BASE_URL,
    linearRedirectUri:
      normalizeUrl(
        readFirstEnv(["HACK_LINEAR_REDIRECT_URI", "LINEAR_REDIRECT_URI"])
      ) ??
      buildBrokerOAuthCallbackUrl({
        publicBaseUrl: input.publicBaseUrl,
        callbackPath: "/linear/callback",
      }),
    linearWebhookPath:
      normalizePath(
        readFirstEnv(["HACK_LINEAR_WEBHOOK_PATH", "LINEAR_WEBHOOK_PATH"])
      ) ?? DEFAULT_LINEAR_WEBHOOK_PATH,
    linearWebhookSigningSecret:
      normalizeString(
        readFirstEnv([
          "HACK_LINEAR_WEBHOOK_SECRET",
          "LINEAR_WEBHOOK_SIGNING_SECRET",
        ])
      ) ?? undefined,
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeLinearActor(
  value: string | undefined
): "user" | "app" | null {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "user" || normalized === "app") {
    return normalized;
  }
  return null;
}

function normalizeLinearApiBaseUrl(value: string | undefined): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }
  const url = new URL(normalized);
  const pathname = url.pathname.replace(TRAILING_PATH_SLASHES_PATTERN, "");
  url.pathname = pathname.length === 0 ? "/graphql" : pathname;
  return url.toString();
}

function normalizeGitHubScopes(value: string | undefined): string | null {
  return normalizeOAuthScopes({ value });
}

function normalizeOAuthScopes(input: {
  readonly value: string | undefined;
}): string | null {
  const normalized = normalizeString(input.value);
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

function normalizePath(value: string | undefined): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const withLeadingSlash = normalized.startsWith("/")
    ? normalized
    : `/${normalized}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) {
    return withLeadingSlash.slice(0, -1);
  }
  return withLeadingSlash;
}

function readFirstEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) {
      return value;
    }
  }
  if (parseBoolean(process.env[ROOT_ENV_FALLBACK_DISABLED_ENV]) === true) {
    return undefined;
  }
  const fallback = resolveRootEnvFallback();
  for (const key of keys) {
    const value = fallback.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function resolveRootEnvFallback(): Map<string, string> {
  if (rootEnvFallbackOverride) {
    return rootEnvFallbackOverride;
  }
  if (cachedRootEnvFallback) {
    return cachedRootEnvFallback;
  }
  const values = new Map<string, string>();
  for (const filePath of ROOT_ENV_FALLBACK_FILES) {
    const parsed = parseDotenvFile({ filePath });
    for (const [key, value] of parsed.entries()) {
      if (!values.has(key)) {
        values.set(key, value);
      }
    }
  }
  cachedRootEnvFallback = values;
  return values;
}

function parseDotenvFile(input: {
  readonly filePath: string;
}): Map<string, string> {
  let raw = "";
  try {
    raw = readFileSync(input.filePath, "utf8");
  } catch {
    return new Map();
  }
  const values = new Map<string, string>();
  const lines = raw.split(NEWLINE_SPLIT_PATTERN);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!(trimmed && !trimmed.startsWith("#"))) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!key) {
      continue;
    }
    const rawValue = trimmed.slice(eq + 1);
    const value = normalizeDotenvValue({ value: rawValue });
    values.set(key, value);
  }
  return values;
}

function normalizeDotenvValue(input: { readonly value: string }): string {
  const raw = input.value.trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}
