import { describe, expect, test } from "bun:test";

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
    flowTtlMs: 60_000,
    flowSweepIntervalMs: 60_000,
  } as const;
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
