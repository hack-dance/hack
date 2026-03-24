import { describe, expect, test } from "bun:test";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import { FlowStore } from "../src/flow-store.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { hasBetterAuthProfileAccess } from "../src/modules/better-auth/session.ts";
import { installAuthBrokerEnvIsolation } from "./test-env.ts";

type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;

type SessionStartFlowResponse = {
  readonly ok: true;
  readonly flow: {
    readonly flowId: string;
    readonly deviceCode: string;
    readonly pollUrl: string;
    readonly authorizeUrl: string;
    readonly socialProviders: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
    }>;
  };
};

installAuthBrokerEnvIsolation();

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
    linearApiBaseUrl: "https://api.linear.app/graphql",
    linearRedirectUri: "http://127.0.0.1:8080/linear/callback",
    linearWebhookPath: "/linear/webhooks",
    flowTtlMs: 60_000,
    flowSweepIntervalMs: 60_000,
  } as const;
}

function createBetterAuthRuntimeWithSession(
  session: BetterAuthSession,
  input?: {
    readonly socialProviders?: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
    }>;
  }
): BetterAuthRuntime {
  return {
    enabled: true,
    socialProviders: input?.socialProviders ?? [
      { id: "github", label: "GitHub" },
    ],
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

async function withManagementTokenSecret<T>(
  value: string,
  fn: () => Promise<T>
): Promise<T> {
  const previousBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const previousAuthSecret = process.env.AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = value;
  process.env.AUTH_SECRET = value;
  try {
    return await fn();
  } finally {
    if (typeof previousBetterAuthSecret === "string") {
      process.env.BETTER_AUTH_SECRET = previousBetterAuthSecret;
    } else {
      process.env.BETTER_AUTH_SECRET = undefined;
    }
    if (typeof previousAuthSecret === "string") {
      process.env.AUTH_SECRET = previousAuthSecret;
    } else {
      process.env.AUTH_SECRET = undefined;
    }
  }
}

describe("broker Hack session auth flow", () => {
  test("profile access fails closed when session or requested profile is missing", () => {
    expect(
      hasBetterAuthProfileAccess({
        session: null,
        profileId: "work",
      })
    ).toBe(false);

    expect(
      hasBetterAuthProfileAccess({
        session: {
          userId: "user-123",
          email: null,
          name: null,
          organizationId: null,
          teamId: null,
          managementTokenProfileId: "work",
        },
        profileId: null,
      })
    ).toBe(false);

    expect(
      hasBetterAuthProfileAccess({
        session: {
          userId: "user-123",
          email: null,
          name: null,
          organizationId: null,
          teamId: null,
          managementTokenProfileId: "work",
        },
        profileId: "work",
      })
    ).toBe(true);
  });

  test("session start exposes configured social providers", async () => {
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(null, {
        socialProviders: [
          { id: "github", label: "GitHub" },
          { id: "google", label: "Google" },
        ],
      }),
    });

    const response = await app.handle(
      new Request("http://localhost/v1/auth/session/start")
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as SessionStartFlowResponse;
    expect(payload.ok).toBe(true);
    expect(payload.flow.socialProviders).toEqual([
      { id: "github", label: "GitHub" },
      { id: "google", label: "Google" },
    ]);
    expect(payload.flow.authorizeUrl).toContain("/auth?");
  });

  test("auth shell completes a session flow for an authenticated session", async () => {
    await withManagementTokenSecret("session-auth-test-secret", async () => {
      const session = {
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

      const app = createAuthBrokerApp({
        config: createTestConfig(),
        flowStore: new FlowStore(),
        betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
      });

      const startResponse = await app.handle(
        new Request("http://localhost/v1/auth/session/start")
      );
      const startPayload = (
        (await startResponse.json()) as SessionStartFlowResponse
      ).flow;

      const completeResponse = await app.handle(
        new Request(startPayload.authorizeUrl)
      );
      expect(completeResponse.status).toBe(302);
      const completeLocation = completeResponse.headers.get("location");
      expect(completeLocation).toBeTruthy();
      if (!completeLocation) {
        return;
      }

      const accountResponse = await app.handle(new Request(completeLocation));
      expect(accountResponse.status).toBe(200);
      const completeHtml = await accountResponse.text();
      expect(completeHtml).toContain("Connected to this Mac.");
      expect(completeHtml).toContain(">HACK<");

      const pollResponse = await app.handle(
        new Request(
          `${startPayload.pollUrl}?deviceCode=${encodeURIComponent(startPayload.deviceCode)}&claim=1`
        )
      );
      expect(pollResponse.status).toBe(200);
      const pollPayload = (await pollResponse.json()) as {
        readonly ok: true;
        readonly status: {
          readonly status: string;
          readonly managementToken?: string;
        };
      };
      expect(pollPayload.ok).toBe(true);
      expect(pollPayload.status.status).toBe("claimed");
      expect(typeof pollPayload.status.managementToken).toBe("string");

      const meResponse = await app.handle(
        new Request("http://localhost/v1/auth/me", {
          headers: {
            authorization: `Bearer ${pollPayload.status.managementToken ?? ""}`,
          },
        })
      );
      expect(meResponse.status).toBe(200);
      const mePayload = (await meResponse.json()) as {
        readonly ok: true;
        readonly user: {
          readonly id: string;
          readonly email: string | null;
          readonly name: string | null;
          readonly emailVerified: boolean;
        } | null;
        readonly activeOrganization: {
          readonly id: string;
          readonly name: string | null;
        } | null;
        readonly activeTeam: {
          readonly id: string;
          readonly name: string | null;
        } | null;
        readonly session: {
          readonly userId: string;
          readonly email: string | null;
          readonly name: string | null;
          readonly organizationId: string | null;
          readonly teamId: string | null;
        } | null;
      };
      expect(mePayload.ok).toBe(true);
      expect(mePayload.user?.id).toBe("user-123");
      expect(mePayload.user?.email).toBe("hack@example.com");
      expect(mePayload.user?.emailVerified).toBe(true);
      expect(mePayload.activeOrganization?.id).toBe("org-123");
      expect(mePayload.activeTeam?.id).toBe("team-123");
      expect(mePayload.session?.userId).toBe("user-123");
      expect(mePayload.session?.email).toBe("hack@example.com");
      expect(mePayload.session?.organizationId).toBe("org-123");
      expect(mePayload.session?.teamId).toBe("team-123");
    });
  });

  test("auth account page auto-returns to the desktop app when a hack redirect is supplied", async () => {
    await withManagementTokenSecret("session-auth-return-secret", async () => {
      const session = {
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

      const app = createAuthBrokerApp({
        config: createTestConfig(),
        flowStore: new FlowStore(),
        betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
      });

      const startResponse = await app.handle(
        new Request(
          "http://localhost/v1/auth/session/start?redirect=hack://auth/complete"
        )
      );
      const startPayload = (
        (await startResponse.json()) as SessionStartFlowResponse
      ).flow;
      const completeResponse = await app.handle(
        new Request(startPayload.authorizeUrl)
      );
      const accountLocation = completeResponse.headers.get("location");
      expect(accountLocation).toContain(
        "redirect=hack%3A%2F%2Fauth%2Fcomplete"
      );
      if (!accountLocation) {
        return;
      }

      const accountResponse = await app.handle(new Request(accountLocation));
      const html = await accountResponse.text();
      expect(html).toContain("Open Hack");
      expect(html).toContain("hack://auth/complete");
      expect(html).toContain("Returning to Hack");
      expect(html).toContain("window.setTimeout");
    });
  });

  test("auth account page accepts debug deep links and keeps the dark handoff shell", async () => {
    const session = {
      user: {
        id: "user-debug",
        email: "debug@example.com",
        emailVerified: true,
        name: "Debug User",
      },
      session: {
        id: "sess-debug",
        userId: "user-debug",
        token: "session-token",
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    } as unknown as BetterAuthSession;

    const app = createAuthBrokerApp({
      config: createTestConfig(),
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
    });

    const startResponse = await app.handle(
      new Request(
        "http://localhost/v1/auth/session/start?redirect=hack-dev://auth/complete"
      )
    );
    const startPayload = (
      (await startResponse.json()) as SessionStartFlowResponse
    ).flow;
    const completeResponse = await app.handle(
      new Request(startPayload.authorizeUrl)
    );
    const accountLocation = completeResponse.headers.get("location");
    expect(accountLocation).toContain(
      "redirect=hack-dev%3A%2F%2Fauth%2Fcomplete"
    );
    if (!accountLocation) {
      return;
    }

    const accountResponse = await app.handle(new Request(accountLocation));
    const html = await accountResponse.text();
    expect(html).toContain(">HACK<");
    expect(html).toContain("Signed in to Hack.");
    expect(html).toContain("hack-dev://auth/complete");
    expect(html).not.toContain("Session not found");
  });
});
