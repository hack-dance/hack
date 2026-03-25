import { describe, expect, test } from "bun:test";

import { createSharedBetterAuthContract } from "@hack/auth-contract";

import {
  createDefaultOrgTeamsStore,
  resolveDefaultOrgTeamsStore,
} from "../src/app.ts";
import type { BetterAuthRuntime } from "../src/better-auth.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { DbOrgTeamsStore } from "../src/modules/orgs/db-store.ts";
import { InMemoryOrgTeamsStore } from "../src/modules/orgs/service.ts";
import {
  installAuthBrokerEnvIsolation,
  withIsolatedAuthBrokerEnv,
} from "./test-env.ts";

type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;
type AuthBrokerApp = ReturnType<typeof createAuthBrokerApp>;

installAuthBrokerEnvIsolation();

test("default org/team store makes development-only in-memory mode explicit when DATABASE_URL is not configured", () => {
  withIsolatedAuthBrokerEnv(
    {
      DATABASE_URL: undefined,
    },
    () => {
      const { mode, store } = resolveDefaultOrgTeamsStore();
      expect(store).toBeInstanceOf(InMemoryOrgTeamsStore);
      expect(mode.kind).toBe("in_memory_dev_only");
      expect(mode.startupMessage).toContain("development-only in-memory mode");
      expect(mode.startupMessage).toContain("DATABASE_URL is not configured");
    }
  );
});

test("default org/team store uses durable database storage when DATABASE_URL is configured", () => {
  withIsolatedAuthBrokerEnv(
    {
      DATABASE_URL: "postgresql://user:pass@example.com/hack",
    },
    () => {
      const { mode, store } = resolveDefaultOrgTeamsStore();
      expect(store).toBeInstanceOf(DbOrgTeamsStore);
      expect(mode.kind).toBe("durable_database");
      expect(mode.startupMessage).toContain("durable database-backed mode");
    }
  );
});

test("default org/team store does not silently fall back to in-memory when durable setup fails", () => {
  withIsolatedAuthBrokerEnv(
    {
      DATABASE_URL: "postgresql://user:pass@example.com/hack",
    },
    () => {
      expect(() =>
        createDefaultOrgTeamsStore({
          createDbStore() {
            throw new Error("boom");
          },
        })
      ).toThrow(
        "Failed to initialize durable org/team store from DATABASE_URL."
      );
    }
  );
});

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
  session: BetterAuthSession
): BetterAuthRuntime {
  return {
    enabled: true,
    contract: createSharedBetterAuthContract({
      socialProviders: [{ id: "github", label: "GitHub" }],
      publicBaseUrl: createTestConfig().publicBaseUrl,
      localDevHost: "hack-cli.hack",
      trustedOrigins: ["https://hack-cli-preview.vercel.app"],
    }),
    auth: {
      api: {
        getSession: async () => session,
      },
    } as unknown as BetterAuthAuth["api"],
  } as unknown as BetterAuthRuntime;
}

