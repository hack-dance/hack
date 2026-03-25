import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import LinearManagementSection from "../src/components/linear-management-section";
import type { BrowserSharedProjectScopeSummary } from "../src/lib/browser-shared-project-scope";
import {
  buildLinearCommandEnvironment,
  buildLinearManagementState,
} from "../src/lib/linear-management";

test("linear management command environment prefers env-only token lookup unless explicitly overridden", () => {
  expect(buildLinearCommandEnvironment({ env: {} })).toMatchObject({
    HACK_LINEAR_PREFER_ENV_TOKEN_ONLY: "true",
  });
  expect(
    buildLinearCommandEnvironment({
      env: {
        CUSTOM_VALUE: "kept",
        HACK_LINEAR_PREFER_ENV_TOKEN_ONLY: "false",
      },
    })
  ).toMatchObject({
    CUSTOM_VALUE: "kept",
    HACK_LINEAR_PREFER_ENV_TOKEN_ONLY: "false",
  });
});

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

function buildEnvOnlyRepairManagementState(input: {
  readonly includeHackConnection: boolean;
  readonly localAccessAvailable?: boolean;
  readonly browserSharedProjectScope?: BrowserSharedProjectScopeSummary | null;
  readonly statusSharedProjectScope?: BrowserSharedProjectScopeSummary | null;
}) {
  return buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: null,
      accountName: null,
      accountEmail: null,
      tokenResolved: false,
      tokenSource: null,
      tokenExpiresAt: null,
      error:
        'Missing Linear token for profile "work" while HACK_LINEAR_PREFER_ENV_TOKEN_ONLY=true. Set HACK_LINEAR_API_TOKEN, or unset HACK_LINEAR_PREFER_ENV_TOKEN_ONLY to allow saved local access.',
      profileError: null,
      ok: false,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [],
      },
      summary: {
        activeProfile: "work",
        connected: false,
        connectionLabel: "Not connected",
        routingSummary:
          "This repo routes Linear sync to Default (proj_default) in team team_default.",
        linkedProjectsLabel: null,
        capabilities: ["Repair local Linear access for the active profile"],
        repair: {
          reason:
            "Env-only Linear access is enabled but the token env var is missing.",
          command: "export HACK_LINEAR_API_TOKEN=<linear-token>",
        },
        nextSteps: [
          "Run `export HACK_LINEAR_API_TOKEN=<linear-token>`.",
        ] as const,
      },
      ...(input.statusSharedProjectScope
        ? { sharedProjectScope: input.statusSharedProjectScope }
        : {}),
    },
    profiles: {
      defaultProfileId: "default",
      selectedProfileId: "work",
      selectedProfileSource: "project_routing",
      selectedProfileMissing: false,
      projectProfileOverride: "work",
      profiles: [
        {
          id: "work",
          isDefault: false,
          authRef: "linear.api.work",
          service: "hack-linear-work",
          tokenEnv: "HACK_LINEAR_WORK_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
          accountName: "Hack User",
        },
      ],
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: input.includeHackConnection
        ? [
            {
              id: "connection_123",
              profileId: "work",
              accountId: "lin-user-1",
              accountName: "Hack User",
              accountEmail: "hack@example.com",
              authRef: "linear.api.work",
              betterAuthUserId: "user-123",
              betterAuthOrganizationId: "org-123",
              betterAuthTeamId: "team-123",
              organizationId: "lin-org-1",
              teamId: "lin-team-1",
              localAccessAvailable: input.localAccessAvailable ?? false,
              metadata: {},
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ]
        : [],
    },
    canInspectHackConnection: true,
    ...(input.browserSharedProjectScope
      ? { browserSharedProjectScope: input.browserSharedProjectScope }
      : {}),
  });
}
test("linear management state prefers seeded local repair when Hack already holds local access", () => {
  const state = buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      tokenResolved: false,
      tokenSource: null,
      tokenExpiresAt: null,
      error: 'Missing Linear token for profile "work".',
      profileError: null,
      ok: false,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [
          {
            profileId: "work",
            projectId: "proj_default",
            projectName: "Duplicate default",
            teamId: "team_default",
          },
          {
            profileId: "work",
            projectId: "proj_extra",
            projectName: "Extra",
            teamId: "team_extra",
          },
          {
            profileId: "work",
            projectId: "proj_extra",
            projectName: "Duplicate extra",
            teamId: "team_extra",
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
          "2 linked projects: Duplicate default (proj_default), Duplicate extra (proj_extra) in team team_extra.",
        capabilities: ["Repair local Linear access for the active profile"],
        repair: {
          reason: "Local Linear access is missing for the active profile.",
          command: "hack linear connect --profile work",
        },
        nextSteps: ["Run `hack linear connect --profile work`."],
      },
    },
    profiles: {
      defaultProfileId: "default",
      selectedProfileId: "work",
      selectedProfileSource: "project_routing",
      selectedProfileMissing: false,
      projectProfileOverride: "work",
      profiles: [
        {
          id: "default",
          isDefault: true,
          authRef: "linear.api.default",
          service: "hack-linear-auth",
          tokenEnv: "HACK_LINEAR_API_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
          accountName: "Default User",
        },
        {
          id: "work",
          isDefault: false,
          authRef: "linear.api.work",
          service: "hack-linear-work",
          tokenEnv: "HACK_LINEAR_WORK_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
          accountName: "Hack User",
        },
      ],
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [
        {
          id: "connection_123",
          profileId: "work",
          accountId: "lin-user-1",
          accountName: "Hack User",
          accountEmail: "hack@example.com",
          authRef: "linear.api.work",
          betterAuthUserId: "user-123",
          betterAuthOrganizationId: "org-123",
          betterAuthTeamId: "team-123",
          organizationId: "lin-org-1",
          teamId: "lin-team-1",
          localAccessAvailable: true,
          metadata: {},
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
      ],
    },
    canInspectHackConnection: true,
  });

  expect(state.repair).toEqual({
    title: "Seed local access from Hack",
    reason:
      "Hack already has protected local access for this profile; reseed it on this machine instead of reconnecting.",
    command: "hack linear seed-local-access --profile work",
  });
  expect(state.hackConnection.connected).toBe(true);
  expect(state.hackConnection.ownerLabel).toBe("team:team-123");
  expect(state.projectBinding.defaultProject?.label).toBe(
    "Default (proj_default) in team team_default"
  );
  expect(
    state.projectBinding.additionalProjects.map((project) => project.label)
  ).toEqual(["Extra (proj_extra) in team team_extra"]);
});

