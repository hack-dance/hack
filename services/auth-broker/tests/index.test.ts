import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import { FlowStore } from "../src/flow-store.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { InMemoryLinearConnectionStore } from "../src/modules/linear-connections/service.ts";
import {
  InMemoryLinearSyncStore,
  type LinearSyncStore,
} from "../src/modules/linear-sync-store/service.ts";

type BetterAuthDb = NonNullable<BetterAuthRuntime["db"]>;
type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;

type StartFlowResponse = {
  readonly ok: true;
  readonly flow: {
    readonly flowId: string;
    readonly deviceCode: string;
    readonly pollUrl: string;
    readonly authorizeUrl: string;
  };
};

function createBetterAuthDb(
  rows: readonly Record<string, unknown>[]
): BetterAuthDb {
  const execute = (async () => ({
    rows: [...rows],
  })) as unknown as BetterAuthDb["execute"];
  return { execute } as unknown as BetterAuthDb;
}

function createBetterAuthRuntimeWithSession(
  session: BetterAuthSession,
  db?: BetterAuthDb
): BetterAuthRuntime {
  return {
    enabled: true,
    ...(db ? { db } : {}),
    auth: {
      api: {
        getSession: async () => session,
      },
    } as unknown as BetterAuthAuth["api"],
  } as unknown as BetterAuthRuntime;
}

function withActiveOrganization(
  session: NonNullable<BetterAuthSession>,
  organizationId: string
): BetterAuthSession {
  const base = session as unknown as {
    readonly session: Record<string, unknown>;
    readonly user: Record<string, unknown>;
  };
  return {
    user: base.user,
    session: {
      ...base.session,
      activeOrganizationId: organizationId,
    },
  } as unknown as BetterAuthSession;
}

/**
 * Build deterministic config values for broker route tests.
 */
function createTestConfig() {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:8080",
    flowStorePath: ".data/test-oauth-flows.json",
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
    linearActor: "app",
    linearScopes: "read,write,app:mentionable,app:assignable",
    linearAuthorizeUrl: "https://linear.app/oauth/authorize",
    linearTokenUrl: "https://api.linear.app/oauth/token",
    linearApiBaseUrl: "https://api.linear.app",
    linearRedirectUri: "http://127.0.0.1:8080/linear/callback",
    linearWebhookPath: "/linear/webhooks",
    flowTtlMs: 60_000,
    flowSweepIntervalMs: 60_000,
  } as const;
}

