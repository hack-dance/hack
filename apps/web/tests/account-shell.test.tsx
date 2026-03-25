import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import type { AccountShellContext } from "../src/lib/account-shell";
import type { BrowserSharedProjectScopeSummary } from "../src/lib/browser-shared-project-scope";
import { buildGitHubManagementState } from "../src/lib/github-management";

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
  accountEmail: "hack@example.com",
  tokenResolved: false,
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
    connected: false,
    connectionLabel: "Not connected",
    routingSummary:
      "This repo routes Linear sync to Default (proj_default) in team team_default.",
    linkedProjectsLabel:
      "1 linked project: Extra (proj_extra) in team team_extra.",
    capabilities: ["Repair local Linear access for the active profile"],
    repair: {
      reason: "Local Linear access is missing for the active profile.",
      command: "hack linear connect --profile work",
    },
    nextSteps: ["Run `hack linear connect --profile work`."],
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
    ready: false,
    summary: "Local Linear access needs repair on this machine.",
    detail: "Local Linear access is missing for the active profile.",
  },
  repair: {
    title: "Seed local access from Hack",
    reason:
      "Hack already has protected local access for this profile; reseed it on this machine instead of reconnecting.",
    command: "hack linear seed-local-access --profile work",
  },
  accessControlMode: "better_auth_team_owned",
  audit: null,
  statusCommand: "./dist/hack linear status --json",
  profilesCommand: "./dist/hack linear profiles --json",
  connectionsCommand: "./dist/hack linear connections --json",
} as const;

const signedOutLinearManagement = {
  ...linearManagement,
  hackConnection: {
    ...linearManagement.hackConnection,
    inspectable: false,
    loaded: false,
    connected: false,
    localAccessAvailable: false,
    accessibleConnectionCount: 0,
    ownerLabel: null,
    accountLabel: "Sign in to inspect",
    summary: "Sign in to compare Hack-owned access with local Linear access.",
    detail:
      "Hack only exposes broker-owned Linear connections for the current browser account session.",
  },
} as const;

const hiddenBrowserSharedProjectScope = {
  state: "shared_hidden",
  mutable: false,
  summary: "Shared project scope denied for hack-cli.",
  detail:
    "The active team Infra does not expose the shared project registration for this repo.",
  projectSlug: "hack-cli",
  currentAccessRole: null,
  ownerType: "team",
  ownerId: "team_123",
  ownerSlug: "infra",
  ownerName: "Infra",
} as const satisfies BrowserSharedProjectScopeSummary;

const visibleBrowserSharedProjectScope = {
  state: "shared_visible",
  mutable: true,
  summary: "Shared project scope is active for hack-cli.",
  detail:
    "The active team Infra can manage shared integration resources for this repo.",
  projectSlug: "hack-cli",
  currentAccessRole: "owner",
  ownerType: "team",
  ownerId: "team_123",
  ownerSlug: "infra",
  ownerName: "Infra",
} as const satisfies BrowserSharedProjectScopeSummary;

const githubProfilesPayload = {
  projectOverride: "work",
  selectedMissing: false,
  profiles: githubManagement.profiles,
} as const;