test("linear management state offers a Hack claim repair when local access works without a Hack-owned connection", () => {
  const state = buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "command_flags",
      defaultProfile: "work",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      tokenResolved: true,
      tokenSource: "keychain",
      tokenExpiresAt: null,
      error: null,
      profileError: null,
      ok: true,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: null,
        projectName: null,
        teamId: null,
        additionalProjects: [],
      },
      summary: {
        activeProfile: "work",
        connected: true,
        connectionLabel: "Connected as Hack User",
        routingSummary:
          "This repo does not have a default Linear project route yet.",
        linkedProjectsLabel: null,
        capabilities: [
          "Bind this repo to a Linear project before project sync",
        ],
        repair: null,
        nextSteps: [
          "Run `hack linear project-bind --profile work --project-id <linear-project-id>`.",
        ],
      },
    },
    profiles: {
      defaultProfileId: "work",
      selectedProfileId: "work",
      selectedProfileSource: "global_default",
      selectedProfileMissing: false,
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
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [],
    },
    canInspectHackConnection: true,
  });

  expect(state.hackConnection.connected).toBe(false);
  expect(state.localAccess.ready).toBe(true);
  expect(state.repair).toEqual({
    title: "Connect this profile on Hack",
    reason:
      "This machine can use Linear, but Hack does not have a broker-owned connection for the active profile yet.",
    command: "hack linear connect --profile work",
  });
});

