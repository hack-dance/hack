import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSharedBetterAuthContract } from "@hack/auth-contract";
import { drizzle } from "drizzle-orm/pglite";

import type { BetterAuthRuntime } from "../src/better-auth.ts";
import { authBrokerSchema } from "../src/db/schema.ts";
import type { createDbClient } from "../src/db.ts";
import { createAuthBrokerApp } from "../src/index.ts";
import { InMemoryOrgTeamsStore } from "../src/modules/orgs/service.ts";
import { DbProjectStore } from "../src/modules/projects/db-store.ts";
import {
  InMemoryProjectStore,
  type ProjectStore,
} from "../src/modules/projects/service.ts";

type BetterAuthAuth = NonNullable<BetterAuthRuntime["auth"]>;
type BetterAuthSession = Awaited<
  ReturnType<BetterAuthAuth["api"]["getSession"]>
>;
type AuthBrokerApp = ReturnType<typeof createAuthBrokerApp>;
type DbClient = ReturnType<typeof createDbClient>;

function createDurableProjectDb(input: { readonly dataDir: string }): DbClient {
  return drizzle({
    connection: { dataDir: input.dataDir },
    schema: authBrokerSchema,
  }) as unknown as DbClient;
}

async function withDbBackedProjectStore<Result>(input: {
  readonly orgStore: InMemoryOrgTeamsStore;
  readonly run: (helpers: {
    readonly projectStore: ProjectStore;
    readonly reopenProjectStore: () => ProjectStore;
  }) => Promise<Result>;
}): Promise<Result> {
  const dataDir = await mkdtemp(join(tmpdir(), "hack-project-admin-db-"));
  const createProjectStore = () => {
    return new DbProjectStore({
      orgStore: input.orgStore,
      db: createDurableProjectDb({ dataDir }),
    });
  };

  try {
    return await input.run({
      projectStore: createProjectStore(),
      reopenProjectStore: createProjectStore,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function createTestConfig() {
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:8080",
    flowStorePath: ".data/test-project-oauth-flows.json",
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

function createProjectTestApp(input: {
  readonly orgStore: InMemoryOrgTeamsStore;
  readonly projectStore: ProjectStore;
  readonly session?: BetterAuthSession;
}): AuthBrokerApp {
  return createAuthBrokerApp({
    config: createTestConfig(),
    betterAuthRuntime: createBetterAuthRuntimeWithSession(
      input.session ?? createSession()
    ),
    orgTeamsStore: input.orgStore,
    projectStore: input.projectStore,
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

async function createOrganization(input: {
  readonly app: AuthBrokerApp;
  readonly slug: string;
  readonly name: string;
}): Promise<void> {
  const response = await handleJsonRequest({
    app: input.app,
    method: "POST",
    path: "/v1/auth/orgs",
    body: {
      slug: input.slug,
      name: input.name,
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `Expected organization creation to succeed, received ${response.status}.`
    );
  }
}

async function createTeam(input: {
  readonly app: AuthBrokerApp;
  readonly org: string;
  readonly slug: string;
  readonly name: string;
}): Promise<void> {
  const response = await handleJsonRequest({
    app: input.app,
    method: "POST",
    path: "/v1/auth/teams",
    body: {
      org: input.org,
      slug: input.slug,
      name: input.name,
    },
  });
  if (response.status !== 200) {
    throw new Error(
      `Expected team creation to succeed, received ${response.status}.`
    );
  }
}

async function inviteAndAcceptOrganizationMember(input: {
  readonly ownerApp: AuthBrokerApp;
  readonly memberApp: AuthBrokerApp;
  readonly org: string;
  readonly email: string;
}): Promise<void> {
  const inviteResponse = await handleJsonRequest({
    app: input.ownerApp,
    method: "POST",
    path: `/v1/auth/orgs/${encodeURIComponent(input.org)}/members/invite`,
    body: {
      target: input.email,
    },
  });
  if (inviteResponse.status !== 200) {
    throw new Error(
      `Expected org invite to succeed, received ${inviteResponse.status}.`
    );
  }
  const invitePayload = (await inviteResponse.json()) as {
    readonly invitation?: { readonly id?: string };
  };
  const inviteId = invitePayload.invitation?.id;
  if (!inviteId) {
    throw new Error("Expected organization invite id.");
  }

  const acceptResponse = await handleJsonRequest({
    app: input.memberApp,
    method: "POST",
    path: `/v1/auth/invitations/${encodeURIComponent(inviteId)}/accept`,
  });
  if (acceptResponse.status !== 200) {
    throw new Error(
      `Expected invite acceptance to succeed, received ${acceptResponse.status}.`
    );
  }
}

async function registerProjectForTest(input: {
  readonly app: AuthBrokerApp;
  readonly slug: string;
  readonly name: string;
  readonly mode: "local" | "organization" | "team";
  readonly org?: string;
  readonly team?: string;
}): Promise<Response> {
  return await handleJsonRequest({
    app: input.app,
    method: "POST",
    path: "/v1/auth/projects",
    body: {
      slug: input.slug,
      name: input.name,
      mode: input.mode,
      ...(input.org ? { org: input.org } : {}),
      ...(input.team ? { team: input.team } : {}),
    },
  });
}

describe("project registration and access broker routes", () => {
  test("shared project registration persists explicit ownership and owner access", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const app = createProjectTestApp({
      orgStore,
      projectStore,
    });

    await createOrganization({
      app,
      slug: "hack",
      name: "Hack",
    });
    await createTeam({
      app,
      org: "hack",
      slug: "cli",
      name: "CLI",
    });

    const registerResponse = await handleJsonRequest({
      app,
      method: "POST",
      path: "/v1/auth/projects",
      body: {
        slug: "hack-cli",
        name: "Hack CLI",
        mode: "team",
        org: "hack",
        team: "cli",
      },
    });
    expect(registerResponse.status).toBe(200);
    const registerPayload = (await registerResponse.json()) as {
      readonly ok: boolean;
      readonly status?: string;
      readonly project?: {
        readonly slug?: string;
        readonly currentAccessRole?: string;
        readonly ownership?: {
          readonly mode?: string;
          readonly ownerType?: string;
          readonly ownerId?: string;
          readonly ownerSlug?: string | null;
          readonly ownerName?: string | null;
          readonly managedBy?: string;
        };
      };
    };
    expect(registerPayload.ok).toBe(true);
    expect(registerPayload.status).toBe("created");
    expect(registerPayload.project?.slug).toBe("hack-cli");
    expect(registerPayload.project?.currentAccessRole).toBe("owner");
    expect(registerPayload.project?.ownership).toEqual({
      mode: "shared",
      ownerType: "team",
      ownerId: expect.any(String),
      ownerSlug: "cli",
      ownerName: "CLI",
      managedBy: "broker",
    });

    const listResponse = await handleJsonRequest({
      app,
      path: "/v1/auth/projects",
    });
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as {
      readonly projects?: Record<string, unknown>[];
    };
    expect(listPayload.projects).toEqual([
      {
        slug: "hack-cli",
        name: "Hack CLI",
        currentAccessRole: "owner",
        ownership: {
          mode: "shared",
          ownerType: "team",
          ownerId: expect.any(String),
          ownerSlug: "cli",
          ownerName: "CLI",
          managedBy: "broker",
        },
        createdAt: expect.any(String),
        id: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    const accessResponse = await handleJsonRequest({
      app,
      path: "/v1/auth/projects/hack-cli/access",
    });
    expect(accessResponse.status).toBe(200);
    const accessPayload = (await accessResponse.json()) as {
      readonly access?: readonly unknown[];
    };
    expect(accessPayload.access).toEqual([]);
  });

  test("conflicting project registration returns an explicit conflict payload", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const ownerApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
      }),
    });
    const outsiderApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "outsider-user",
        email: "outsider@example.com",
      }),
    });

    await createOrganization({
      app: ownerApp,
      slug: "hack",
      name: "Hack",
    });
    await createOrganization({
      app: outsiderApp,
      slug: "ops",
      name: "Ops",
    });

    const initialRegistration = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/projects",
      body: {
        slug: "hack-cli",
        name: "Hack CLI",
        mode: "organization",
        org: "hack",
      },
    });
    expect(initialRegistration.status).toBe(200);

    const conflictingRegistration = await handleJsonRequest({
      app: outsiderApp,
      method: "POST",
      path: "/v1/auth/projects",
      body: {
        slug: "hack-cli",
        name: "Ops Console",
        mode: "organization",
        org: "ops",
      },
    });
    expect(conflictingRegistration.status).toBe(409);
    const conflictPayload = (await conflictingRegistration.json()) as {
      readonly ok: boolean;
      readonly error?: string;
      readonly existing?: {
        readonly slug?: string;
        readonly ownership?: {
          readonly mode?: string;
          readonly ownerType?: string;
          readonly ownerSlug?: string | null;
        };
      };
      readonly incoming?: {
        readonly slug?: string;
        readonly ownership?: {
          readonly mode?: string;
          readonly ownerType?: string;
          readonly ownerSlug?: string | null;
        };
      };
    };
    expect(conflictPayload.ok).toBe(false);
    expect(conflictPayload.error).toBe("project_registration_conflict");
    expect(conflictPayload.existing?.slug).toBe("hack-cli");
    expect(conflictPayload.existing?.ownership).toMatchObject({
      mode: "shared",
      ownerType: "organization",
      ownerSlug: "hack",
    });
    expect(conflictPayload.incoming?.ownership).toMatchObject({
      mode: "shared",
      ownerType: "organization",
      ownerSlug: "ops",
    });
  });

  test("explicit access grants make a team-owned project visible and revocable", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const ownerApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
      }),
    });
    const viewerApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "viewer-user",
        email: "viewer@example.com",
      }),
    });

    await createOrganization({
      app: ownerApp,
      slug: "hack",
      name: "Hack",
    });
    await createTeam({
      app: ownerApp,
      org: "hack",
      slug: "cli",
      name: "CLI",
    });
    await inviteAndAcceptOrganizationMember({
      ownerApp,
      memberApp: viewerApp,
      org: "hack",
      email: "viewer@example.com",
    });

    const registerResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/projects",
      body: {
        slug: "hack-cli",
        name: "Hack CLI",
        mode: "team",
        org: "hack",
        team: "cli",
      },
    });
    expect(registerResponse.status).toBe(200);

    const hiddenListResponse = await handleJsonRequest({
      app: viewerApp,
      path: "/v1/auth/projects",
    });
    const hiddenListPayload = (await hiddenListResponse.json()) as {
      readonly projects?: readonly unknown[];
    };
    expect(hiddenListPayload.projects).toEqual([]);

    const grantResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/projects/hack-cli/access/grant",
      body: {
        scope: "organization",
        role: "viewer",
        org: "hack",
      },
    });
    expect(grantResponse.status).toBe(200);
    const grantPayload = (await grantResponse.json()) as {
      readonly access?: {
        readonly id?: string;
        readonly role?: string;
        readonly scope?: string;
        readonly subjectSlug?: string | null;
      };
    };
    expect(grantPayload.access).toMatchObject({
      id: expect.any(String),
      role: "viewer",
      scope: "organization",
      subjectSlug: "hack",
    });

    const visibleListResponse = await handleJsonRequest({
      app: viewerApp,
      path: "/v1/auth/projects",
    });
    const visibleListPayload = (await visibleListResponse.json()) as {
      readonly projects?: Array<{
        readonly slug?: string;
        readonly currentAccessRole?: string;
      }>;
    };
    expect(visibleListPayload.projects?.[0]).toMatchObject({
      slug: "hack-cli",
      currentAccessRole: "viewer",
    });

    const accessResponse = await handleJsonRequest({
      app: ownerApp,
      path: "/v1/auth/projects/hack-cli/access",
    });
    const accessPayload = (await accessResponse.json()) as {
      readonly access?: Array<{
        readonly id?: string;
      }>;
    };
    const grantId = accessPayload.access?.[0]?.id;
    expect(grantId).toBeString();
    if (!grantId) {
      throw new Error("Expected access grant id.");
    }

    const revokeResponse = await handleJsonRequest({
      app: ownerApp,
      method: "POST",
      path: "/v1/auth/projects/hack-cli/access/revoke",
      body: {
        grantId,
      },
    });
    expect(revokeResponse.status).toBe(200);

    const hiddenAgainResponse = await handleJsonRequest({
      app: viewerApp,
      path: "/v1/auth/projects",
    });
    const hiddenAgainPayload = (await hiddenAgainResponse.json()) as {
      readonly projects?: readonly unknown[];
    };
    expect(hiddenAgainPayload.projects).toEqual([]);
  });

  test("active team scope only lists local, org-owned, and matching team-owned projects", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const setupApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
      }),
    });

    await createOrganization({
      app: setupApp,
      slug: "hack",
      name: "Hack",
    });
    await createOrganization({
      app: setupApp,
      slug: "ops",
      name: "Ops",
    });
    await createTeam({
      app: setupApp,
      org: "hack",
      slug: "cli",
      name: "CLI",
    });
    await createTeam({
      app: setupApp,
      org: "ops",
      slug: "ops",
      name: "Ops Team",
    });

    const organizationsResponse = await handleJsonRequest({
      app: setupApp,
      path: "/v1/auth/orgs",
    });
    const organizationsPayload = (await organizationsResponse.json()) as {
      readonly organizations?: Array<{
        readonly id?: string;
        readonly slug?: string;
      }>;
    };
    const hackOrganizationId = organizationsPayload.organizations?.find(
      (organization) => organization.slug === "hack"
    )?.id;
    expect(hackOrganizationId).toBeTruthy();

    const teamsResponse = await handleJsonRequest({
      app: setupApp,
      path: "/v1/auth/teams?org=hack",
    });
    const teamsPayload = (await teamsResponse.json()) as {
      readonly teams?: Array<{
        readonly id?: string;
        readonly slug?: string;
      }>;
    };
    const cliTeamId = teamsPayload.teams?.find(
      (team) => team.slug === "cli"
    )?.id;
    expect(cliTeamId).toBeTruthy();
    if (!(hackOrganizationId && cliTeamId)) {
      throw new Error("Expected scoped org/team ids.");
    }

    const scopedApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
        activeOrganizationId: hackOrganizationId,
        activeTeamId: cliTeamId,
      }),
    });

    await registerProjectForTest({
      app: setupApp,
      slug: "local-tooling",
      name: "Local Tooling",
      mode: "local",
    });
    await registerProjectForTest({
      app: setupApp,
      slug: "shared-hack",
      name: "Shared Hack",
      mode: "organization",
      org: "hack",
    });
    await registerProjectForTest({
      app: setupApp,
      slug: "cli-console",
      name: "CLI Console",
      mode: "team",
      org: "hack",
      team: "cli",
    });
    await registerProjectForTest({
      app: setupApp,
      slug: "ops-shared",
      name: "Ops Shared",
      mode: "organization",
      org: "ops",
    });
    await registerProjectForTest({
      app: setupApp,
      slug: "ops-console",
      name: "Ops Console",
      mode: "team",
      org: "ops",
      team: "ops",
    });

    const response = await handleJsonRequest({
      app: scopedApp,
      path: "/v1/auth/projects",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly projects?: Array<{
        readonly slug?: string;
      }>;
    };

    expect(payload.projects?.map((project) => project.slug)).toEqual([
      "cli-console",
      "local-tooling",
      "shared-hack",
    ]);
  });

  test("project detail returns explicit scope denial when the active context hides an otherwise visible shared project", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const setupApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
      }),
    });

    await createOrganization({
      app: setupApp,
      slug: "hack",
      name: "Hack",
    });
    await createOrganization({
      app: setupApp,
      slug: "ops",
      name: "Ops",
    });
    await createTeam({
      app: setupApp,
      org: "hack",
      slug: "cli",
      name: "CLI",
    });
    await createTeam({
      app: setupApp,
      org: "ops",
      slug: "ops",
      name: "Ops Team",
    });
    const organizationsResponse = await handleJsonRequest({
      app: setupApp,
      path: "/v1/auth/orgs",
    });
    const organizationsPayload = (await organizationsResponse.json()) as {
      readonly organizations?: Array<{
        readonly id?: string;
        readonly slug?: string;
      }>;
    };
    const hackOrganizationId = organizationsPayload.organizations?.find(
      (organization) => organization.slug === "hack"
    )?.id;
    const teamsResponse = await handleJsonRequest({
      app: setupApp,
      path: "/v1/auth/teams?org=hack",
    });
    const teamsPayload = (await teamsResponse.json()) as {
      readonly teams?: Array<{
        readonly id?: string;
        readonly slug?: string;
      }>;
    };
    const cliTeamId = teamsPayload.teams?.find(
      (team) => team.slug === "cli"
    )?.id;
    if (!(hackOrganizationId && cliTeamId)) {
      throw new Error("Expected scoped org/team ids.");
    }
    const scopedApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
        activeOrganizationId: hackOrganizationId,
        activeTeamId: cliTeamId,
      }),
    });
    await registerProjectForTest({
      app: setupApp,
      slug: "ops-console",
      name: "Ops Console",
      mode: "team",
      org: "ops",
      team: "ops",
    });

    const response = await handleJsonRequest({
      app: scopedApp,
      path: "/v1/auth/projects/ops-console",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      readonly ok?: boolean;
      readonly error?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("project_scope_forbidden");
  });

  test("project registration rejects shared ownership outside the active org or team scope", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    const projectStore = new InMemoryProjectStore({
      orgStore,
    });
    const setupApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
      }),
    });

    await createOrganization({
      app: setupApp,
      slug: "hack",
      name: "Hack",
    });
    await createOrganization({
      app: setupApp,
      slug: "ops",
      name: "Ops",
    });
    const organizationsResponse = await handleJsonRequest({
      app: setupApp,
      path: "/v1/auth/orgs",
    });
    const organizationsPayload = (await organizationsResponse.json()) as {
      readonly organizations?: Array<{
        readonly id?: string;
        readonly slug?: string;
      }>;
    };
    const hackOrganizationId = organizationsPayload.organizations?.find(
      (organization) => organization.slug === "hack"
    )?.id;
    if (!hackOrganizationId) {
      throw new Error("Expected scoped organization id.");
    }
    const scopedApp = createProjectTestApp({
      orgStore,
      projectStore,
      session: createSession({
        userId: "owner-user",
        email: "owner@example.com",
        activeOrganizationId: hackOrganizationId,
      }),
    });

    const response = await registerProjectForTest({
      app: scopedApp,
      slug: "ops-console",
      name: "Ops Console",
      mode: "organization",
      org: "ops",
    });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      readonly ok?: boolean;
      readonly error?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("project_scope_forbidden");
  });

  test("durable project store reloads registered projects after the store is recreated", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    await withDbBackedProjectStore({
      orgStore,
      async run({ projectStore, reopenProjectStore }) {
        const setupApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
          }),
        });

        await registerProjectForTest({
          app: setupApp,
          slug: "local-tooling",
          name: "Local Tooling",
          mode: "local",
        });

        const reloadedApp = createProjectTestApp({
          orgStore,
          projectStore: reopenProjectStore(),
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
          }),
        });

        const response = await handleJsonRequest({
          app: reloadedApp,
          path: "/v1/auth/projects",
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          readonly projects?: Array<{
            readonly slug?: string;
          }>;
        };

        expect(payload.projects?.map((project) => project.slug)).toEqual([
          "local-tooling",
        ]);
      },
    });
  });

  test("durable project store keeps active team scope visibility aligned with the in-memory store", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    await withDbBackedProjectStore({
      orgStore,
      async run({ projectStore }) {
        const setupApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
          }),
        });

        await createOrganization({
          app: setupApp,
          slug: "hack",
          name: "Hack",
        });
        await createOrganization({
          app: setupApp,
          slug: "ops",
          name: "Ops",
        });
        await createTeam({
          app: setupApp,
          org: "hack",
          slug: "cli",
          name: "CLI",
        });
        await createTeam({
          app: setupApp,
          org: "ops",
          slug: "ops",
          name: "Ops Team",
        });

        const organizationsResponse = await handleJsonRequest({
          app: setupApp,
          path: "/v1/auth/orgs",
        });
        const organizationsPayload = (await organizationsResponse.json()) as {
          readonly organizations?: Array<{
            readonly id?: string;
            readonly slug?: string;
          }>;
        };
        const hackOrganizationId = organizationsPayload.organizations?.find(
          (organization) => organization.slug === "hack"
        )?.id;

        const teamsResponse = await handleJsonRequest({
          app: setupApp,
          path: "/v1/auth/teams?org=hack",
        });
        const teamsPayload = (await teamsResponse.json()) as {
          readonly teams?: Array<{
            readonly id?: string;
            readonly slug?: string;
          }>;
        };
        const cliTeamId = teamsPayload.teams?.find(
          (team) => team.slug === "cli"
        )?.id;
        if (!(hackOrganizationId && cliTeamId)) {
          throw new Error("Expected durable scoped org/team ids.");
        }

        const scopedApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
            activeOrganizationId: hackOrganizationId,
            activeTeamId: cliTeamId,
          }),
        });

        await registerProjectForTest({
          app: setupApp,
          slug: "local-tooling",
          name: "Local Tooling",
          mode: "local",
        });
        await registerProjectForTest({
          app: setupApp,
          slug: "shared-hack",
          name: "Shared Hack",
          mode: "organization",
          org: "hack",
        });
        await registerProjectForTest({
          app: setupApp,
          slug: "cli-console",
          name: "CLI Console",
          mode: "team",
          org: "hack",
          team: "cli",
        });
        await registerProjectForTest({
          app: setupApp,
          slug: "ops-shared",
          name: "Ops Shared",
          mode: "organization",
          org: "ops",
        });
        await registerProjectForTest({
          app: setupApp,
          slug: "ops-console",
          name: "Ops Console",
          mode: "team",
          org: "ops",
          team: "ops",
        });

        const response = await handleJsonRequest({
          app: scopedApp,
          path: "/v1/auth/projects",
        });
        expect(response.status).toBe(200);
        const payload = (await response.json()) as {
          readonly projects?: Array<{
            readonly slug?: string;
          }>;
        };

        expect(payload.projects?.map((project) => project.slug)).toEqual([
          "cli-console",
          "local-tooling",
          "shared-hack",
        ]);
      },
    });
  });

  test("durable project store returns project_scope_forbidden when scoped detail access hides a shared project", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    await withDbBackedProjectStore({
      orgStore,
      async run({ projectStore }) {
        const setupApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
          }),
        });

        await createOrganization({
          app: setupApp,
          slug: "hack",
          name: "Hack",
        });
        await createOrganization({
          app: setupApp,
          slug: "ops",
          name: "Ops",
        });
        await createTeam({
          app: setupApp,
          org: "hack",
          slug: "cli",
          name: "CLI",
        });
        await createTeam({
          app: setupApp,
          org: "ops",
          slug: "ops",
          name: "Ops Team",
        });

        const organizationsResponse = await handleJsonRequest({
          app: setupApp,
          path: "/v1/auth/orgs",
        });
        const organizationsPayload = (await organizationsResponse.json()) as {
          readonly organizations?: Array<{
            readonly id?: string;
            readonly slug?: string;
          }>;
        };
        const hackOrganizationId = organizationsPayload.organizations?.find(
          (organization) => organization.slug === "hack"
        )?.id;
        const teamsResponse = await handleJsonRequest({
          app: setupApp,
          path: "/v1/auth/teams?org=hack",
        });
        const teamsPayload = (await teamsResponse.json()) as {
          readonly teams?: Array<{
            readonly id?: string;
            readonly slug?: string;
          }>;
        };
        const cliTeamId = teamsPayload.teams?.find(
          (team) => team.slug === "cli"
        )?.id;
        if (!(hackOrganizationId && cliTeamId)) {
          throw new Error("Expected durable scoped org/team ids.");
        }

        const scopedApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
            activeOrganizationId: hackOrganizationId,
            activeTeamId: cliTeamId,
          }),
        });

        await registerProjectForTest({
          app: setupApp,
          slug: "ops-console",
          name: "Ops Console",
          mode: "team",
          org: "ops",
          team: "ops",
        });

        const response = await handleJsonRequest({
          app: scopedApp,
          path: "/v1/auth/projects/ops-console",
        });
        expect(response.status).toBe(403);
        const payload = (await response.json()) as {
          readonly ok?: boolean;
          readonly error?: string;
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("project_scope_forbidden");
      },
    });
  });

  test("durable project store rejects shared registration outside the active org scope", async () => {
    const orgStore = new InMemoryOrgTeamsStore();
    await withDbBackedProjectStore({
      orgStore,
      async run({ projectStore }) {
        const setupApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
          }),
        });

        await createOrganization({
          app: setupApp,
          slug: "hack",
          name: "Hack",
        });
        await createOrganization({
          app: setupApp,
          slug: "ops",
          name: "Ops",
        });

        const organizationsResponse = await handleJsonRequest({
          app: setupApp,
          path: "/v1/auth/orgs",
        });
        const organizationsPayload = (await organizationsResponse.json()) as {
          readonly organizations?: Array<{
            readonly id?: string;
            readonly slug?: string;
          }>;
        };
        const hackOrganizationId = organizationsPayload.organizations?.find(
          (organization) => organization.slug === "hack"
        )?.id;
        if (!hackOrganizationId) {
          throw new Error("Expected durable scoped organization id.");
        }

        const scopedApp = createProjectTestApp({
          orgStore,
          projectStore,
          session: createSession({
            userId: "owner-user",
            email: "owner@example.com",
            activeOrganizationId: hackOrganizationId,
          }),
        });

        const response = await registerProjectForTest({
          app: scopedApp,
          slug: "ops-console",
          name: "Ops Console",
          mode: "organization",
          org: "ops",
        });
        expect(response.status).toBe(403);
        const payload = (await response.json()) as {
          readonly ok?: boolean;
          readonly error?: string;
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("project_scope_forbidden");
      },
    });
  });
});
