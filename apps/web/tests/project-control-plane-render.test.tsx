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
  mode: "token",
  authRef: "github.app.work",
  service: "hack-github-work",
  tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
  apiBaseUrl: "https://api.github.com",
  accountLogin: "hack-dance",
  tokenResolved: true,
  tokenSource: "env",
  profiles: [
    {
      id: "work",
      isDefault: true,
      mode: "token",
      authRef: "github.app.work",
      service: "hack-github-work",
      accountLogin: "hack-dance",
    },
  ],
  readiness: {
    ready: true,
    state: "ready",
    summary: "Ready for project GitHub workflows.",
    detail: "Project routing resolves a usable GitHub profile.",
    issues: [],
    installation: {
      required: false,
      state: "not_required",
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
  selectedOrganizationVisible: true,
  requestedTeamKey: "infra",
  selectedTeamVisible: true,
  requestedProjectKey: "hack-cli",
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
  selectedOrganizationMemberships: [],
  selectedTeamMemberships: [],
  incomingInvitations: [],
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

test("account shell renders project registration and access controls", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={authenticatedContext}
      feedback={{
        tone: "success",
        title: "Project registered",
        body: "Hack stored the durable project registration.",
      }}
      githubManagement={githubManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Projects");
  expect(markup).toContain("Register project");
  expect(markup).toContain("Visible projects");
  expect(markup).toContain("Hack CLI");
  expect(markup).toContain("shared");
  expect(markup).toContain("infra");
  expect(markup).toContain("Explicit access");
  expect(markup).toContain("Grant organization access");
  expect(markup).toContain("Grant team access");
  expect(markup).toContain("project_registered");
});