test("linear management state prefers Hack reseed over env-only repair when Hack already holds local access", () => {
  const state = buildEnvOnlyRepairManagementState({
    includeHackConnection: true,
    localAccessAvailable: true,
  });

  expect(state.repair).toEqual({
    title: "Seed local access from Hack",
    reason:
      "Hack already has protected local access for this profile; reseed it on this machine instead of reconnecting.",
    command: "hack linear seed-local-access --profile work",
  });
});

test("linear management state prefers reconnect over env-only repair when Hack owns the profile without reseedable local access", () => {
  const state = buildEnvOnlyRepairManagementState({
    includeHackConnection: true,
    localAccessAvailable: false,
  });

  expect(state.repair).toEqual({
    title: "Reconnect local Linear access",
    reason:
      "Hack already knows this profile, but this machine still needs fresh protected local access stored locally.",
    command: "hack linear connect --profile work",
  });
});

test("linear management state keeps env-token repair when Hack does not own the active profile", () => {
  const state = buildEnvOnlyRepairManagementState({
    includeHackConnection: false,
  });

  expect(state.repair).toEqual({
    title: "Set the env token",
    reason:
      "Env-only Linear access is enabled but the token env var is missing.",
    command: "export HACK_LINEAR_API_TOKEN=<linear-token>",
  });
});

test("linear management state fails closed when the browser shared project scope is hidden", () => {
  const state = buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      tokenResolved: true,
      tokenSource: "env",
      tokenExpiresAt: null,
      error: null,
      profileError: null,
      ok: true,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [],
      },
      summary: {
        activeProfile: "work",
        connected: true,
        connectionLabel: "Connected as Hack User",
        routingSummary:
          "This repo routes Linear sync to Default (proj_default) in team team_default.",
        linkedProjectsLabel: null,
        capabilities: ["Sync tickets for the bound Linear project"],
        repair: null,
        nextSteps: ["Run `hack linear sync-project --from linear`."],
      },
    },
    profiles: {
      defaultProfileId: "default",
      selectedProfileId: "work",
      selectedProfileSource: "project_routing",
      selectedProfileMissing: false,
      profiles: [
        {
          id: "work",
          isDefault: false,
          authRef: "linear.api.work",
          service: "hack-linear-work",
          tokenEnv: "HACK_LINEAR_WORK_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
          accountName: "Hack User",
        },
      ],
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [
        {
          id: "connection_123",
          profileId: "work",
          accountId: "lin-user-1",
          accountName: "Hack User",
          accountEmail: "hack@example.com",
          authRef: "linear.api.work",
          betterAuthUserId: "user-123",
          betterAuthOrganizationId: "org-123",
          betterAuthTeamId: "team-123",
          organizationId: "lin-org-1",
          teamId: "lin-team-1",
          localAccessAvailable: true,
          metadata: {},
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
      ],
    },
    canInspectHackConnection: true,
    browserSharedProjectScope: hiddenBrowserSharedProjectScope,
  });

  expect(state.summary.connected).toBe(false);
  expect(state.summary.connectionLabel).toBe("Scope denied");
  expect(state.hackConnection.summary).toBe(
    "Shared project scope denied for hack-cli."
  );
  expect(state.localAccess.ready).toBe(false);
  expect(state.repair).toEqual({
    title: "Refresh Hack account access",
    reason:
      "The active team Infra does not expose the shared project registration for this repo.",
    command: "hack auth login",
  });
});

