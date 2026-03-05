import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { FlowStore } from "../src/flow-store.ts";
import { createAuthBrokerApp } from "../src/index.ts";

type StartFlowResponse = {
  readonly ok: true;
  readonly flow: {
    readonly flowId: string;
    readonly deviceCode: string;
    readonly pollUrl: string;
    readonly authorizeUrl: string;
  };
};

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
        readonly webhookSignatureVerification?: string;
      }>;
    };
    const linearProvider = payload.providers.find((p) => p.id === "linear");
    expect(linearProvider).toBeDefined();
    expect(linearProvider?.enabled).toBe(true);
    expect(linearProvider?.webhookPath).toBe("/linear/webhooks");
    expect(linearProvider?.webhookSignatureVerification).toBe("hmac-sha256");
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
    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        linearWebhookSigningSecret: secret,
      },
      flowStore: new FlowStore(),
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
    };
    expect(payload.ok).toBe(true);
    expect(payload.accepted).toBe(true);
    expect(payload.signatureVerified).toBe(true);
    expect(payload.eventType).toBe("Issue");
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
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
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
    const payload = (await response.json()) as { readonly ok: boolean };
    expect(payload.ok).toBe(true);
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
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore,
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
        };
      };
      expect(claimPayload.ok).toBe(true);
      expect(claimPayload.status.status).toBe("claimed");
      expect(claimPayload.status.token).toBe("lin_oauth_token");
      expect(claimPayload.status.refreshToken).toBe("lin_refresh_token");
      expect(claimPayload.status.refreshTokenExpiresAt).toBeDefined();
      expect(claimPayload.status.accountEmail).toBe("linear@example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
