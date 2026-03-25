import { afterEach, beforeEach } from "bun:test";

import { configureRootEnvFallbackForTests } from "@/config.ts";

type EnvMap = Record<string, string | undefined>;

const AUTH_BROKER_ENV_KEYS = [
  "AUTH_BROKER_PUBLIC_BASE_URL",
  "PORT",
  "HOST",
  "FLOW_STORE_PATH",
  "FLOW_TTL_MS",
  "FLOW_SWEEP_INTERVAL_MS",
  "DATABASE_URL",
  "HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK",
  "HACK_PROVIDER_TOKEN_ENCRYPTION_KEY",
  "PROVIDER_TOKEN_ENCRYPTION_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_SCOPES",
  "GITHUB_AUTHORIZE_URL",
  "GITHUB_TOKEN_URL",
  "GITHUB_API_BASE_URL",
  "GITHUB_REDIRECT_URI",
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_INSTALL_URL",
  "HACK_LINEAR_CLIENT_ID",
  "HACK_LINEAR_SECRET",
  "HACK_LINEAR_DEVELOPER_APP_TOKEN",
  "HACK_LINEAR_OAUTH_ACTOR",
  "HACK_LINEAR_WEBHOOK_SECRET",
  "HACK_LINEAR_SCOPES",
  "HACK_LINEAR_REDIRECT_URI",
  "HACK_LINEAR_WEBHOOK_PATH",
  "HACK_LINEAR_AUTHORIZE_URL",
  "HACK_LINEAR_TOKEN_URL",
  "HACK_LINEAR_API_BASE_URL",
  "LINEAR_OAUTH_ACTOR",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_DEVELOPER_APP_TOKEN",
  "LINEAR_WEBHOOK_SIGNING_SECRET",
  "LINEAR_SCOPES",
  "LINEAR_REDIRECT_URI",
  "LINEAR_WEBHOOK_PATH",
  "LINEAR_AUTHORIZE_URL",
  "LINEAR_TOKEN_URL",
  "LINEAR_API_BASE_URL",
  "BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS",
  "BETTER_AUTH_LINEAR_AUTO_PROVISION_USERS",
  "BETTER_AUTH_SECRET",
  "AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_GITHUB_CLIENT_ID",
  "BETTER_AUTH_GITHUB_CLIENT_SECRET",
  "BETTER_AUTH_GOOGLE_CLIENT_ID",
  "BETTER_AUTH_GOOGLE_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

function snapshotAuthBrokerEnv(): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of AUTH_BROKER_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  return snapshot;
}

function restoreAuthBrokerEnv(snapshot: Map<string, string | undefined>): void {
  for (const key of AUTH_BROKER_ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function clearAuthBrokerEnv(): void {
  for (const key of AUTH_BROKER_ENV_KEYS) {
    delete process.env[key];
  }
}

function applyEnv(overrides: EnvMap): void {
  clearAuthBrokerEnv();
  process.env.HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK = "true";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

/**
 * Reset auth-broker-relevant env before each test so Bun-loaded repo env does not leak into test expectations.
 */
export function installAuthBrokerEnvIsolation(): void {
  let snapshot = new Map<string, string | undefined>();

  beforeEach(() => {
    snapshot = snapshotAuthBrokerEnv();
    clearAuthBrokerEnv();
    process.env.HACK_AUTH_BROKER_DISABLE_ROOT_ENV_FALLBACK = "true";
    configureRootEnvFallbackForTests();
  });

  afterEach(() => {
    configureRootEnvFallbackForTests();
    restoreAuthBrokerEnv(snapshot);
  });
}

/**
 * Run a sync block with only the provided auth-broker env overrides applied.
 */
export function withIsolatedAuthBrokerEnv(
  overrides: EnvMap,
  run: () => void
): void {
  const snapshot = snapshotAuthBrokerEnv();
  applyEnv(overrides);
  try {
    run();
  } finally {
    restoreAuthBrokerEnv(snapshot);
  }
}

/**
 * Run a sync block with deterministic repo-root dotenv fallback contents.
 */
export function withAuthBrokerRootEnvFallback(input: {
  readonly values: EnvMap;
  readonly run: () => void;
}): void {
  configureRootEnvFallbackForTests({
    values: input.values,
  });
  try {
    input.run();
  } finally {
    configureRootEnvFallbackForTests();
  }
}
