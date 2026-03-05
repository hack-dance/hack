import { describe, expect, test } from "bun:test";

import { resolveConfig } from "../src/config.ts";

type EnvMap = Record<string, string | undefined>;

const ENV_KEYS = [
  "AUTH_BROKER_PUBLIC_BASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_SCOPES",
  "HACK_LINEAR_CLIENT_ID",
  "HACK_LINEAR_SECRET",
  "HACK_LINEAR_DEVELOPER_APP_TOKEN",
  "HACK_LINEAR_OAUTH_ACTOR",
  "HACK_LINEAR_WEBHOOK_SECRET",
  "HACK_LINEAR_SCOPES",
  "HACK_LINEAR_REDIRECT_URI",
  "HACK_LINEAR_WEBHOOK_PATH",
  "LINEAR_OAUTH_ACTOR",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SIGNING_SECRET",
  "FLOW_STORE_PATH",
  "BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS",
] as const;

describe("auth broker config", () => {
  test("normalizes configured GitHub scopes", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        GITHUB_SCOPES: " read:user user:email,read:org,read:user ",
      },
      () => {
        const config = resolveConfig();
        expect(config.githubScopes).toBe("read:user,user:email,read:org");
      }
    );
  });

  test("applies default GitHub scopes when unset", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        GITHUB_SCOPES: undefined,
      },
      () => {
        const config = resolveConfig();
        expect(config.githubScopes).toBe("read:user,user:email,read:org");
      }
    );
  });

  test("parses Better Auth user auto-provision boolean", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS: "true",
      },
      () => {
        const config = resolveConfig();
        expect(config.betterAuthGitHubAutoProvisionUsers).toBe(true);
      }
    );
  });

  test("resolves linear aliases and defaults", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        HACK_LINEAR_CLIENT_ID: "hack-linear-client",
        HACK_LINEAR_SECRET: "hack-linear-secret",
        HACK_LINEAR_WEBHOOK_SECRET: "hook-secret",
        HACK_LINEAR_DEVELOPER_APP_TOKEN: "app-token",
        HACK_LINEAR_SCOPES:
          "read,write,app:mentionable,app:assignable,read,write",
      },
      () => {
        const config = resolveConfig();
        expect(config.linearClientId).toBe("hack-linear-client");
        expect(config.linearClientSecret).toBe("hack-linear-secret");
        expect(config.linearWebhookSigningSecret).toBe("hook-secret");
        expect(config.linearDeveloperAppToken).toBe("app-token");
        expect(config.linearScopes).toBe(
          "read,write,app:mentionable,app:assignable"
        );
        expect(config.linearActor).toBe("app");
        expect(config.linearRedirectUri).toBe(
          "http://127.0.0.1:8080/linear/callback"
        );
        expect(config.linearWebhookPath).toBe("/linear/webhooks");
      }
    );
  });

  test("uses legacy linear env aliases when hack aliases are absent", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        LINEAR_CLIENT_ID: "legacy-linear-client",
        LINEAR_CLIENT_SECRET: "legacy-linear-secret",
        LINEAR_WEBHOOK_SIGNING_SECRET: "legacy-webhook-secret",
      },
      () => {
        const config = resolveConfig();
        expect(config.linearClientId).toBe("legacy-linear-client");
        expect(config.linearClientSecret).toBe("legacy-linear-secret");
        expect(config.linearWebhookSigningSecret).toBe("legacy-webhook-secret");
      }
    );
  });

  test("normalizes configured linear oauth actor", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        HACK_LINEAR_OAUTH_ACTOR: " user ",
      },
      () => {
        const config = resolveConfig();
        expect(config.linearActor).toBe("user");
      }
    );
  });
});

function withEnv(overrides: EnvMap, run: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    setEnvKey({
      key,
      value,
    });
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      setEnvKey({
        key,
        value: snapshot.get(key),
      });
    }
  }
}

function setEnvKey(input: {
  readonly key: string;
  readonly value: string | undefined;
}): void {
  if (input.value === undefined) {
    delete process.env[input.key];
    return;
  }
  process.env[input.key] = input.value;
}
