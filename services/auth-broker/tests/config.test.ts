import { describe, expect, test } from "bun:test";

import { resolveConfig } from "@/config.ts";
import {
  installAuthBrokerEnvIsolation,
  withIsolatedAuthBrokerEnv,
} from "./test-env.ts";

installAuthBrokerEnvIsolation();

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

  test("parses Better Auth Linear auto-provision boolean", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        BETTER_AUTH_LINEAR_AUTO_PROVISION_USERS: "true",
      },
      () => {
        const config = resolveConfig();
        expect(config.betterAuthLinearAutoProvisionUsers).toBe(true);
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

  test("defaults Linear API base URL to the GraphQL endpoint", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
      },
      () => {
        const config = resolveConfig();
        expect(config.linearApiBaseUrl).toBe("https://api.linear.app/graphql");
      }
    );
  });

  test("normalizes configured Linear API base URL to the GraphQL endpoint", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        HACK_LINEAR_API_BASE_URL: "https://api.linear.app",
      },
      () => {
        const config = resolveConfig();
        expect(config.linearApiBaseUrl).toBe("https://api.linear.app/graphql");
      }
    );
  });

  test("ignores ambient repo env while resolving defaults", () => {
    const previousRedirectUri = process.env.HACK_LINEAR_REDIRECT_URI;
    const previousLegacyClientId = process.env.LINEAR_CLIENT_ID;
    process.env.HACK_LINEAR_REDIRECT_URI =
      "https://auth.hack.broker/linear/callback";
    process.env.LINEAR_CLIENT_ID = "ambient-linear-client";

    try {
      withEnv(
        {
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          HACK_LINEAR_CLIENT_ID: "isolated-linear-client",
          HACK_LINEAR_SECRET: "isolated-linear-secret",
        },
        () => {
          const config = resolveConfig();
          expect(config.linearClientId).toBe("isolated-linear-client");
          expect(config.linearRedirectUri).toBe(
            "http://127.0.0.1:8080/linear/callback"
          );
        }
      );
    } finally {
      if (previousRedirectUri === undefined) {
        process.env.HACK_LINEAR_REDIRECT_URI = undefined;
      } else {
        process.env.HACK_LINEAR_REDIRECT_URI = previousRedirectUri;
      }
      if (previousLegacyClientId === undefined) {
        process.env.LINEAR_CLIENT_ID = undefined;
      } else {
        process.env.LINEAR_CLIENT_ID = previousLegacyClientId;
      }
    }
  });
});

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void
): void {
  withIsolatedAuthBrokerEnv(overrides, run);
}
