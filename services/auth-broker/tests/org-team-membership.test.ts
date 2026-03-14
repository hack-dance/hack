import { describe, expect, test } from "bun:test";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { InMemoryOrgTeamsStore } from "../src/modules/orgs/service.ts";

type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;

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

  test("org member removal cascades matching team memberships and invites to removed", async () => {
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
      new Request("http://localhost/v1/auth/teams/cli/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "user-456",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "person@example.com",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/teams/cli/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org: "hack",
          target: "person@example.com",
        }),
      })
    );

    const removeActiveResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "user-456",
        }),
      })
    );
    expect(removeActiveResponse.status).toBe(200);

    const removePendingResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "person@example.com",
        }),
      })
    );
    expect(removePendingResponse.status).toBe(200);

    const teamRemovedResponse = await ownerApp.handle(
      new Request(
        "http://localhost/v1/auth/teams/cli/members?org=hack&state=removed"
      )
    );
    expect(teamRemovedResponse.status).toBe(200);
    const removedPayload = (await teamRemovedResponse.json()) as {
      readonly memberships?: ReadonlyArray<{
        readonly target?: string;
        readonly state?: string;
      }>;
    };
    const removedTargets = new Set(
      (removedPayload.memberships ?? []).map((membership) => membership.target)
    );
    expect(removedTargets.has("user-456")).toBe(true);
    expect(removedTargets.has("person@example.com")).toBe(true);
    expect(
      (removedPayload.memberships ?? []).every(
        (membership) => membership.state === "removed"
      )
    ).toBe(true);
  });

  test("member list hides removed memberships by default and exposes them with state filters", async () => {
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
      new Request("http://localhost/v1/auth/orgs/hack/members/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "user-456",
        }),
      })
    );

    await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "user-456",
        }),
      })
    );

    const defaultListResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members")
    );
    expect(defaultListResponse.status).toBe(200);
    const defaultListPayload = (await defaultListResponse.json()) as {
      readonly memberships?: ReadonlyArray<{
        readonly target?: string;
        readonly state?: string;
      }>;
    };
    expect(
      (defaultListPayload.memberships ?? []).some(
        (membership) => membership.target === "user-456"
      )
    ).toBe(false);
    expect(
      (defaultListPayload.memberships ?? []).every(
        (membership) =>
          membership.state === "pending" || membership.state === "active"
      )
    ).toBe(true);

    const removedListResponse = await ownerApp.handle(
      new Request("http://localhost/v1/auth/orgs/hack/members?state=removed")
    );
    expect(removedListResponse.status).toBe(200);
    const removedListPayload = (await removedListResponse.json()) as {
      readonly memberships?: ReadonlyArray<{
        readonly target?: string;
        readonly state?: string;
      }>;
    };
    expect(
      (removedListPayload.memberships ?? []).some(
        (membership) =>
          membership.target === "user-456" && membership.state === "removed"
      )
    ).toBe(true);
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
});