const githubStatusPayload = {
  extensionId: "dance.hack.github",
  selectedProfile: "work",
  selectedSource: "project_routing",
  defaultProfile: "work",
  authRef: "github.app.work",
  service: "hack-github-work",
  tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
  mode: "app",
  apiBaseUrl: "https://api.github.com",
  accountLogin: "hack-dance",
  accountName: "Hack Dance",
  accountId: "github_user_123",
  installationId: "12345",
  tokenResolved: true,
  tokenSource: "env",
  ready: true,
  readiness: "ready",
  readinessSummary: "Ready for project GitHub workflows.",
  readinessDetail:
    'Project routing resolves the "work" profile with a usable token and installation 12345.',
  repairIssues: [],
  installationState: "configured",
  repairGuidance: [],
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

test("github management state fails closed when the browser shared project scope is hidden", () => {
  const state = buildGitHubManagementState({
    status: githubStatusPayload,
    profiles: githubProfilesPayload,
    browserSharedProjectScope: hiddenBrowserSharedProjectScope,
  });

  expect(state.readiness.ready).toBe(false);
  expect(state.readiness.summary).toBe(
    "Shared project scope denied for hack-cli."
  );
  expect(state.readiness.detail).toBe(
    "The active team Infra does not expose the shared project registration for this repo."
  );
  expect(state.readiness.issues).toContain("shared_scope_hidden");
  expect(state.readiness.repairGuidance).toContainEqual({
    issue: "shared_scope_hidden",
    title: "Refresh the shared project scope",
    action:
      "Switch back to a visible shared org/team context, then run `hack auth login` so repo-bound GitHub status can confirm the active shared project scope.",
  });
});

test("github management state keeps provider readiness when the browser shared project scope is visible", () => {
  const state = buildGitHubManagementState({
    status: {
      ...githubStatusPayload,
      ready: false,
      readiness: "needs_attention",
      readinessSummary: hiddenBrowserSharedProjectScope.summary,
      readinessDetail: hiddenBrowserSharedProjectScope.detail,
      repairIssues: ["shared_scope_hidden"],
      repairGuidance: [
        {
          issue: "shared_scope_hidden",
          title: "Refresh the shared project scope",
          action:
            "Switch back to a visible shared org/team context, then run `hack auth login` so repo-bound GitHub status can confirm the active shared project scope.",
        },
      ],
      sharedProjectScope: hiddenBrowserSharedProjectScope,
    },
    profiles: githubProfilesPayload,
    browserSharedProjectScope: visibleBrowserSharedProjectScope,
  });

  expect(state.readiness.ready).toBe(true);
  expect(state.readiness.summary).toBe("Ready for project GitHub workflows.");
  expect(state.readiness.detail).toContain(
    'Project routing resolves the "work" profile'
  );
  expect(state.readiness.issues).toEqual([]);
});

test("github management state derives extensionEnabled from readiness issues instead of the extension id", () => {
  const state = buildGitHubManagementState({
    status: {
      ...githubStatusPayload,
      ready: false,
      readiness: "needs_attention",
      readinessSummary: "GitHub needs repair before this repo can rely on it.",
      readinessDetail:
        "The repo has not enabled the GitHub extension yet, so project-bound status cannot rely on the real GitHub auth path.",
      repairIssues: ["extension_disabled"],
      repairGuidance: [
        {
          issue: "extension_disabled",
          title: "Enable the project GitHub extension",
          action:
            'Set `controlPlane.extensions["dance.hack.github"].enabled` to `true` in `.hack/hack.config.json` so repo-bound GitHub status and repair flows use the real auth resolver.',
        },
      ],
    },
    profiles: githubProfilesPayload,
  });

  expect(state.extensionEnabled).toBe(false);
  expect(state.readiness.issues).toEqual(["extension_disabled"]);
});

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
      linearManagement={linearManagement}
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
  expect(markup).toContain("Linear");
  expect(markup).toContain("Connected on Hack");
  expect(markup).toContain("Seed local access from Hack");
  expect(markup).toContain("Default (proj_default) in team team_default");
  expect(markup).toContain("Extra (proj_extra) in team team_extra");
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
      linearManagement={signedOutLinearManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain('href="/auth?redirect=%2Faccount"');
  expect(markup).toContain(
    "Sign in to compare Hack-owned access with local Linear access."
  );
});

test("account shell surfaces shared integration scope denial when the requested project is hidden", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={{
        ...authenticatedContext,
        requestedProjectKey: "ops-console",
        selectedProjectVisible: false,
        projects: [],
        selectedProject: null,
        selectedProjectAccess: [],
      }}
      githubManagement={githubManagement}
      linearManagement={linearManagement}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Shared project scope denied");
  expect(markup).toContain(
    "The current org/team context does not expose the requested shared project."
  );
});
