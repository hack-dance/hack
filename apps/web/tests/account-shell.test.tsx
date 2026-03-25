import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import type { AccountShellContext } from "../src/lib/account-shell";

const githubManagement = {
  extensionEnabled: true,
  selectedProfile: "work",
  selectedSource: "project_routing",
  defaultProfile: "work",
  projectOverride: "work",
  selectedMissing: false,
  mode: "app",
  authRef: "github.app.work",
  service: "hack-github-work",
  tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
  apiBaseUrl: "https://api.github.com",
  accountLogin: "hack-dance",
  accountName: "Hack Dance",
  tokenResolved: true,
  tokenSource: "keychain",
  installationId: "12345",
  profiles: [
    {
      id: "work",
      isDefault: true,
      mode: "app",
      authRef: "github.app.work",
      service: "hack-github-work",
      appId: "app_12345",
      installationId: "12345",
      accountLogin: "hack-dance",
      accountName: "Hack Dance",
    },
  ],
  readiness: {
    ready: true,
    state: "ready",
    summary: "Ready for project GitHub workflows.",
    detail:
      "Project routing resolves a usable profile, token, and installation context.",
    issues: [],
    installation: {
      required: true,
      state: "configured",
    },
    repairGuidance: [],
  },
  statusCommand: "./dist/hack x github status --json",
} as const;

const authenticatedContext = {
  authenticated: true,
  accessControlMode: "better_auth_team_owned",
  user: {
    id: "user_123",
    email: "hack@example.com",
    name: "Hack User",
  },
  activeOrganization: {
    id: "org_123",
    name: "Hack Org",
  },
  activeTeam: {
    id: "team_123",
    name: "Infra",
  },
  shellPath: "/auth",
  accountPath: "/auth/account",
  requestedOrganizationKey: "hack-org",
  requestedTeamKey: "infra",
  requestedProjectKey: "hack-cli",
  selectedOrganizationVisible: true,
  selectedTeamVisible: true,
  selectedProjectVisible: true,
  organizations: [
    {
      id: "org_123",
      slug: "hack-org",
      name: "Hack Org",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  teams: [
    {
      id: "team_123",
      slug: "infra",
      name: "Infra",
      organizationId: "org_123",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedTeam: {
    id: "team_123",
    slug: "infra",
    name: "Infra",
    organizationId: "org_123",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedOrganization: {
    id: "org_123",
    slug: "hack-org",
    name: "Hack Org",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedOrganizationMemberships: [
    {
      id: "membership_123",
      scope: "organization",
      state: "active",
      organizationId: "org_123",
      teamId: null,
      userId: "user_123",
      email: "hack@example.com",
      target: "user_123",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
    {
      id: "membership_456",
      scope: "organization",
      state: "pending",
      organizationId: "org_123",
      teamId: null,
      userId: null,
      email: "person@example.com",
      target: "person@example.com",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedTeamMemberships: [
    {
      id: "membership_789",
      scope: "team",
      state: "active",
      organizationId: "org_123",
      teamId: "team_123",
      userId: "user_123",
      email: "hack@example.com",
      target: "user_123",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
    {
      id: "membership_790",
      scope: "team",
      state: "active",
      organizationId: "org_123",
      teamId: "team_123",
      userId: "user_456",
      email: "person@example.com",
      target: "user_456",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  incomingInvitations: [
    {
      id: "invite_123",
      scope: "organization",
      organizationId: "org_789",
      teamId: null,
      email: "invitee@example.com",
      status: "pending",
      teamTargets: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  projects: [
    {
      id: "project_123",
      slug: "hack-cli",
      name: "Hack CLI",
      currentAccessRole: "owner",
      ownership: {
        mode: "shared",
        ownerType: "team",
        ownerId: "team_123",
        ownerSlug: "infra",
        ownerName: "Infra",
        managedBy: "broker",
      },
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedProject: {
    id: "project_123",
    slug: "hack-cli",
    name: "Hack CLI",
    currentAccessRole: "owner",
    ownership: {
      mode: "shared",
      ownerType: "team",
      ownerId: "team_123",
      ownerSlug: "infra",
      ownerName: "Infra",
      managedBy: "broker",
    },
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedProjectAccess: [
    {
      id: "grant_123",
      scope: "organization",
      role: "viewer",
      subjectId: "org_123",
      subjectSlug: "hack-org",
      subjectName: "Hack Org",
      organizationId: "org_123",
      teamId: null,
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
} as const satisfies AccountShellContext;

test("account shell renders the active user, org admin controls, and invite actions", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={authenticatedContext}
      feedback={{
        tone: "success",
        title: "Organization created",
        body: "Hack created the org and made you the initial active member.",
      }}
      githubManagement={githubManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Signed in context");
  expect(markup).toContain("Hack User");
  expect(markup).toContain("hack@example.com");
  expect(markup).toContain("Hack Org");
  expect(markup).toContain("Infra");
  expect(markup).toContain("better_auth_team_owned");
  expect(markup).toContain("hack auth status --json");
  expect(markup).toContain("GitHub");
  expect(markup).toContain("Ready for project GitHub workflows.");
  expect(markup).toContain("project_routing");
  expect(markup).toContain("12345");
  expect(markup).toContain("Visible organizations");
  expect(markup).toContain("Create organization");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Create team");
  expect(markup).toContain("Visible teams");
  expect(markup).toContain("Members keep their parent organization access");
  expect(markup).toContain("person@example.com");
  expect(markup).toContain("Pending recipient action");
  expect(markup).toContain("Accept invite");
  expect(markup).toContain("Organization created");
});

test("account shell fails closed with a sign-in path when no active context is available", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={{ authenticated: false }}
      githubManagement={githubManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain('href="/auth?redirect=%2Faccount"');
  expect(markup).not.toContain("Hack User");
});