function createSession(input?: {
  readonly userId?: string;
  readonly email?: string;
  readonly activeOrganizationId?: string;
  readonly activeTeamId?: string;
}): BetterAuthSession {
  return {
    user: {
      id: input?.userId ?? "user-123",
      email: input?.email ?? "hack@example.com",
      emailVerified: true,
      name: "Hack User",
    },
    session: {
      id: "sess-123",
      userId: input?.userId ?? "user-123",
      token: "session-token",
      activeOrganizationId: input?.activeOrganizationId ?? null,
      activeTeamId: input?.activeTeamId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  } as unknown as BetterAuthSession;
}

function createOrgTeamsTestApp(input: {
  readonly store: InMemoryOrgTeamsStore;
  readonly session?: BetterAuthSession;
}): AuthBrokerApp {
  return createAuthBrokerApp({
    config: createTestConfig(),
    betterAuthRuntime: createBetterAuthRuntimeWithSession(
      input.session ?? createSession()
    ),
    orgTeamsStore: input.store,
  });
}

async function handleJsonRequest(input: {
  readonly app: AuthBrokerApp;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
}): Promise<Response> {
  const hasBody = typeof input.body !== "undefined";
  return await input.app.handle(
    new Request(`http://localhost${input.path}`, {
      method: input.method ?? "GET",
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(input.body) : undefined,
    })
  );
}

async function inviteMemberAndGetId(input: {
  readonly app: AuthBrokerApp;
  readonly path: string;
  readonly body: unknown;
}): Promise<string> {
  const response = await handleJsonRequest({
    app: input.app,
    method: "POST",
    path: input.path,
    body: input.body,
  });
  if (response.status !== 200) {
    throw new Error(
      `Expected invite request to succeed, received ${response.status}.`
    );
  }
  const payload = (await response.json()) as {
    readonly invitation?: { readonly id?: string };
  };
  const inviteId = payload.invitation?.id;
  if (!inviteId) {
    throw new Error("Expected invite id.");
  }
  return inviteId;
}

async function acceptInvitation(input: {
  readonly app: AuthBrokerApp;
  readonly inviteId: string;
}): Promise<void> {
  const response = await handleJsonRequest({
    app: input.app,
    method: "POST",
    path: `/v1/auth/invitations/${input.inviteId}/accept`,
  });
  if (response.status !== 200) {
    throw new Error(
      `Expected invitation acceptance to succeed, received ${response.status}.`
    );
  }
  const payload = (await response.json()) as {
    readonly membership?: { readonly state?: string };
  };
  if (payload.membership?.state !== "active") {
    throw new Error("Expected invitation acceptance to activate membership.");
  }
}

async function seedAcceptedOrgAndTeamMember(input: {
  readonly memberUserId: string;
  readonly memberEmail: string;
}): Promise<{
  readonly ownerApp: AuthBrokerApp;
  readonly memberApp: AuthBrokerApp;
}> {
  const store = new InMemoryOrgTeamsStore();
  const ownerApp = createOrgTeamsTestApp({ store });
  const memberApp = createOrgTeamsTestApp({
    store,
    session: createSession({
      userId: input.memberUserId,
      email: input.memberEmail,
    }),
  });

  const createOrgResponse = await handleJsonRequest({
    app: ownerApp,
    method: "POST",
    path: "/v1/auth/orgs",
    body: { slug: "hack", name: "Hack" },
  });
  if (createOrgResponse.status !== 200) {
    throw new Error(
      `Expected org creation to succeed, received ${createOrgResponse.status}.`
    );
  }

  const createTeamResponse = await handleJsonRequest({
    app: ownerApp,
    method: "POST",
    path: "/v1/auth/teams",
    body: { slug: "cli", org: "hack", name: "CLI" },
  });
  if (createTeamResponse.status !== 200) {
    throw new Error(
      `Expected team creation to succeed, received ${createTeamResponse.status}.`
    );
  }

  const orgInviteId = await inviteMemberAndGetId({
    app: ownerApp,
    path: "/v1/auth/orgs/hack/members/invite",
    body: { target: input.memberEmail },
  });
  await acceptInvitation({ app: memberApp, inviteId: orgInviteId });

  const teamInviteId = await inviteMemberAndGetId({
    app: ownerApp,
    path: "/v1/auth/teams/cli/members/invite",
    body: { org: "hack", target: input.memberEmail },
  });
  await acceptInvitation({ app: memberApp, inviteId: teamInviteId });

  return { ownerApp, memberApp };
}

describe("org and team membership broker routes", () => {
  test("org create and list return active ownership for the creator", async () => {
    const store = new InMemoryOrgTeamsStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(createSession()),
      orgTeamsStore: store,
    });

    const createResponse = await app.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      readonly ok: boolean;
      readonly organization?: { readonly slug?: string };
      readonly membership?: { readonly state?: string };
    };
    expect(created.ok).toBe(true);
    expect(created.organization?.slug).toBe("hack");
    expect(created.membership?.state).toBe("active");

    const listResponse = await app.handle(
      new Request("http://localhost/v1/auth/orgs")
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      readonly organizations?: ReadonlyArray<{ readonly slug?: string }>;
    };
    expect(
      listed.organizations?.map((organization) => organization.slug)
    ).toEqual(["hack"]);
  });

  test("team create, invite, and remove follow the expected state transitions", async () => {
    const store = new InMemoryOrgTeamsStore();
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(createSession()),
      orgTeamsStore: store,
    });

    await app.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );

    const createTeamResponse = await app.handle(
      new Request("http://localhost/v1/auth/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "cli",
          org: "hack",
          name: "CLI",
        }),
      })
    );
    expect(createTeamResponse.status).toBe(200);

    const addOrgMemberResponse = await app.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "person@example.com",
        }),
      })
    );
    expect(addOrgMemberResponse.status).toBe(200);

    const inviteResponse = await app.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "person@example.com",
        }),
      })
    );
    expect(inviteResponse.status).toBe(200);
    const invitePayload = (await inviteResponse.json()) as {
      readonly membership?: { readonly state?: string };
    };
    expect(invitePayload.membership?.state).toBe("pending");

    const removeResponse = await app.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "person@example.com",
        }),
      })
    );
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as {
      readonly membership?: { readonly state?: string };
    };
    expect(removed.membership?.state).toBe("removed");
  });

  test("org and team admin routes reject callers who are not active org members", async () => {
    const store = new InMemoryOrgTeamsStore();
    const ownerApp = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(createSession()),
      orgTeamsStore: store,
    });

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );

    const outsiderApp = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        createSession({
          userId: "user-999",
          email: "outsider@example.com",
        })
      ),
      orgTeamsStore: store,
    });

    const createTeamResponse = await outsiderApp.handle(
      new Request("http://localhost/v1/auth/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "cli",
          org: "hack",
          name: "CLI",
        }),
      })
    );
    expect(createTeamResponse.status).toBe(404);

    const listMembersResponse = await outsiderApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members")
    );
    expect(listMembersResponse.status).toBe(404);
  });

  test("active org members cannot administer teams without direct team membership", async () => {
    const store = new InMemoryOrgTeamsStore();
    const ownerApp = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(createSession()),
      orgTeamsStore: store,
    });

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "cli",
          org: "hack",
          name: "CLI",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "user-456",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "user-789",
        }),
      })
    );

    const orgMemberApp = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(
        createSession({
          userId: "user-456",
          email: "org-member@example.com",
        })
      ),
      orgTeamsStore: store,
    });

    const listTeamsResponse = await orgMemberApp.handle(
      new Request("http://localhost/v1/auth/teams?org=hack")
    );
    expect(listTeamsResponse.status).toBe(200);
    const listedTeams = (await listTeamsResponse.json()) as {
      readonly teams?: ReadonlyArray<{ readonly slug?: string }>;
    };
    expect(listedTeams.teams).toEqual([]);

    const addTeamMemberResponse = await orgMemberApp.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "user-789",
        }),
      })
    );
    expect(addTeamMemberResponse.status).toBe(404);
  });

  test("team membership changes require an active parent org membership", async () => {
    const store = new InMemoryOrgTeamsStore();
    const ownerApp = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(createSession()),
      orgTeamsStore: store,
    });

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "cli",
          org: "hack",
          name: "CLI",
        }),
      })
    );

    const addResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "user-456",
        }),
      })
    );
    expect(addResponse.status).toBe(409);

    const inviteResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "person@example.com",
        }),
      })
    );
    expect(inviteResponse.status).toBe(409);
  });

  test("recipient invitation accept and decline are scoped to the signed-in email", async () => {
    const store = new InMemoryOrgTeamsStore();
    const session = createSession({
      userId: "user-123",
      email: "person@example.com",
    });
    const app = createAuthBrokerApp({
      config: createTestConfig(),
      betterAuthRuntime: createBetterAuthRuntimeWithSession(session),
      orgTeamsStore: store,
    });

    await app.handle(
      new Request("http://localhost/v1/auth/orgs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "hack",
          name: "Hack",
        }),
      })
    );

    const inviteResponse = await app.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "person@example.com",
        }),
      })
    );
    const invitePayload = (await inviteResponse.json()) as {
      readonly invitation?: { readonly id?: string };
    };
    const inviteId = invitePayload.invitation?.id;
    expect(typeof inviteId).toBe("string");
    if (!inviteId) {
      return;
    }

    const listResponse = await app.handle(
      new Request("http://localhost/v1/auth/invitations")
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      readonly invitations?: ReadonlyArray<{ readonly id?: string }>;
    };
    expect(listed.invitations?.[0]?.id).toBe(inviteId);

    const acceptResponse = await app.handle(
      new Request(`http://localhost/v1/auth/invitations/${inviteId}/accept`, {
        method: "POST",
      })
    );
    expect(acceptResponse.status).toBe(200);
    const accepted = (await acceptResponse.json()) as {
      readonly membership?: { readonly state?: string };
    };
    expect(accepted.membership?.state).toBe("active");

    const secondInviteResponse = await app.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "person@example.com",
        }),
      })
    );
    const secondInvitePayload = (await secondInviteResponse.json()) as {
      readonly invitation?: { readonly id?: string };
    };
    const secondInviteId = secondInvitePayload.invitation?.id;
    expect(typeof secondInviteId).toBe("string");
    if (!secondInviteId) {
      return;
    }

    const declineResponse = await app.handle(
      new Request(
        `http://localhost/v1/auth/invitations/${secondInviteId}/decline`,
        {
          method: "POST",
        }
      )
    );
    expect(declineResponse.status).toBe(200);
    const declined = (await declineResponse.json()) as {
      readonly membership?: { readonly state?: string };
    };
    expect(declined.membership?.state).toBe("removed");
  });

  test("pending org invites can be revoked before acceptance and disappear for admins and recipients", async () => {
    const store = new InMemoryOrgTeamsStore();
    const ownerApp = createOrgTeamsTestApp({ store });
    const recipientApp = createOrgTeamsTestApp({
      store,
      session: createSession({
        userId: "user-456",
        email: "person@example.com",
      }),
    });

    const createOrgResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/orgs",
      body: {
        slug: "hack",
        name: "Hack",
      },
    });
    expect(createOrgResponse.status).toBe(200);

    const inviteId = await inviteMemberAndGetId({
      app: ownerApp,
      path: "/v1/auth/orgs/hack/members/invite",
      body: {
        target: "person@example.com",
      },
    });

    const adminMembersBeforeRevoke = await handleJsonRequest({
      app: ownerApp,
      path: "/v1/auth/orgs/hack/members",
    });
    expect(adminMembersBeforeRevoke.status).toBe(200);
    const adminMembersBeforePayload =
      (await adminMembersBeforeRevoke.json()) as {
        readonly memberships?: ReadonlyArray<{
          readonly id?: string;
          readonly state?: string;
        }>;
      };
    expect(adminMembersBeforePayload.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: inviteId,
          state: "pending",
        }),
      ])
    );

    const recipientInvitationsBeforeRevoke = await handleJsonRequest({
      app: recipientApp,
      path: "/v1/auth/invitations",
    });
    expect(recipientInvitationsBeforeRevoke.status).toBe(200);
    const recipientInvitationsBeforePayload =
      (await recipientInvitationsBeforeRevoke.json()) as {
        readonly invitations?: ReadonlyArray<{
          readonly id?: string;
        }>;
      };
    expect(
      recipientInvitationsBeforePayload.invitations?.map((invitation) => {
        return invitation.id;
      })
    ).toEqual([inviteId]);

    const removeResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/orgs/hack/members/remove",
      body: {
        target: "person@example.com",
      },
    });
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as {
      readonly membership?: {
        readonly state?: string;
        readonly target?: string;
        readonly email?: string | null;
      };
    };
    expect(removed.membership?.state).toBe("removed");
    expect(removed.membership?.target).toBe("person@example.com");
    expect(removed.membership?.email).toBe("person@example.com");

    const adminMembersAfterRevoke = await handleJsonRequest({
      app: ownerApp,
      path: "/v1/auth/orgs/hack/members",
    });
    expect(adminMembersAfterRevoke.status).toBe(200);
    const adminMembersAfterPayload = (await adminMembersAfterRevoke.json()) as {
      readonly memberships?: ReadonlyArray<{
        readonly id?: string;
        readonly state?: string;
      }>;
    };
    expect(adminMembersAfterPayload.memberships).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          id: inviteId,
        }),
      ])
    );
    expect(adminMembersAfterPayload.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "active",
        }),
      ])
    );

    const recipientInvitationsAfterRevoke = await handleJsonRequest({
      app: recipientApp,
      path: "/v1/auth/invitations",
    });
    expect(recipientInvitationsAfterRevoke.status).toBe(200);
    const recipientInvitationsAfterPayload =
      (await recipientInvitationsAfterRevoke.json()) as {
        readonly invitations?: ReadonlyArray<{
          readonly id?: string;
        }>;
      };
    expect(recipientInvitationsAfterPayload.invitations).toEqual([]);

    const acceptAfterRevokeResponse = await handleJsonRequest({
      app: recipientApp,
      method: "POST",
      path: `/v1/auth/invitations/${inviteId}/accept`,
    });
    expect(acceptAfterRevokeResponse.status).toBe(404);
  });

  test("accepted org members can be removed by email and immediately lose org and team access", async () => {
    const { ownerApp, memberApp } = await seedAcceptedOrgAndTeamMember({
      memberUserId: "user-recipient",
      memberEmail: "person@example.com",
    });

    const teamBeforeRemovalResponse = await handleJsonRequest({
      app: memberApp,
      path: "/v1/auth/teams/cli?org=hack",
    });
    expect(teamBeforeRemovalResponse.status).toBe(200);

    const createTeamBeforeRemovalResponse = await handleJsonRequest({
      app: memberApp,
      method: "POST",
      path: "/v1/auth/teams",
      body: { slug: "docs", org: "hack", name: "Docs" },
    });
    expect(createTeamBeforeRemovalResponse.status).toBe(200);

    const removeResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/orgs/hack/members/remove",
      body: { target: "person@example.com" },
    });
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as {
      readonly membership?: {
        readonly state?: string;
        readonly target?: string;
        readonly email?: string | null;
      };
    };
    expect(removed.membership?.state).toBe("removed");
    expect(removed.membership?.target).toBe("user-recipient");
    expect(removed.membership?.email).toBe("person@example.com");

    const createTeamAfterRemovalResponse = await handleJsonRequest({
      app: memberApp,
      method: "POST",
      path: "/v1/auth/teams",
      body: { slug: "support", org: "hack", name: "Support" },
    });
    expect(createTeamAfterRemovalResponse.status).toBe(404);

    const teamAfterRemovalResponse = await handleJsonRequest({
      app: memberApp,
      path: "/v1/auth/teams/cli?org=hack",
    });
    expect(teamAfterRemovalResponse.status).toBe(404);
  });

  test("accepted team members can still be removed by user id while keeping parent org access", async () => {
    const { ownerApp, memberApp } = await seedAcceptedOrgAndTeamMember({
      memberUserId: "user-teammate",
      memberEmail: "teammate@example.com",
    });

    const removeResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/teams/cli/members/remove",
      body: { org: "hack", target: "user-teammate" },
    });
    expect(removeResponse.status).toBe(200);
    const removed = (await removeResponse.json()) as {
      readonly membership?: {
        readonly state?: string;
        readonly target?: string;
        readonly email?: string | null;
      };
    };
    expect(removed.membership?.state).toBe("removed");
    expect(removed.membership?.target).toBe("user-teammate");
    expect(removed.membership?.email).toBe("teammate@example.com");

    const teamAfterRemovalResponse = await handleJsonRequest({
      app: memberApp,
      path: "/v1/auth/teams/cli?org=hack",
    });
    expect(teamAfterRemovalResponse.status).toBe(404);

    const createTeamAfterRemovalResponse = await handleJsonRequest({
      app: memberApp,
      method: "POST",
      path: "/v1/auth/teams",
      body: { slug: "design", org: "hack", name: "Design" },
    });
    expect(createTeamAfterRemovalResponse.status).toBe(200);
  });
});
