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

const linearManagement = {
  extensionEnabled: true,
  selectedProfile: "work",
  selectedSource: "project_routing",
  defaultProfile: "work",
  projectOverride: "work",
  selectedMissing: false,
  authRef: "linear.api.work",
  service: "hack-linear-work",
  tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
  apiUrl: "https://api.linear.app/graphql",
  accountName: "Hack User",
  tokenResolved: true,
  tokenSource: "keychain",
  profiles: [
    {
      id: "work",
      isDefault: true,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnv: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountName: "Hack User",
    },
  ],
  projectBinding: {
    profileId: "work",
    defaultProject: {
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
      label: "Default (proj_default) in team team_default",
    },
    additionalProjects: [
      {
        projectId: "proj_extra",
        projectName: "Extra",
        teamId: "team_extra",
        label: "Extra (proj_extra) in team team_extra",
      },
    ],
  },
  summary: {
    activeProfile: "work",
    connected: true,
    connectionLabel: "Connected as Hack User",
    routingSummary:
      "This repo routes Linear sync to Default (proj_default) in team team_default.",
    linkedProjectsLabel:
      "1 linked project: Extra (proj_extra) in team team_extra.",
    capabilities: [
      "Sync tickets for the bound Linear project",
      "Pull issues from 1 linked Linear project",
    ],
    repair: null,
    nextSteps: ["Run `hack linear sync-project --from linear`."],
  },
  hackConnection: {
    inspectable: true,
    loaded: true,
    connected: true,
    localAccessAvailable: true,
    accessibleConnectionCount: 1,
    ownerLabel: "team:team_123",
    accountLabel: "Hack User",
    summary: 'Hack has a broker-owned Linear connection for profile "work".',
    detail:
      "Protected local access is stored on Hack and can be reseeded onto this machine if needed.",
  },
  localAccess: {
    ready: true,
    summary: "Local Linear access is ready on this machine.",
    detail: "The active profile resolved a usable local token.",
  },
  repair: null,
  accessControlMode: "better_auth_team_owned",
  statusCommand: "./dist/hack linear status --json",
  profilesCommand: "./dist/hack linear profiles --json",
  connectionsCommand: "./dist/hack linear connections --json",
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
      linearManagement={linearManagement}
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
  expect(markup).toContain("Linear");
  expect(markup).toContain("Default route");
  expect(markup).toContain("Additional linked projects");
  expect(markup).toContain("Extra (proj_extra) in team team_extra");
  expect(markup).toContain("project_registered");
});
