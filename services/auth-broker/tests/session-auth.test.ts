import { describe, expect, test } from "bun:test";

import {
  createSharedBetterAuthContract,
  HACK_WEB_BROKER_SESSION_COOKIE_NAME,
} from "@hack/auth-contract";

import type {
  BetterAuthRuntime,
  BetterAuthSocialProvider,
} from "../src/better-auth.ts";
import {
  organization as betterAuthOrganization,
  team as betterAuthTeam,
  user as betterAuthUser,
} from "../src/db/schema.ts";
import { FlowStore } from "../src/flow-store.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { issueBrokerManagementToken } from "../src/modules/better-auth/management-token.ts";
import { hasBetterAuthProfileAccess } from "../src/modules/better-auth/session.ts";
import { InMemoryOrgTeamsStore } from "../src/modules/orgs/service.ts";
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
    webAppBaseUrl: "http://localhost:3000",
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
    readonly socialProviders?: readonly BetterAuthSocialProvider[];
    readonly trustedOrigins?: readonly string[];
    readonly getSession?: (
      value: Parameters<BetterAuthAuth["api"]["getSession"]>[0]
    ) => Promise<BetterAuthSession>;
    readonly storedUser?: {
      readonly id: string;
      readonly email: string;
      readonly emailVerified: boolean;
      readonly name: string;
    } | null;
    readonly storedOrganization?: {
      readonly id: string;
      readonly name: string;
    } | null;
    readonly storedTeam?: {
      readonly id: string;
      readonly name: string;
    } | null;
  }
): BetterAuthRuntime {
  return {
    enabled: true,
    contract: createSharedBetterAuthContract({
      socialProviders: input?.socialProviders ?? [
        { id: "github", label: "GitHub" },
      ],
      publicBaseUrl: createTestConfig().publicBaseUrl,
      localDevHost: "hack-cli.hack",
      trustedOrigins: input?.trustedOrigins ?? [
        "https://hack-cli-preview.vercel.app",
      ],
    }),
    auth: {
      api: {
        getSession: input?.getSession ?? (() => Promise.resolve(session)),
      },
    } as unknown as BetterAuthAuth["api"],
    ...(input?.storedUser || input?.storedOrganization || input?.storedTeam
      ? {
          db: {
            select: () => ({
              from: (table: unknown) => ({
                where: () => ({
                  limit: () => {
                    if (table === betterAuthUser) {
                      return Promise.resolve(
                        input.storedUser ? [input.storedUser] : []
                      );
                    }
                    if (table === betterAuthOrganization) {
                      return Promise.resolve(
                        input.storedOrganization
                          ? [input.storedOrganization]
                          : []
                      );
                    }
                    if (table === betterAuthTeam) {
                      return Promise.resolve(
                        input.storedTeam ? [input.storedTeam] : []
                      );
                    }
                    return Promise.resolve([]);
                  },
                }),
              }),
            }),
          } as unknown as BetterAuthRuntime["db"],
        }
      : {}),
  } as unknown as BetterAuthRuntime;
}