test("linear management state keeps provider repair details when the browser shared project scope is visible", () => {
  const state = buildEnvOnlyRepairManagementState({
    includeHackConnection: false,
    browserSharedProjectScope: visibleBrowserSharedProjectScope,
    statusSharedProjectScope: hiddenBrowserSharedProjectScope,
  });

  expect(state.summary.connected).toBe(false);
  expect(state.summary.connectionLabel).toBe("Not connected");
  expect(state.repair).toEqual({
    title: "Set the env token",
    reason:
      "Env-only Linear access is enabled but the token env var is missing.",
    command: "export HACK_LINEAR_API_TOKEN=<linear-token>",
  });
});

test("linear management section renders durable publish and delivery audit state", () => {
  const state = buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      tokenResolved: true,
      tokenSource: "keychain",
      tokenExpiresAt: null,
      error: null,
      profileError: null,
      ok: true,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [],
      },
      summary: {
        activeProfile: "work",
        connected: true,
        connectionLabel: "Connected as Hack User",
        routingSummary:
          "This repo routes Linear sync to Default (proj_default) in team team_default.",
        linkedProjectsLabel: null,
        capabilities: ["Publish repo-bound status updates"],
        repair: null,
        nextSteps: ["Run `hack linear status-updates publish`."],
      },
      audit: {
        statusUpdates: {
          draftCount: 1,
          publishedCount: 2,
          latestPublished: {
            title: "Weekly update",
            linearId: "update_123",
            date: "2026-03-14",
            publishedAt: "2026-03-14T10:00:00.000Z",
            updatedAt: "2026-03-14T10:15:00.000Z",
            path: ".hack/linear/projects/proj_default/status-updates/published/2026-03-14-weekly.md",
          },
        },
        deliveryCorruption: null,
        delivery: {
          path: ".hack/linear/projects/proj_default/delivery-audit.json",
          profileId: "work",
          updatedAt: "2026-03-25T02:30:00.000Z",
          processedDeliveries: 3,
          appliedDeliveries: 2,
          failedDeliveries: 1,
          skippedDeliveries: 0,
          created: 1,
          updated: 2,
          commentsPulled: 0,
          conflictsRecorded: 0,
          checkpointsRecorded: 2,
          deliveries: [
            {
              deliveryId: "delivery-issue",
              profileId: "work",
              mode: "issue",
              status: "applied",
              issueIdentifier: "ENG-101",
              ticketId: "T-00001",
            },
            {
              deliveryId: "delivery-project",
              profileId: "work",
              mode: "project",
              status: "failed",
              projectId: "proj_default",
              reason: "git sync failed",
            },
          ],
        },
        closeout: {
          path: ".hack/linear/projects/proj_default/closeout-scope.json",
          totalItems: 3,
          resolvedCount: 3,
          unresolvedCount: 0,
          latestPublishedPath:
            ".hack/linear/projects/proj_default/status-updates/published/2026-03-25-closeout.md",
          latestPublishedTitle: "Mission closeout audit",
          latestPublishedAt: "2026-03-25T12:00:00.000Z",
          deliveryAuditPath:
            ".hack/linear/projects/proj_default/delivery-audit.json",
          deliveryAuditState: "available",
          entries: [
            {
              ticketId: "T-00001",
              externalKey: "HACK-457",
              title: "Foundational ticket",
              status: "done",
            },
            {
              ticketId: "T-00002",
              externalKey: "HACK-560",
              title: "Shared auth and web foundation",
              parentExternalKey: "HACK-559",
              status: "done",
            },
            {
              ticketId: "T-00003",
              externalKey: "HACK-563",
              title: "Env status, CLI optionality, and closeout",
              parentExternalKey: "HACK-559",
              status: "done",
            },
          ],
        },
      },
    },
    profiles: {
      defaultProfileId: "default",
      selectedProfileId: "work",
      selectedProfileSource: "project_routing",
      selectedProfileMissing: false,
      profiles: [
        {
          id: "work",
          isDefault: false,
          authRef: "linear.api.work",
          service: "hack-linear-work",
          tokenEnv: "HACK_LINEAR_WORK_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
          accountName: "Hack User",
        },
      ],
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [],
    },
    canInspectHackConnection: true,
  });

  const markup = renderToStaticMarkup(
    LinearManagementSection({ linearManagement: state })
  );

  expect(markup).toContain("Repo audit trail");
  expect(markup).toContain("Latest published status update");
  expect(markup).toContain("Weekly update");
  expect(markup).toContain("1 draft still waiting to publish");
  expect(markup).toContain("Latest delivery reconciliation");
  expect(markup).toContain("processed 3");
  expect(markup).toContain("failed 1");
  expect(markup).toContain("git sync failed");
  expect(markup).toContain("Mission closeout");
  expect(markup).toContain(
    "All frozen mission-scoped Linear tickets now resolve to done"
  );
  expect(markup).toContain(
    ".hack/linear/projects/proj_default/closeout-scope.json"
  );
  expect(markup).toContain(
    ".hack/linear/projects/proj_default/delivery-audit.json"
  );
});