function resolveFetchUrl(input: string | Request | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

describe("auth broker github flow routes", () => {
  test("better auth status endpoint is exposed", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: {
        enabled: false,
        reason: "test-disabled",
      },
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/better-auth/status")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly enabled: boolean;
      readonly reason: string | null;
      readonly basePath: string;
    };
    expect(payload.enabled).toBe(false);
    expect(payload.reason).toBe("test-disabled");
    expect(payload.basePath).toBe("/api/auth");
  });

  test("shared middleware accepts optional inbound request id header", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/health", {
        headers: {
          "x-request-id": "test-request-id",
        },
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly service: string;
      readonly now: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("hack-auth-broker");
    expect(payload.now.length).toBeGreaterThan(0);
  });

  test("shared middleware enforces get-only access on read routes", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/v1/auth/providers", {
        method: "POST",
      })
    );
    expect(response.status).toBe(405);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("method_not_allowed");
  });

  test("shared middleware does not block better-auth write methods", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: {
        enabled: false,
        reason: "test-disabled",
      },
    });
    const response = await app.handle(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
      })
    );
    expect(response.status).toBe(503);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("test-disabled");
  });

  test("providers route includes linear metadata", async () => {
    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        linearClientId: "linear-client-id",
        linearWebhookSigningSecret: "linear-hook-secret",
      },
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/v1/auth/providers")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly providers: ReadonlyArray<{
        readonly id: string;
        readonly enabled: boolean;
        readonly webhookPath?: string;
        readonly connectionsPath?: string;
        readonly accessControlMode?: string;
        readonly webhookSignatureVerification?: string;
      }>;
    };
    const linearProvider = payload.providers.find((p) => p.id === "linear");
    expect(linearProvider).toBeDefined();
    expect(linearProvider?.enabled).toBe(true);
    expect(linearProvider?.webhookPath).toBe("/linear/webhooks");
    expect(linearProvider?.connectionsPath).toBe("/v1/auth/linear/connections");
    expect(linearProvider?.accessControlMode).toBe("manual_unenforced");
    expect(linearProvider?.webhookSignatureVerification).toBe("hmac-sha256");
  });

  test("providers route reports session-owned Linear access when Better Auth is enabled", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(null),
    });
    const response = await app.handle(
      new Request("http://localhost/v1/auth/providers")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly providers: ReadonlyArray<{
        readonly id: string;
        readonly accessControlMode?: string;
      }>;
    };
    const linearProvider = payload.providers.find((p) => p.id === "linear");
    expect(linearProvider?.accessControlMode).toBe("better_auth_session_owned");
  });

  test("providers route reports organization-owned Linear access when Better Auth has an active organization", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        withActiveOrganization(
          {
            session: {
              id: "sess-org",
              userId: "user-org",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              token: "token-org",
            },
            user: {
              id: "user-org",
              email: "org@example.com",
              emailVerified: true,
              name: "Org User",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          "better-auth-org"
        )
      ),
    });
    const response = await app.handle(
      new Request("http://localhost/v1/auth/providers")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly providers: ReadonlyArray<{
        readonly id: string;
        readonly accessControlMode?: string;
      }>;
    };
    const linearProvider = payload.providers.find((p) => p.id === "linear");
    expect(linearProvider?.accessControlMode).toBe(
      "better_auth_organization_owned"
    );
  });

  test("linear start flow requests app actor mode by default", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/start?profile=default")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as StartFlowResponse;
    expect(payload.ok).toBe(true);
    const authorizeUrl = new URL(payload.flow.authorizeUrl);
    expect(authorizeUrl.searchParams.get("actor")).toBe("app");
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "read,write,app:mentionable,app:assignable"
    );
  });

  test("linear webhook accepts valid signed payload", async () => {
    const secret = "linear-hook-secret";
    const syncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        linearWebhookSigningSecret: secret,
      },
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
    });
    const rawBody = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("hex");
    const response = await app.handle(
      new Request("http://localhost/linear/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signature,
        },
        body: rawBody,
      })
    );
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      readonly ok: boolean;
      readonly signatureVerified: boolean;
      readonly accepted: boolean;
      readonly eventType: string | null;
      readonly deliveryId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.accepted).toBe(true);
    expect(payload.signatureVerified).toBe(true);
    expect(payload.eventType).toBe("Issue");
    expect(payload.deliveryId.length).toBeGreaterThan(0);

    const deliveries = await syncStore.listWebhookDeliveries({
      status: "pending",
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.id).toBe(payload.deliveryId);
    expect(deliveries[0]?.path).toBe("/linear/webhooks");
    expect(deliveries[0]?.eventType).toBe("Issue");
    expect(deliveries[0]?.action).toBe("create");
    expect(deliveries[0]?.signatureVerified).toBe(true);
  });

  test("linear webhook rejects invalid signature", async () => {
    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        linearWebhookSigningSecret: "linear-hook-secret",
      },
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/linear/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature":
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
        body: JSON.stringify({
          action: "create",
          type: "Issue",
          webhookTimestamp: new Date().toISOString(),
        }),
      })
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as {
      readonly ok: boolean;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("invalid_linear_signature");
  });

  test("linear callback route rejects unknown flow state", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });
    const response = await app.handle(
      new Request("http://localhost/linear/callback?code=test&state=state")
    );
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Session not found");
  });

  test("linear webhook legacy alias remains available", async () => {
    const syncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
    });
    const response = await app.handle(
      new Request("http://localhost/v1/integrations/linear/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "Issue", action: "create" }),
      })
    );
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      readonly ok: boolean;
      readonly deliveryId: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.deliveryId.length).toBeGreaterThan(0);

    const deliveries = await syncStore.listWebhookDeliveries({
      status: "pending",
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.path).toBe("/v1/integrations/linear/webhook");
    expect(deliveries[0]?.signatureVerified).toBe(false);
  });

  test("linear webhook persistence records organization ownership from payload", async () => {
    const syncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
    });
    const response = await app.handle(
      new Request("http://localhost/linear/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "Issue",
          action: "update",
          webhookTimestamp: new Date().toISOString(),
          organization: {
            id: "org-linear",
            name: "Hack Dance",
          },
        }),
      })
    );

    expect(response.status).toBe(202);
    const deliveries = await syncStore.listWebhookDeliveries({
      status: "pending",
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.betterAuthUserId).toBeNull();
    expect(deliveries[0]?.organizationId).toBe("org-linear");
    expect(deliveries[0]?.teamId).toBeNull();
  });

  test("linear webhook resolves profile ownership from a unique connected organization", async () => {
    const syncStore = new InMemoryLinearSyncStore();
    const connectionStore = new InMemoryLinearConnectionStore();
    await connectionStore.upsertConnection({
      profileId: "work",
      accountId: "usr_linear",
      accountEmail: "linear@example.com",
      organizationId: "org-linear",
    });
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      linearConnectionStore: connectionStore,
    });

    const response = await app.handle(
      new Request("http://localhost/linear/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "Issue",
          action: "update",
          webhookTimestamp: new Date().toISOString(),
          organization: {
            id: "org-linear",
            name: "Hack Dance",
          },
          data: {
            teamId: "team-linear",
          },
        }),
      })
    );

    expect(response.status).toBe(202);
    const deliveries = await syncStore.listWebhookDeliveries({
      status: "pending",
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.profileId).toBe("work");
    expect(deliveries[0]?.organizationId).toBe("org-linear");
    expect(deliveries[0]?.teamId).toBe("team-linear");
  });

  test("linear sync store can mark a delivery as applied", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const recorded = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: {
        type: "Issue",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      betterAuthUserId: null,
      organizationId: null,
      teamId: null,
    });

    expect(recorded.status).toBe("pending");

    const applied = await syncStore.markWebhookDeliveryApplied({
      deliveryId: recorded.id,
    });
    expect(applied?.status).toBe("applied");

    const pending = await syncStore.listWebhookDeliveries({
      status: "pending",
    });
    expect(pending).toHaveLength(0);
  });

  test("linear pending deliveries route lists pending deliveries with scope filters", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
    });

    const matchingDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue","action":"create"}',
      payloadJson: {
        type: "Issue",
        action: "create",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-a",
      projectId: "project-a",
      issueId: "issue-a",
      issueIdentifier: "HACK-1",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
      teamId: "team-a",
    });
    await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue","action":"update"}',
      payloadJson: {
        type: "Issue",
        action: "update",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "update",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-b",
      projectId: "project-b",
      issueId: "issue-b",
      issueIdentifier: "HACK-2",
      betterAuthUserId: "user-b",
      organizationId: "org-b",
      teamId: "team-b",
    });
    const appliedDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue","action":"comment"}',
      payloadJson: {
        type: "Issue",
        action: "comment",
      },
      signatureVerified: true,
      eventType: "Comment",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-a",
      projectId: "project-a",
      issueId: "issue-a",
      issueIdentifier: "HACK-1",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
      teamId: "team-a",
    });
    await syncStore.markWebhookDeliveryApplied({
      deliveryId: appliedDelivery.id,
    });

    const response = await app.handle(
      new Request(
        "http://localhost/v1/auth/linear/deliveries?profileId=profile-a&projectId=project-a&teamId=team-a"
      )
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly deliveries: ReadonlyArray<{
        readonly id: string;
        readonly status: string;
        readonly profileId: string | null;
        readonly projectId: string | null;
        readonly teamId: string | null;
        readonly betterAuthUserId: string | null;
        readonly organizationId: string | null;
        readonly ownerTeamId: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.deliveries).toHaveLength(1);
    expect(payload.deliveries[0]?.id).toBe(matchingDelivery.id);
    expect(payload.deliveries[0]?.status).toBe("pending");
    expect(payload.deliveries[0]?.profileId).toBe("profile-a");
    expect(payload.deliveries[0]?.projectId).toBe("project-a");
    expect(payload.deliveries[0]?.teamId).toBe("team-a");
    expect(payload.deliveries[0]?.betterAuthUserId).toBe("user-a");
    expect(payload.deliveries[0]?.organizationId).toBe("org-a");
    expect(payload.deliveries[0]?.ownerTeamId).toBe("team-a");
  });

  test("linear pending deliveries route requires Better Auth session when enabled", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(null),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/deliveries")
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("better_auth_session_required");
  });

  test("linear pending deliveries route only returns the current user's deliveries when Better Auth is enabled", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession({
        session: {
          id: "sess-user-a",
          userId: "user-a",
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          token: "token-user-a",
        },
        user: {
          id: "user-a",
          email: "user-a@example.com",
          emailVerified: true,
          name: "User A",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    });
    const ownedDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: {
        type: "Issue",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-a",
      projectId: "project-a",
      issueId: "issue-a",
      issueIdentifier: "HACK-1",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
      teamId: "team-a",
    });
    await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: {
        type: "Issue",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-b",
      projectId: "project-b",
      issueId: "issue-b",
      issueIdentifier: "HACK-2",
      betterAuthUserId: "user-b",
      organizationId: "org-b",
      teamId: "team-b",
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/deliveries")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly accessControlMode: string;
      readonly deliveries: ReadonlyArray<{
        readonly id: string;
        readonly betterAuthUserId: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.accessControlMode).toBe("better_auth_session_owned");
    expect(payload.deliveries).toHaveLength(1);
    expect(payload.deliveries[0]?.id).toBe(ownedDelivery.id);
    expect(payload.deliveries[0]?.betterAuthUserId).toBe("user-a");
  });

  test("linear pending deliveries route returns the current organization's deliveries when Better Auth has an active organization", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        withActiveOrganization(
          {
            session: {
              id: "sess-user-a",
              userId: "user-a",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              token: "token-user-a",
            },
            user: {
              id: "user-a",
              email: "user-a@example.com",
              emailVerified: true,
              name: "User A",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          "shared-org"
        )
      ),
    });
    const firstDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: { type: "Issue" },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-a",
      projectId: "project-a",
      issueId: "issue-a",
      issueIdentifier: "HACK-1",
      betterAuthUserId: "user-a",
      betterAuthOrganizationId: "shared-org",
      organizationId: "org-a",
      teamId: "team-a",
    });
    const secondDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: { type: "Issue" },
      signatureVerified: true,
      eventType: "Issue",
      action: "update",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-b",
      projectId: "project-b",
      issueId: "issue-b",
      issueIdentifier: "HACK-2",
      betterAuthUserId: "user-b",
      betterAuthOrganizationId: "shared-org",
      organizationId: "org-b",
      teamId: "team-b",
    });
    await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: { type: "Issue" },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-c",
      projectId: "project-c",
      issueId: "issue-c",
      issueIdentifier: "HACK-3",
      betterAuthUserId: "user-c",
      betterAuthOrganizationId: "other-org",
      organizationId: "org-c",
      teamId: "team-c",
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/deliveries")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly accessControlMode: string;
      readonly deliveries: ReadonlyArray<{
        readonly id: string;
        readonly betterAuthOrganizationId: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.accessControlMode).toBe("better_auth_organization_owned");
    expect(payload.deliveries).toHaveLength(2);
    expect(
      [...payload.deliveries.map((delivery) => delivery.id)].sort()
    ).toEqual([...([firstDelivery.id, secondDelivery.id] as const)].sort());
    expect(
      payload.deliveries.every(
        (delivery) => delivery.betterAuthOrganizationId === "shared-org"
      )
    ).toBe(true);
  });

  test("linear pending deliveries route can mark a delivery applied", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
    });
    const delivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: {
        type: "Issue",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-a",
      projectId: "project-a",
      issueId: "issue-a",
      issueIdentifier: "HACK-1",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
      teamId: "team-a",
    });

    const response = await app.handle(
      new Request(
        `http://localhost/v1/auth/linear/deliveries/${delivery.id}/apply`,
        {
          method: "POST",
        }
      )
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly delivery: {
        readonly id: string;
        readonly status: string;
        readonly appliedAt: string | null;
        readonly betterAuthUserId: string | null;
        readonly organizationId: string | null;
        readonly ownerTeamId: string | null;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery.id).toBe(delivery.id);
    expect(payload.delivery.status).toBe("applied");
    expect(payload.delivery.appliedAt).not.toBeNull();
    expect(payload.delivery.betterAuthUserId).toBe("user-a");
    expect(payload.delivery.organizationId).toBe("org-a");
    expect(payload.delivery.ownerTeamId).toBe("team-a");
  });

  test("linear pending deliveries route returns not found for unknown apply id", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: new InMemoryLinearSyncStore(),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/deliveries/missing/apply", {
        method: "POST",
      })
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("linear_delivery_not_found");
  });

  test("linear pending deliveries apply route only allows the owner when Better Auth is enabled", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession({
        session: {
          id: "sess-user-a",
          userId: "user-a",
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          token: "token-user-a",
        },
        user: {
          id: "user-a",
          email: "user-a@example.com",
          emailVerified: true,
          name: "User A",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    });
    const otherUsersDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: {
        type: "Issue",
      },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-b",
      projectId: "project-b",
      issueId: "issue-b",
      issueIdentifier: "HACK-2",
      betterAuthUserId: "user-b",
      betterAuthOrganizationId: "org-b",
      organizationId: "org-b",
      teamId: "team-b",
    });

    const response = await app.handle(
      new Request(
        `http://localhost/v1/auth/linear/deliveries/${otherUsersDelivery.id}/apply`,
        {
          method: "POST",
        }
      )
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("linear_delivery_not_found");
  });

  test("linear pending deliveries apply route allows the active Better Auth organization", async () => {
    const syncStore: LinearSyncStore = new InMemoryLinearSyncStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearSyncStore: syncStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        withActiveOrganization(
          {
            session: {
              id: "sess-user-a",
              userId: "user-a",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              token: "token-user-a",
            },
            user: {
              id: "user-a",
              email: "user-a@example.com",
              emailVerified: true,
              name: "User A",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          "shared-org"
        )
      ),
    });
    const sharedDelivery = await syncStore.recordWebhookDelivery({
      path: "/linear/webhooks",
      rawBody: '{"type":"Issue"}',
      payloadJson: { type: "Issue" },
      signatureVerified: true,
      eventType: "Issue",
      action: "create",
      webhookTimestamp: new Date().toISOString(),
      profileId: "profile-b",
      projectId: "project-b",
      issueId: "issue-b",
      issueIdentifier: "HACK-2",
      betterAuthUserId: "user-b",
      betterAuthOrganizationId: "shared-org",
      organizationId: "org-b",
      teamId: "team-b",
    });

    const response = await app.handle(
      new Request(
        `http://localhost/v1/auth/linear/deliveries/${sharedDelivery.id}/apply`,
        { method: "POST" }
      )
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly delivery: {
        readonly id: string;
        readonly status: string;
      };
    };
    expect(payload.ok).toBe(true);
    expect(payload.delivery.id).toBe(sharedDelivery.id);
    expect(payload.delivery.status).toBe("applied");
  });

  test("linear start route issues flow payload and polling reads pending state", async () => {
    const flowStore = new FlowStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore,
    });

    const startResponse = await app.handle(
      new Request(
        "http://localhost/v1/auth/linear/start?profile=default&setDefault=true"
      )
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as StartFlowResponse;
    expect(startPayload.ok).toBe(true);
    expect(startPayload.flow.authorizeUrl).toContain(
      "linear.app/oauth/authorize"
    );
    expect(startPayload.flow.authorizeUrl).toContain("code_challenge=");

    const flow = flowStore.getById(startPayload.flow.flowId);
    expect(flow).not.toBeNull();
    if (!flow) {
      return;
    }

    const pollResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/linear/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}`
      )
    );
    expect(pollResponse.status).toBe(200);
    const pollPayload = (await pollResponse.json()) as {
      readonly ok: true;
      readonly status: {
        readonly status: string;
        readonly profileId: string;
        readonly setDefault: boolean;
      };
    };
    expect(pollPayload.ok).toBe(true);
    expect(pollPayload.status.status).toBe("pending");
    expect(pollPayload.status.profileId).toBe("default");
    expect(pollPayload.status.setDefault).toBe(true);
  });

  test("linear callback completes flow and claim returns token", async () => {
    const flowStore = new FlowStore();
    const connectionStore = new InMemoryLinearConnectionStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore,
      linearConnectionStore: connectionStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        withActiveOrganization(
          {
            session: {
              id: "sess-linear",
              userId: "better-auth-linear-user",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              token: "token-linear",
            },
            user: {
              id: "better-auth-linear-user",
              email: "linear@example.com",
              emailVerified: true,
              name: "Linear User",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          "better-auth-org"
        ),
        createBetterAuthDb([{ id: "better-auth-linear-user" }])
      ),
    });

    const startResponse = await app.handle(
      new Request("http://localhost/v1/auth/linear/start?profile=work")
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as StartFlowResponse;
    const flow = flowStore.getById(startPayload.flow.flowId);
    expect(flow).not.toBeNull();
    if (!flow) {
      return;
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === createTestConfig().linearTokenUrl) {
        return new Response(
          JSON.stringify({
            access_token: "lin_oauth_token",
            expires_in: 3600,
            refresh_token: "lin_refresh_token",
            refresh_token_expires_in: 86_400,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        );
      }
      if (url === createTestConfig().linearApiBaseUrl) {
        const bodyText =
          typeof init?.body === "string" ? init.body : String(init?.body ?? "");
        if (bodyText.includes("viewer")) {
          return new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: "usr_linear",
                  name: "Linear User",
                  email: "linear@example.com",
                  displayName: "Linear User",
                  organization: {
                    id: "org-linear",
                    name: "Hack Dance",
                  },
                  teams: {
                    nodes: [{ id: "team-linear", name: "Platform" }],
                  },
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            }
          );
        }
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    try {
      const callbackResponse = await app.handle(
        new Request(
          `http://localhost/linear/callback?state=${encodeURIComponent(flow.state)}&code=test-code`
        )
      );
      expect(callbackResponse.status).toBe(200);
      const callbackHtml = await callbackResponse.text();
      expect(callbackHtml).toContain("Linear connected");

      const claimResponse = await app.handle(
        new Request(
          `http://localhost/v1/auth/linear/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}&claim=1`
        )
      );
      expect(claimResponse.status).toBe(200);
      const claimPayload = (await claimResponse.json()) as {
        readonly ok: true;
        readonly status: {
          readonly status: string;
          readonly token?: string;
          readonly refreshToken?: string;
          readonly refreshTokenExpiresAt?: string;
          readonly accountEmail?: string;
          readonly betterAuthUserId?: string;
          readonly betterAuthLinkState?: string;
        };
      };
      expect(claimPayload.ok).toBe(true);
      expect(claimPayload.status.status).toBe("claimed");
      expect(claimPayload.status.token).toBe("lin_oauth_token");
      expect(claimPayload.status.refreshToken).toBe("lin_refresh_token");
      expect(claimPayload.status.refreshTokenExpiresAt).toBeDefined();
      expect(claimPayload.status.accountEmail).toBe("linear@example.com");
      expect(claimPayload.status.betterAuthUserId).toBe(
        "better-auth-linear-user"
      );
      expect(claimPayload.status.betterAuthLinkState).toBe("linked_existing");

      const connectionsResponse = await app.handle(
        new Request(
          "http://localhost/v1/auth/linear/connections?profileId=work"
        )
      );
      expect(connectionsResponse.status).toBe(200);
      const connectionsPayload = (await connectionsResponse.json()) as {
        readonly ok: true;
        readonly accessControlMode: string;
        readonly connections: ReadonlyArray<{
          readonly profileId: string | null;
          readonly accountEmail: string | null;
          readonly organizationId: string | null;
          readonly betterAuthUserId: string | null;
          readonly betterAuthOrganizationId: string | null;
          readonly metadata: Record<string, unknown>;
        }>;
      };
      expect(connectionsPayload.ok).toBe(true);
      expect(connectionsPayload.accessControlMode).toBe(
        "better_auth_organization_owned"
      );
      expect(connectionsPayload.connections).toHaveLength(1);
      expect(connectionsPayload.connections[0]?.profileId).toBe("work");
      expect(connectionsPayload.connections[0]?.accountEmail).toBe(
        "linear@example.com"
      );
      expect(connectionsPayload.connections[0]?.organizationId).toBe(
        "org-linear"
      );
      expect(connectionsPayload.connections[0]?.betterAuthUserId).toBe(
        "better-auth-linear-user"
      );
      expect(connectionsPayload.connections[0]?.betterAuthOrganizationId).toBe(
        "better-auth-org"
      );
      expect(connectionsPayload.connections[0]?.metadata).toMatchObject({
        organizationName: "Hack Dance",
        teamIds: ["team-linear"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("linear connections route requires Better Auth session when enabled", async () => {
    const connectionStore = new InMemoryLinearConnectionStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearConnectionStore: connectionStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(null),
    });
    await connectionStore.upsertConnection({
      profileId: "work",
      accountEmail: "linear@example.com",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/connections")
    );
    expect(response.status).toBe(401);
    const payload = (await response.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("better_auth_session_required");
  });

  test("linear connections route only returns the current user's connections when Better Auth is enabled", async () => {
    const connectionStore = new InMemoryLinearConnectionStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearConnectionStore: connectionStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession({
        session: {
          id: "sess-user-a",
          userId: "user-a",
          expiresAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          token: "token-user-a",
        },
        user: {
          id: "user-a",
          email: "user-a@example.com",
          emailVerified: true,
          name: "User A",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
    });
    await connectionStore.upsertConnection({
      profileId: "work",
      accountEmail: "linear-a@example.com",
      betterAuthUserId: "user-a",
      organizationId: "org-a",
    });
    await connectionStore.upsertConnection({
      profileId: "other",
      accountEmail: "linear-b@example.com",
      betterAuthUserId: "user-b",
      organizationId: "org-b",
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/connections")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly accessControlMode: string;
      readonly connections: ReadonlyArray<{
        readonly profileId: string | null;
        readonly accountEmail: string | null;
        readonly betterAuthUserId: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.accessControlMode).toBe("better_auth_session_owned");
    expect(payload.connections).toHaveLength(1);
    expect(payload.connections[0]?.profileId).toBe("work");
    expect(payload.connections[0]?.accountEmail).toBe("linear-a@example.com");
    expect(payload.connections[0]?.betterAuthUserId).toBe("user-a");
  });

  test("linear connections route returns the current organization's connections when Better Auth has an active organization", async () => {
    const connectionStore = new InMemoryLinearConnectionStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      linearConnectionStore: connectionStore,
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        withActiveOrganization(
          {
            session: {
              id: "sess-user-a",
              userId: "user-a",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
              token: "token-user-a",
            },
            user: {
              id: "user-a",
              email: "user-a@example.com",
              emailVerified: true,
              name: "User A",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          "shared-org"
        )
      ),
    });
    await connectionStore.upsertConnection({
      profileId: "work",
      accountEmail: "linear-a@example.com",
      betterAuthUserId: "user-a",
      betterAuthOrganizationId: "shared-org",
      organizationId: "org-a",
    });
    await connectionStore.upsertConnection({
      profileId: "shared",
      accountEmail: "linear-b@example.com",
      betterAuthUserId: "user-b",
      betterAuthOrganizationId: "shared-org",
      organizationId: "org-b",
    });
    await connectionStore.upsertConnection({
      profileId: "other",
      accountEmail: "linear-c@example.com",
      betterAuthUserId: "user-c",
      betterAuthOrganizationId: "other-org",
      organizationId: "org-c",
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/linear/connections")
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly ok: true;
      readonly accessControlMode: string;
      readonly connections: ReadonlyArray<{
        readonly profileId: string | null;
        readonly betterAuthOrganizationId: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.accessControlMode).toBe("better_auth_organization_owned");
    expect(payload.connections).toHaveLength(2);
    expect(
      [...payload.connections.map((connection) => connection.profileId)].sort()
    ).toEqual(["shared", "work"]);
    expect(
      payload.connections.every(
        (connection) => connection.betterAuthOrganizationId === "shared-org"
      )
    ).toBe(true);
  });

  test("linear refresh route exchanges refresh token", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url !== createTestConfig().linearTokenUrl) {
        return new Response("not found", { status: 404 });
      }

      const payload =
        typeof init?.body === "string"
          ? Object.fromEntries(new URLSearchParams(init.body))
          : {};
      expect(init?.headers).toMatchObject({
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(payload.grant_type).toBe("refresh_token");
      expect(payload.refresh_token).toBe("lin_refresh_token");

      return new Response(
        JSON.stringify({
          access_token: "lin_refreshed_access_token",
          expires_in: 1800,
          refresh_token: "lin_rotated_refresh_token",
          refresh_token_expires_in: 172_800,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      );
    }) as unknown as typeof fetch;

    try {
      const response = await app.handle(
        new Request("http://localhost/v1/auth/linear/refresh", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            refreshToken: "lin_refresh_token",
          }),
        })
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        readonly ok: true;
        readonly token: string;
        readonly refreshToken?: string;
        readonly expiresAt?: string;
        readonly refreshTokenExpiresAt?: string;
      };
      expect(payload.ok).toBe(true);
      expect(payload.token).toBe("lin_refreshed_access_token");
      expect(payload.refreshToken).toBe("lin_rotated_refresh_token");
      expect(payload.expiresAt).toBeDefined();
      expect(payload.refreshTokenExpiresAt).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("start route issues flow payload and polling reads pending state", async () => {
    const flowStore = new FlowStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore,
    });

    const startResponse = await app.handle(
      new Request(
        "http://localhost/v1/auth/github/start?profile=default&setDefault=true"
      )
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as StartFlowResponse;
    expect(startPayload.ok).toBe(true);
    expect(startPayload.flow.authorizeUrl).toContain(
      "github.com/login/oauth/authorize"
    );
    expect(startPayload.flow.authorizeUrl).toContain("scope=repo%2Cread%3Aorg");

    const flow = flowStore.getById(startPayload.flow.flowId);
    expect(flow).not.toBeNull();
    if (!flow) {
      return;
    }

    const pollResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/github/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}`
      )
    );
    expect(pollResponse.status).toBe(200);
    const pollPayload = (await pollResponse.json()) as {
      readonly ok: true;
      readonly status: {
        readonly status: string;
        readonly profileId: string;
        readonly setDefault: boolean;
      };
    };
    expect(pollPayload.ok).toBe(true);
    expect(pollPayload.status.status).toBe("pending");
    expect(pollPayload.status.profileId).toBe("default");
    expect(pollPayload.status.setDefault).toBe(true);
  });

  test("poll route rejects invalid device code", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
    });

    const startResponse = await app.handle(
      new Request("http://localhost/v1/auth/github/start")
    );
    const startPayload = (await startResponse.json()) as StartFlowResponse;

    const pollResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/github/flows/${startPayload.flow.flowId}?deviceCode=wrong-code`
      )
    );
    expect(pollResponse.status).toBe(403);
    const pollPayload = (await pollResponse.json()) as {
      readonly ok: false;
      readonly error: string;
    };
    expect(pollPayload.ok).toBe(false);
    expect(pollPayload.error).toBe("invalid_device_code");
  });

  test("requireInstallation defers token claim until installation is present", async () => {
    const flowStore = new FlowStore();
    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        githubAppInstallUrl:
          "https://github.com/apps/hack-dance/installations/new",
      },
      flowStore,
    });

    const startResponse = await app.handle(
      new Request(
        "http://localhost/v1/auth/github/start?profile=default&setDefault=true&requireInstallation=1"
      )
    );
    expect(startResponse.status).toBe(200);
    const startPayload = (await startResponse.json()) as StartFlowResponse;

    flowStore.markComplete({
      flowId: startPayload.flow.flowId,
      account: {
        login: "roodboi",
        installationIds: [],
      },
      token: "gho_test_token",
    });

    const deferredClaimResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/github/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}&claim=1&requireInstallation=1`
      )
    );
    expect(deferredClaimResponse.status).toBe(200);
    const deferredPayload = (await deferredClaimResponse.json()) as {
      readonly ok: true;
      readonly status: {
        readonly status: string;
        readonly installationId?: string;
        readonly token?: string;
      };
    };
    expect(deferredPayload.ok).toBe(true);
    expect(deferredPayload.status.status).toBe("complete");
    expect(deferredPayload.status.installationId).toBeUndefined();
    expect(deferredPayload.status.token).toBeUndefined();

    const immediateClaimResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/github/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}&claim=1`
      )
    );
    expect(immediateClaimResponse.status).toBe(200);
    const claimedPayload = (await immediateClaimResponse.json()) as {
      readonly ok: true;
      readonly status: {
        readonly status: string;
        readonly token?: string;
      };
    };
    expect(claimedPayload.ok).toBe(true);
    expect(claimedPayload.status.status).toBe("claimed");
    expect(claimedPayload.status.token).toBe("gho_test_token");
  });

  test("callback error path marks flow status as error", async () => {
    const flowStore = new FlowStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore,
    });

    const startResponse = await app.handle(
      new Request("http://localhost/v1/auth/github/start")
    );
    const startPayload = (await startResponse.json()) as StartFlowResponse;
    const flow = flowStore.getById(startPayload.flow.flowId);
    expect(flow).not.toBeNull();
    if (!flow) {
      return;
    }

    const callbackResponse = await app.handle(
      new Request(
        `http://localhost/gh/callback?state=${encodeURIComponent(flow.state)}&error=access_denied`
      )
    );
    expect(callbackResponse.status).toBe(400);
    const callbackHtml = await callbackResponse.text();
    expect(callbackHtml).toContain("GitHub authorization failed");

    const pollResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/github/flows/${startPayload.flow.flowId}?deviceCode=${encodeURIComponent(startPayload.flow.deviceCode)}`
      )
    );
    expect(pollResponse.status).toBe(200);
    const pollPayload = (await pollResponse.json()) as {
      readonly ok: true;
      readonly status: {
        readonly status: string;
        readonly error?: string;
      };
    };
    expect(pollPayload.ok).toBe(true);
    expect(pollPayload.status.status).toBe("error");
    expect(pollPayload.status.error).toContain("access_denied");
  });
});