async function handleJsonRequest(input: {
  readonly app: ReturnType<typeof createAuthBrokerApp>;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<Response> {
  const hasBody = typeof input.body !== "undefined";
  return await input.app.handle(
    new Request(`http://localhost${input.path}`, {
      method: input.method ?? "GET",
      headers: hasBody
        ? {
            "content-type": "application/json",
            ...input.headers,
          }
        : input.headers,
      body: hasBody ? JSON.stringify(input.body) : undefined,
    })
  );
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
          emailVerified: null,
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
          emailVerified: null,
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

      const accountResponse = await app.handle(
        new Request(
          `http://localhost/auth/account?bridge=1&flowId=${encodeURIComponent(
            startPayload.flowId
          )}&deviceCode=${encodeURIComponent(startPayload.deviceCode)}`
        )
      );
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
      const accountResponse = await app.handle(
        new Request(
          `http://localhost/auth/account?bridge=1&flowId=${encodeURIComponent(
            startPayload.flowId
          )}&deviceCode=${encodeURIComponent(
            startPayload.deviceCode
          )}&redirect=${encodeURIComponent("hack://auth/complete")}`
        )
      );
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
    const accountResponse = await app.handle(
      new Request(
        `http://localhost/auth/account?bridge=1&flowId=${encodeURIComponent(
          startPayload.flowId
        )}&deviceCode=${encodeURIComponent(
          startPayload.deviceCode
        )}&redirect=${encodeURIComponent("hack-dev://auth/complete")}`
      )
    );
    const html = await accountResponse.text();
    expect(html).toContain(">HACK<");
    expect(html).toContain("Signed in to Hack.");
    expect(html).toContain("hack-dev://auth/complete");
    expect(html).not.toContain("Session not found");
  });

  test("auth account page auto-returns to trusted wildcard web origins from the shared contract", async () => {
    await withManagementTokenSecret(
      "session-auth-web-return-secret",
      async () => {
        const trustedReturnUrl = "https://preview.hack-cloud.test/auth/return";
        const session = {
          user: {
            id: "user-web",
            email: "web@example.com",
            emailVerified: true,
            name: "Web User",
          },
          session: {
            id: "sess-web",
            userId: "user-web",
            token: "session-token",
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        } as unknown as BetterAuthSession;

        const app = createAuthBrokerApp({
          config: createTestConfig(),
          flowStore: new FlowStore(),
          betterAuthRuntime: createBetterAuthRuntimeWithSession(session, {
            trustedOrigins: ["https://*.hack-cloud.test"],
          }),
        });

        const startResponse = await app.handle(
          new Request(
            `http://localhost/v1/auth/session/start?redirect=${encodeURIComponent(
              trustedReturnUrl
            )}`
          )
        );
        const startPayload = (
          (await startResponse.json()) as SessionStartFlowResponse
        ).flow;
        const accountResponse = await app.handle(
          new Request(
            `http://localhost/auth/account?bridge=1&flowId=${encodeURIComponent(
              startPayload.flowId
            )}&deviceCode=${encodeURIComponent(
              startPayload.deviceCode
            )}&redirect=${encodeURIComponent(trustedReturnUrl)}`
          )
        );
        const html = await accountResponse.text();
        expect(html).toContain("Connected to this Mac.");
        expect(html).toContain(trustedReturnUrl);
        expect(html).toContain("Returning to Hack");
        expect(html).toContain("window.setTimeout");
      }
    );
  });

  test("auth account page auto-returns to the routed web app when bridge redirect is supplied without a device flow", async () => {
    const session = {
      user: {
        id: "user-routed-web",
        email: "routed-web@example.com",
        emailVerified: true,
        name: "Routed Web User",
      },
      session: {
        id: "sess-routed-web",
        userId: "user-routed-web",
        token: "session-token",
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    } as unknown as BetterAuthSession;

    const app = createAuthBrokerApp({
      config: {
        ...createTestConfig(),
        publicBaseUrl: "https://auth.hack-cli.hack",
        webAppBaseUrl: "https://hack-cli.hack",
      },
      flowStore: new FlowStore(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
    });

    const response = await app.handle(
      new Request(
        `https://auth.hack-cli.hack/auth/account?bridge=1&redirect=${encodeURIComponent(
          "https://hack-cli.hack/account?org=hack"
        )}`
      )
    );
    const html = await response.text();

    expect(html).toContain("Signed in to Hack.");
    expect(html).toContain("https://hack-cli.hack/account?org=hack");
    expect(html).toContain("Returning to Hack");
    expect(html).toContain("window.setTimeout");
  });

  test("auth account page sets a shared web session cookie for the account shell", async () => {
    await withManagementTokenSecret(
      "session-auth-web-cookie-secret",
      async () => {
        const session = {
          user: {
            id: "user-cookie",
            email: "cookie@example.com",
            emailVerified: true,
            name: "Cookie User",
          },
          session: {
            id: "sess-cookie",
            userId: "user-cookie",
            token: "session-token",
            activeOrganizationId: "org-cookie",
            activeTeamId: "team-cookie",
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        } as unknown as BetterAuthSession;

        const app = createAuthBrokerApp({
          config: {
            ...createTestConfig(),
            publicBaseUrl: "https://auth.hack-cli.hack",
            webAppBaseUrl: "https://hack-cli.hack",
          },
          flowStore: new FlowStore(),
          betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
        });

        const response = await app.handle(
          new Request("https://auth.hack-cli.hack/auth/account?bridge=1")
        );

        const cookieHeader = response.headers.get("set-cookie");
        expect(cookieHeader).toContain(
          `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=`
        );
        expect(cookieHeader).toContain("Domain=hack-cli.hack");
        expect(cookieHeader).toContain("HttpOnly");
        expect(cookieHeader).toContain("SameSite=Lax");
        expect(cookieHeader).toContain("Secure");
      }
    );
  });

  test("management-token invitation list hydrates the recipient email from durable Better Auth records", async () => {
    await withManagementTokenSecret("session-auth-invites-secret", async () => {
      const ownerSession = {
        user: {
          id: "user-owner",
          email: "owner@example.com",
          emailVerified: true,
          name: "Owner User",
        },
        session: {
          id: "sess-owner",
          userId: "user-owner",
          token: "session-token",
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      } as unknown as BetterAuthSession;
      const recipientSession = {
        user: {
          id: "user-invitee",
          email: "invitee@example.com",
          emailVerified: true,
          name: "Invitee User",
        },
        session: {
          id: "sess-invitee",
          userId: "user-invitee",
          token: "recipient-session-token",
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      } as unknown as BetterAuthSession;
      const store = new InMemoryOrgTeamsStore();
      const app = createAuthBrokerApp({
        config: createTestConfig(),
        flowStore: new FlowStore(),
        betterAuthRuntime: createBetterAuthRuntimeWithSession(
          recipientSession,
          {
            getSession: (value) => {
              const headers =
                value &&
                typeof value === "object" &&
                "headers" in value &&
                value.headers instanceof Headers
                  ? value.headers
                  : null;
              return Promise.resolve(
                headers?.get("authorization") ? null : ownerSession
              );
            },
            storedUser: {
              id: "user-invitee",
              email: "invitee@example.com",
              emailVerified: true,
              name: "Invitee User",
            },
          }
        ),
        orgTeamsStore: store,
      });

      const createOrganizationResponse = await handleJsonRequest({
        app,
        method: "POST",
        path: "/v1/auth/orgs",
        body: {
          slug: "hack",
          name: "Hack",
        },
      });
      expect(createOrganizationResponse.status).toBe(200);

      const inviteResponse = await handleJsonRequest({
        app,
        method: "POST",
        path: "/v1/auth/orgs/hack/members/invite",
        body: {
          target: "invitee@example.com",
        },
      });
      expect(inviteResponse.status).toBe(200);

      const managementToken = issueBrokerManagementToken({
        userId: "user-invitee",
      });
      expect(managementToken?.token).toBeTruthy();

      const invitationsResponse = await handleJsonRequest({
        app,
        path: "/v1/auth/invitations",
        headers: {
          authorization: `Bearer ${managementToken?.token ?? ""}`,
        },
      });
      expect(invitationsResponse.status).toBe(200);

      const invitationsPayload = (await invitationsResponse.json()) as {
        readonly ok: boolean;
        readonly invitations?: ReadonlyArray<{
          readonly email?: string | null;
          readonly scope?: "organization" | "team";
          readonly status?: string;
        }>;
      };
      expect(invitationsPayload.ok).toBe(true);
      expect(invitationsPayload.invitations).toHaveLength(1);
      expect(invitationsPayload.invitations?.[0]).toMatchObject({
        email: "invitee@example.com",
        scope: "organization",
        status: "pending",
      });
    });
  });

  test("management-token /v1/auth/me hydrates emailVerified, user, and scoped names from durable Better Auth records", async () => {
    await withManagementTokenSecret("session-auth-hydrate-secret", async () => {
      const session = {
        user: {
          id: "user-hydrated",
          email: "hydrated@example.com",
          emailVerified: true,
          name: "Hydrated User",
        },
        session: {
          id: "sess-hydrated",
          userId: "user-hydrated",
          token: "session-token",
          activeOrganizationId: "org-hydrated",
          activeTeamId: "team-hydrated",
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      } as unknown as BetterAuthSession;

      const app = createAuthBrokerApp({
        config: createTestConfig(),
        flowStore: new FlowStore(),
        betterAuthRuntime: createBetterAuthRuntimeWithSession(session, {
          getSession: (value) => {
            const headers =
              value &&
              typeof value === "object" &&
              "headers" in value &&
              value.headers instanceof Headers
                ? value.headers
                : null;
            return Promise.resolve(
              headers?.get("authorization") ? null : session
            );
          },
          storedUser: {
            id: "user-hydrated",
            email: "hydrated@example.com",
            emailVerified: true,
            name: "Hydrated User",
          },
          storedOrganization: {
            id: "org-hydrated",
            name: "Hydrated Org",
          },
          storedTeam: {
            id: "team-hydrated",
            name: "Hydrated Team",
          },
        }),
      });

      const startResponse = await app.handle(
        new Request("http://localhost/v1/auth/session/start")
      );
      const startPayload = (
        (await startResponse.json()) as SessionStartFlowResponse
      ).flow;

      await app.handle(
        new Request(
          `http://localhost/auth/account?bridge=1&flowId=${encodeURIComponent(
            startPayload.flowId
          )}&deviceCode=${encodeURIComponent(startPayload.deviceCode)}`
        )
      );

      const pollResponse = await app.handle(
        new Request(
          `${startPayload.pollUrl}?deviceCode=${encodeURIComponent(startPayload.deviceCode)}&claim=1`
        )
      );
      const pollPayload = (await pollResponse.json()) as {
        readonly ok: true;
        readonly status: {
          readonly status: string;
          readonly managementToken?: string;
        };
      };

      const meResponse = await app.handle(
        new Request("http://localhost/v1/auth/me", {
          headers: {
            authorization: `Bearer ${pollPayload.status.managementToken ?? ""}`,
          },
        })
      );
      const mePayload = (await meResponse.json()) as {
        readonly ok: true;
        readonly user: {
          readonly email: string | null;
          readonly emailVerified: boolean;
          readonly name: string | null;
        } | null;
        readonly activeOrganization: {
          readonly id: string;
          readonly name: string | null;
        } | null;
        readonly activeTeam: {
          readonly id: string;
          readonly name: string | null;
        } | null;
      };

      expect(mePayload.ok).toBe(true);
      expect(mePayload.user?.email).toBe("hydrated@example.com");
      expect(mePayload.user?.emailVerified).toBe(true);
      expect(mePayload.user?.name).toBe("Hydrated User");
      expect(mePayload.activeOrganization).toEqual({
        id: "org-hydrated",
        name: "Hydrated Org",
      });
      expect(mePayload.activeTeam).toEqual({
        id: "team-hydrated",
        name: "Hydrated Team",
      });
    });
  });
});