test("linear management section surfaces corrupt delivery audit guidance", () => {
  const state = buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "work",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.work",
      service: "hack-linear-work",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: "lin-user-1",
      accountName: "Hack User",
      accountEmail: "hack@example.com",
      tokenResolved: true,
      tokenSource: "broker",
      tokenExpiresAt: null,
      error: null,
      profileError: null,
      ok: true,
      projectBinding: {
        ok: true,
        profileId: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [],
      },
      summary: {
        activeProfile: "work",
        connected: true,
        connectionLabel: "Connected as Hack User",
        routingSummary:
          "This repo routes Linear sync to Default (proj_default) in team team_default.",
        linkedProjectsLabel: null,
        capabilities: ["Publish repo-bound status updates"],
        repair: null,
        nextSteps: ["Run `hack linear status-updates publish`."],
      },
      audit: {
        statusUpdates: {
          draftCount: 0,
          publishedCount: 1,
          latestPublished: {
            title: "Mission closeout audit",
            linearId: "update_999",
            publishedAt: "2026-03-25T12:00:00.000Z",
            updatedAt: "2026-03-25T12:00:00.000Z",
            path: ".hack/linear/projects/proj_default/status-updates/published/2026-03-25-closeout.md",
          },
        },
        deliveryCorruption: {
          path: ".hack/linear/projects/proj_default/delivery-audit.json",
          message: "Delivery audit JSON is malformed.",
          recovery:
            "Remove or repair .hack/linear/projects/proj_default/delivery-audit.json, then rerun `hack linear run-autosync --json` to regenerate the audit from repo-bound sync state.",
        },
        delivery: null,
        closeout: {
          path: ".hack/linear/projects/proj_default/closeout-scope.json",
          totalItems: 1,
          resolvedCount: 0,
          unresolvedCount: 1,
          latestPublishedPath:
            ".hack/linear/projects/proj_default/status-updates/published/2026-03-25-closeout.md",
          latestPublishedTitle: "Mission closeout audit",
          latestPublishedAt: "2026-03-25T12:00:00.000Z",
          deliveryAuditPath:
            ".hack/linear/projects/proj_default/delivery-audit.json",
          deliveryAuditState: "corrupt",
          entries: [
            {
              ticketId: "T-00003",
              externalKey: "HACK-563",
              title: "Env status, CLI optionality, and closeout",
              parentExternalKey: "HACK-559",
              status: "open",
            },
          ],
        },
      },
    },
    profiles: null,
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [],
    },
    canInspectHackConnection: true,
  });

  const markup = renderToStaticMarkup(
    LinearManagementSection({ linearManagement: state })
  );

  expect(markup).toContain("Delivery audit is corrupt");
  expect(markup).toContain("Delivery audit JSON is malformed.");
  expect(markup).toContain("hack linear run-autosync --json");
  expect(markup).toContain("Current status: open");
});
