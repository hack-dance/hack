import { describe, expect, test } from "bun:test";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import type { BrokerConfig } from "../src/config.ts";
import { FlowStore } from "../src/flow-store.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { seedLinearLocalAccess } from "../src/modules/linear-connections/local-access.ts";
import {
  InMemoryLinearConnectionStore,
  type LinearConnectionStore,
} from "../src/modules/linear-connections/service.ts";
import {
  createFlow,
  handleLinearCallback,
} from "../src/modules/linear-oauth/service.ts";

type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;

function createTestConfig(): BrokerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:8080",
    flowStorePath: ".data/test-oauth-flows.json",
    providerTokenEncryptionKey: "linear-token-custody-test-key",
    githubClientId: "test-client-id",
    githubClientSecret: "test-client-secret",
    githubScopes: "repo,read:org",
    githubAuthorizeUrl: "https://github.com/login/oauth/authorize",
    githubTokenUrl: "https://github.com/login/oauth/access_token",
    githubApiBaseUrl: "https://api.github.com",
    githubRedirectUri: "http://127.0.0.1:8080/gh/callback",
    betterAuthGitHubAutoProvisionUsers: false,
    betterAuthLinearAutoProvisionUsers: false,
    linearClientId: "linear-client-id",
    linearClientSecret: "linear-client-secret",
    linearDeveloperAppToken: undefined,
    linearActor: "app",
    linearScopes: "read,write,app:mentionable,app:assignable",
    linearAuthorizeUrl: "https://linear.app/oauth/authorize",
    linearTokenUrl: "https://api.linear.app/oauth/token",
    linearApiBaseUrl: "https://api.linear.app/graphql",
    linearRedirectUri: "http://127.0.0.1:8080/linear/callback",
    linearWebhookPath: "/linear/webhooks",
    linearWebhookSigningSecret: undefined,
    flowTtlMs: 60_000,
    flowSweepIntervalMs: 60_000,
  };
}

function createBetterAuthRuntimeWithSession(
  session: BetterAuthSession
): BetterAuthRuntime {
  return {
    enabled: true,
    socialProviders: [{ id: "github", label: "GitHub" }],
    accountLinkingPolicy: {
      requireVerifiedEmail: true,
      allowDifferentEmails: false,
      trustedProviders: [],
    },
    auth: {
      api: {
        getSession: async () => session,
      },
    } as unknown as BetterAuthAuth["api"],
  } as unknown as BetterAuthRuntime;
}

function makeSession(): BetterAuthSession {
  return {
    user: {
      id: "user-123",
      email: "hack@example.com",
      emailVerified: true,
      name: "Hack User",
    },
    session: {
      id: "sess-123",
      userId: "user-123",
      token: "session-token",
      activeOrganizationId: "org-123",
      activeTeamId: "team-123",
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  } as unknown as BetterAuthSession;
}

function extractFlowState(authorizeUrl: string): string {
  const state = new URL(authorizeUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Missing flow state.");
  }
  return state;
}

describe("linear token custody", () => {
  test("callback persists broker-held local access that can be reseeded later", async () => {
    const config = createTestConfig();
    const flowStore = new FlowStore();
    const connectionStore = new InMemoryLinearConnectionStore();
    const betterAuthRuntime = createBetterAuthRuntimeWithSession(makeSession());
    const flow = createFlow({
      config,
      flowStore,
      query: {
        profile: "default",
        setDefault: "1",
        desktopRedirectUrl: "hack-dev://auth/linear/callback",
      },
      requestedBy: {
        betterAuthUserId: "user-123",
        betterAuthOrganizationId: "org-123",
        betterAuthTeamId: "team-123",
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === config.linearTokenUrl) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "lin_access_token",
              expires_in: 3600,
              refresh_token: "lin_refresh_token",
              refresh_token_expires_in: 7200,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        );
      }
      if (url === config.linearApiBaseUrl) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: "lin-user-1",
                  name: "Hack User",
                  displayName: "Hack User",
                  email: "hack@example.com",
                  organization: {
                    id: "lin-org-1",
                    name: "Hack Org",
                  },
                  teams: {
                    nodes: [{ id: "team-123", name: "Team" }],
                  },
                },
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    try {
      const response = await handleLinearCallback({
        config,
        flowStore,
        connectionStore,
        betterAuthRuntime,
        request: new Request("http://localhost/linear/callback"),
        query: {
          code: "linear-code",
          state: extractFlowState(flow.authorizeUrl),
        },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Open Hack");

      const connections = await connectionStore.listConnections({
        profileId: "default",
      });
      expect(connections).toHaveLength(1);
      expect(connections[0]?.localAccessAvailable).toBe(true);

      const seeded = await seedLinearLocalAccess({
        config,
        connectionStore,
        profileId: "default",
      });
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) {
        return;
      }
      expect(seeded.token).toBe("lin_access_token");
      expect(seeded.refreshToken).toBe("lin_refresh_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("seed route returns protected local access for an authorized Hack account", async () => {
    const config = createTestConfig();
    const connectionStore: LinearConnectionStore =
      new InMemoryLinearConnectionStore();
    await connectionStore.upsertConnection({
      profileId: "default",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      betterAuthUserId: "user-123",
      betterAuthOrganizationId: "org-123",
      betterAuthTeamId: "team-123",
      organizationId: "lin-org-1",
      teamId: "team-123",
    });
    await connectionStore.saveLocalAccess({
      profileId: "default",
      token: "lin_access_token",
      tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshToken: "lin_refresh_token",
      refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      encryptionKey: config.providerTokenEncryptionKey ?? "",
    });

    const app = createAuthBrokerApp({
      config,
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(makeSession()),
      linearConnectionStore: connectionStore,
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/connections/seed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          profileId: "default",
        }),
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly seed: {
        readonly profileId: string;
        readonly token: string;
        readonly refreshToken?: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.seed.profileId).toBe("default");
    expect(payload.seed.token).toBe("lin_access_token");
    expect(payload.seed.refreshToken).toBe("lin_refresh_token");
  });

  test("seed refreshes expired stored Linear access before returning it", async () => {
    const config = createTestConfig();
    const connectionStore: LinearConnectionStore =
      new InMemoryLinearConnectionStore();
    await connectionStore.upsertConnection({
      profileId: "default",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      betterAuthUserId: "user-123",
      betterAuthOrganizationId: "org-123",
      betterAuthTeamId: "team-123",
      organizationId: "lin-org-1",
      teamId: "team-123",
    });
    await connectionStore.saveLocalAccess({
      profileId: "default",
      token: "expired-token",
      tokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: "lin_refresh_token",
      refreshTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
      encryptionKey: config.providerTokenEncryptionKey ?? "",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== config.linearTokenUrl) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "lin_refreshed_access_token",
            expires_in: 1800,
            refresh_token: "lin_rotated_refresh_token",
            refresh_token_expires_in: 172_800,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    }) as typeof fetch;

    try {
      const seeded = await seedLinearLocalAccess({
        config,
        connectionStore,
        profileId: "default",
      });
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) {
        return;
      }
      expect(seeded.refreshed).toBe(true);
      expect(seeded.token).toBe("lin_refreshed_access_token");
      expect(seeded.refreshToken).toBe("lin_rotated_refresh_token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
