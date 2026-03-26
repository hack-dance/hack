import type { BrowserSharedProjectScopeSummary } from "../src/lib/browser-shared-project-scope";
import { buildLinearManagementState } from "../src/lib/linear-management";

const routedAccountBrowserSharedProjectScope = {
  state: "local_only",
  mutable: true,
  summary: "This repo currently uses local project ownership for hack-cli.",
  detail:
    "GitHub and Linear readiness remain repo-local until this project is registered with a shared organization or team owner.",
  projectSlug: "hack-cli",
  currentAccessRole: null,
  ownerType: null,
  ownerId: null,
  ownerSlug: null,
  ownerName: null,
} as const satisfies BrowserSharedProjectScopeSummary;

export const routedAccountPopulatedLinearManagement =
  buildLinearManagementState({
    status: {
      extensionId: "dance.hack.linear",
      selectedProfile: "default",
      selectedSource: "project_routing",
      defaultProfile: "default",
      selectedMissing: false,
      authRef: "linear.api.default",
      service: "hack-linear-auth",
      tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
      apiUrl: "https://api.linear.app/graphql",
      accountId: null,
      accountName: null,
      accountEmail: null,
      tokenResolved: false,
      tokenSource: null,
      tokenExpiresAt: null,
      error:
        'Linear broker access for profile "default" requires Hack account login. Run `hack auth login` and retry.',
      profileError: null,
      ok: false,
      projectBinding: {
        ok: true,
        profileId: "default",
        projectId: "7a3c8adf-ede5-4d3a-8779-9c32695c76bf",
        projectName: "Hack",
        teamId: "e0aedec9-5273-446f-b975-aa4cd1525900",
        additionalProjects: [],
      },
      summary: {
        activeProfile: "default",
        connected: false,
        connectionLabel: "Not connected",
        routingSummary:
          "This repo routes Linear sync to Hack (7a3c8adf-ede5-4d3a-8779-9c32695c76bf) in team e0aedec9-5273-446f-b975-aa4cd1525900.",
        linkedProjectsLabel: null,
        capabilities: ["Repair local Linear access for the active profile"],
        repair: {
          reason:
            "Hack account login is required for broker-owned Linear access.",
          command: "hack auth login",
        },
        nextSteps: ["Run `hack auth login`."],
      },
      audit: {
        statusUpdates: {
          draftCount: 0,
          publishedCount: 2,
          drafts: [],
          latestPublished: {
            title: "Mission closeout audit",
            path: ".hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/status-updates/published/2026-03-25-mission-closeout-audit.md",
            state: "published",
            linearId: "93e622be-21df-4665-a72f-e796e9c8e3f2",
            date: "2026-03-25",
            publishedAt: "2026-03-25T20:36:19.417Z",
            updatedAt: "2026-03-25T20:36:19.417Z",
            health: "onTrack",
          },
        },
        delivery: {
          projectId: "7a3c8adf-ede5-4d3a-8779-9c32695c76bf",
          projectIds: ["7a3c8adf-ede5-4d3a-8779-9c32695c76bf"],
          profileId: "default",
          updatedAt: "2026-03-25T15:09:02.519Z",
          processedDeliveries: 0,
          appliedDeliveries: 0,
          failedDeliveries: 0,
          skippedDeliveries: 0,
          created: 0,
          updated: 0,
          commentsPulled: 0,
          conflictsRecorded: 0,
          checkpointsRecorded: 0,
          deliveries: [],
          path: ".hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/delivery-audit.json",
        },
        deliveryCorruption: null,
        closeout: {
          path: ".hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/closeout-scope.json",
          totalItems: 13,
          resolvedCount: 13,
          unresolvedCount: 0,
          entries: [
            {
              ticketId: "T-J780JQ2VK0",
              title:
                "Dogfood the Hack App Linear project through Hack-native planning and sync flows",
              externalId: "91c16d6b-deda-47d7-af5a-e7acf2cafdaf",
              externalKey: "HACK-457",
              status: "done",
              currentTitle:
                "Dogfood the Hack App Linear project through Hack-native planning and sync flows",
              currentUpdatedAt: "2026-03-25T20:35:01.000Z",
            },
            {
              ticketId: "T-XQ0VTXW5AJ",
              title: "Optional web control plane delivery tracker",
              externalId: "12c1576b-2366-400e-b5be-3853f984854a",
              externalKey: "HACK-559",
              status: "done",
              currentTitle: "Optional web control plane delivery tracker",
              currentUpdatedAt: "2026-03-25T20:35:15.000Z",
            },
            {
              ticketId: "T-DP0Q3VKTTJ",
              title:
                "Optional web control plane: env status, CLI optionality, and closeout",
              externalId: "47788fd6-65ee-4fe6-8eec-55ca5063bee3",
              externalKey: "HACK-563",
              parentExternalKey: "HACK-559",
              status: "done",
              currentTitle:
                "Optional web control plane: env status, CLI optionality, and closeout",
              currentUpdatedAt: "2026-03-25T20:35:21.000Z",
            },
          ],
          latestPublishedPath:
            ".hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/status-updates/published/2026-03-25-mission-closeout-audit.md",
          latestPublishedTitle: "Mission closeout audit",
          latestPublishedAt: "2026-03-25T20:36:19.417Z",
          deliveryAuditPath:
            ".hack/linear/projects/7a3c8adf-ede5-4d3a-8779-9c32695c76bf/delivery-audit.json",
          deliveryAuditState: "available",
        },
      },
      sharedProjectScope: routedAccountBrowserSharedProjectScope,
    },
    profiles: {
      defaultProfileId: "default",
      selectedProfileId: "default",
      selectedProfileSource: "project_routing",
      selectedProfileMissing: false,
      profiles: [
        {
          id: "default",
          isDefault: true,
          authRef: "linear.api.default",
          service: "hack-linear-auth",
          tokenEnv: "HACK_LINEAR_API_TOKEN",
          apiUrl: "https://api.linear.app/graphql",
        },
      ],
    },
    connections: {
      accessControlMode: "better_auth_team_owned",
      connections: [],
    },
    canInspectHackConnection: true,
    browserSharedProjectScope: routedAccountBrowserSharedProjectScope,
  });

export function findDescriptionListViolations(input: {
  readonly markup: string;
}): string[] {
  const tagPattern = /<\/?(dl|dt|dd)\b[^>]*>/g;
  const violations: string[] = [];
  const stack: string[] = [];

  for (const match of input.markup.matchAll(tagPattern)) {
    const [tag] = match;
    const normalizedTag = tag.startsWith("</")
      ? tag.slice(2, 4)
      : tag.slice(1, 3);

    if (normalizedTag === "dl") {
      if (tag.startsWith("</")) {
        stack.pop();
      } else {
        stack.push("dl");
      }
      continue;
    }

    if (stack.length === 0) {
      violations.push(tag);
    }
  }

  return violations;
}

export function hasDescriptionListEntry(input: {
  readonly markup: string;
  readonly label: string;
  readonly value: string;
}): boolean {
  const pattern = new RegExp(
    `<dt[^>]*>${escapeForRegex(input.label)}<\\/dt><dd[^>]*>${escapeForRegex(input.value)}<\\/dd>`
  );

  return pattern.test(input.markup);
}

function escapeForRegex(input: string): string {
  return input.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
