import { expect, test } from "bun:test";

import { resolveLinearToken } from "../src/control-plane/extensions/linear/auth.ts";
import { __testOnly } from "../src/control-plane/extensions/linear/commands.ts";

const minimalLinearBindingConfig = {
  routing: {
    mode: "existing_only",
    bootstrap: {
      enabled: false,
      setAsProjectNode: false,
    },
    overrides: {
      linear: {
        profile: "work",
        projectId: "proj_default",
        projectName: "Default",
        teamId: "team_default",
        additionalProjects: [
          {
            projectId: "proj_extra",
            projectName: "Extra",
            teamId: "team_extra",
          },
          {
            projectId: "proj_default",
            projectName: "Duplicate default",
            teamId: "team_default",
          },
          {
            projectId: "proj_extra",
            projectName: "Duplicate extra",
            teamId: "team_extra",
          },
        ],
      },
    },
  },
} as unknown as Parameters<
  typeof __testOnly.resolveProjectLinearBinding
>[0]["controlPlaneConfig"];

test("parseSetupArgs parses project binding flags", () => {
  const parsed = __testOnly.parseSetupArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj_123",
      "--project-name",
      "Platform",
      "--team-id",
      "team_123",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj_123",
    projectName: "Platform",
    teamId: "team_123",
    json: true,
  });
});

test("parseConnectArgs parses token connection flags", () => {
  const parsed = __testOnly.parseConnectArgs({
    args: [
      "--profile",
      "work",
      "--token",
      "secret-token",
      "--token-env",
      "CUSTOM_LINEAR_TOKEN",
      "--auth-ref",
      "linear.work.api",
      "--service",
      "hack-linear-work",
      "--api-url",
      "https://api.linear.app/graphql",
      "--refresh-token",
      "refresh-token",
      "--token-expires-at",
      "2026-03-05T12:00:00.000Z",
      "--refresh-token-expires-at",
      "2026-04-05T12:00:00.000Z",
      "--set-default",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    token: "secret-token",
    tokenEnv: "CUSTOM_LINEAR_TOKEN",
    authRef: "linear.work.api",
    service: "hack-linear-work",
    apiUrl: "https://api.linear.app/graphql",
    refreshToken: "refresh-token",
    tokenExpiresAt: "2026-03-05T12:00:00.000Z",
    refreshTokenExpiresAt: "2026-04-05T12:00:00.000Z",
    stdin: false,
    setDefault: true,
  });
});

test("parseOAuthConnectArgs parses desktop handoff flags", () => {
  const parsed = __testOnly.parseOAuthConnectArgs({
    args: [
      "--profile",
      "work",
      "--set-default",
      "--start-only",
      "--desktop-redirect-url",
      "hack-dev://auth/linear/callback",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    setDefault: true,
    startOnly: true,
    clientSecretStdin: false,
    desktopRedirectUrl: "hack-dev://auth/linear/callback",
    noOpen: false,
    json: true,
  });
});

test("parseSyncIssueArgs rejects invalid direction", () => {
  const parsed = __testOnly.parseSyncIssueArgs({
    args: ["--from", "other"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }
  expect(parsed.error).toContain("Expected linear|hack");
});

test("parseSyncProjectArgs parses owner filter and limits", () => {
  const parsed = __testOnly.parseSyncProjectArgs({
    args: [
      "--from",
      "hack",
      "--owner",
      "both",
      "--project-id",
      "proj_abc",
      "--team-id",
      "team_abc",
      "--limit",
      "25",
      "--sync-labels",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    from: "hack",
    ownerMode: "both",
    projectId: "proj_abc",
    teamId: "team_abc",
    limit: 25,
    syncLabels: true,
    json: true,
  });
});

test("parseConnectionsArgs parses broker connection filters", () => {
  const parsed = __testOnly.parseConnectionsArgs({
    args: ["--profile", "work", "--organization-id", "shared-org", "--json"],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    organizationId: "shared-org",
    json: true,
  });
});

test("parseSeedLocalAccessArgs parses repair flags", () => {
  const parsed = __testOnly.parseSeedLocalAccessArgs({
    args: ["--profile", "work", "--set-default", "--json"],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    setDefault: true,
    json: true,
  });
});

test("parseRunAutosyncArgs parses profile, route filters, and limit", () => {
  const parsed = __testOnly.parseRunAutosyncArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj-1",
      "--team-id",
      "team-1",
      "--limit",
      "5",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj-1",
    teamId: "team-1",
    limit: 5,
    json: true,
  });
});

test("parseProjectLinkArgs parses additional project routing flags", () => {
  const parsed = __testOnly.parseProjectLinkArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj_456",
      "--project-name",
      "Operations",
      "--team-id",
      "team_456",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj_456",
    projectName: "Operations",
    teamId: "team_456",
    json: true,
  });
});

test("resolveProjectLinearBinding keeps a default project and deduped additional projects", () => {
  const binding = __testOnly.resolveProjectLinearBinding({
    controlPlaneConfig: minimalLinearBindingConfig,
  });

  expect(binding).toEqual({
    profileId: "work",
    projectId: "proj_default",
    projectName: "Default",
    teamId: "team_default",
    additionalProjects: [
      {
        profileId: "work",
        projectId: "proj_extra",
        projectName: "Duplicate extra",
        teamId: "team_extra",
      },
    ],
  });
});

test("resolveProjectPullTargets includes default and additional bound projects", () => {
  const targets = __testOnly.resolveProjectPullTargets({
    binding: {
      profileId: "work",
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
      additionalProjects: [
        {
          projectId: "proj_extra",
          projectName: "Extra",
          teamId: "team_extra",
        },
      ],
    },
  });

  expect(targets).toEqual([
    {
      profileId: "work",
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
    },
    {
      projectId: "proj_extra",
      projectName: "Extra",
      teamId: "team_extra",
    },
  ]);
});

test("resolveProjectPullTargets keeps per-project profile overrides for linked projects", () => {
  const targets = __testOnly.resolveProjectPullTargets({
    binding: {
      profileId: "work",
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
      additionalProjects: [
        {
          profileId: "ops",
          projectId: "proj_ops",
          projectName: "Operations",
          teamId: "team_ops",
        },
      ],
    },
  });

  expect(targets).toEqual([
    {
      profileId: "work",
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
    },
    {
      profileId: "ops",
      projectId: "proj_ops",
      projectName: "Operations",
      teamId: "team_ops",
    },
  ]);
});

test("findProjectBindingTarget resolves additional linked projects by id", () => {
  const target = __testOnly.findProjectBindingTarget({
    binding: {
      profileId: "work",
      projectId: "proj_default",
      projectName: "Default",
      teamId: "team_default",
      additionalProjects: [
        {
          profileId: "ops",
          projectId: "proj_ops",
          projectName: "Operations",
          teamId: "team_ops",
        },
      ],
    },
    projectId: "proj_ops",
  });

  expect(target).toEqual({
    profileId: "ops",
    projectId: "proj_ops",
    projectName: "Operations",
    teamId: "team_ops",
  });
});

test("connect falls back to oauth when no token input exists", () => {
  const envKey = "HACK_LINEAR_TEST_TOKEN";
  const previous = process.env[envKey];
  delete process.env[envKey];

  const fallback = __testOnly.shouldFallbackConnectToOAuth({
    parsed: {
      stdin: false,
      setDefault: false,
    },
    tokenEnv: envKey,
  });

  if (previous !== undefined) {
    process.env[envKey] = previous;
  } else {
    delete process.env[envKey];
  }

  expect(fallback).toBe(true);
});

test("connect does not fall back to oauth when token exists in env", () => {
  const envKey = "HACK_LINEAR_TEST_TOKEN";
  const previous = process.env[envKey];
  process.env[envKey] = "token-present";

  const fallback = __testOnly.shouldFallbackConnectToOAuth({
    parsed: {
      stdin: false,
      setDefault: false,
    },
    tokenEnv: envKey,
  });

  if (previous !== undefined) {
    process.env[envKey] = previous;
  } else {
    delete process.env[envKey];
  }

  expect(fallback).toBe(false);
});

test("oauth connect prefers broker flow when no local oauth overrides are provided", () => {
  const useBroker = __testOnly.shouldUseBrokerOAuthFlow({
    parsed: {
      setDefault: false,
      startOnly: false,
      clientSecretStdin: false,
      noOpen: false,
      json: false,
    },
  });

  expect(useBroker).toBe(true);
});

test("oauth connect disables broker flow when local oauth overrides are provided", () => {
  const useBroker = __testOnly.shouldUseBrokerOAuthFlow({
    parsed: {
      setDefault: false,
      startOnly: false,
      clientId: "client-id",
      clientSecretStdin: false,
      noOpen: false,
      json: false,
    },
  });

  expect(useBroker).toBe(false);
});

test("buildOAuthArgsFromConnectArgs maps connect defaults into oauth args", () => {
  const args = __testOnly.buildOAuthArgsFromConnectArgs({
    profileId: "work",
    parsed: {
      stdin: false,
      setDefault: true,
      apiUrl: "https://api.linear.app/graphql",
      tokenEnv: "LINEAR_TOKEN",
      authRef: "linear.api.work",
      service: "hack-linear-auth",
    },
  });

  expect(args).toEqual([
    "--profile",
    "work",
    "--set-default",
    "--api-url",
    "https://api.linear.app/graphql",
    "--token-env",
    "LINEAR_TOKEN",
    "--auth-ref",
    "linear.api.work",
    "--service",
    "hack-linear-auth",
  ]);
});

test("parseDeliveriesArgs parses status, limit, and json flags", () => {
  const parsed = __testOnly.parseDeliveriesArgs({
    args: [
      "--profile",
      "work",
      "--status",
      "applied",
      "--limit",
      "10",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    status: "applied",
    limit: 10,
    json: true,
  });
});

test("parseApplyDeliveryArgs requires a delivery id", () => {
  const parsed = __testOnly.parseApplyDeliveryArgs({
    args: [],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("--delivery-id");
});

test("parseAssigneeMappingsArgs parses profile and team filters", () => {
  const parsed = __testOnly.parseAssigneeMappingsArgs({
    args: ["--profile", "work", "--team-id", "team-1", "--json"],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    teamId: "team-1",
    json: true,
  });
});

test("parseAutosyncSubscriptionsArgs parses profile and scope filters", () => {
  const parsed = __testOnly.parseAutosyncSubscriptionsArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj-1",
      "--team-id",
      "team-1",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj-1",
    teamId: "team-1",
    json: true,
  });
});

test("parseUpsertAutosyncSubscriptionArgs validates mode and status", () => {
  const parsed = __testOnly.parseUpsertAutosyncSubscriptionArgs({
    args: ["--mode", "invalid"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("manual|auto_apply");
});

test("parseUpsertAutosyncSubscriptionArgs parses autosync scope and state", () => {
  const parsed = __testOnly.parseUpsertAutosyncSubscriptionArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj-1",
      "--team-id",
      "team-1",
      "--mode",
      "auto_apply",
      "--status",
      "paused",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj-1",
    teamId: "team-1",
    mode: "auto_apply",
    status: "paused",
    json: true,
  });
});

test("parseRemoveAutosyncSubscriptionArgs parses optional scope", () => {
  const parsed = __testOnly.parseRemoveAutosyncSubscriptionArgs({
    args: [
      "--profile",
      "work",
      "--project-id",
      "proj-1",
      "--team-id",
      "team-1",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    projectId: "proj-1",
    teamId: "team-1",
    json: true,
  });
});

test("normalizeBrokerProtectedLinearError tells the user to run hack auth login when broker auth is required", () => {
  const message = __testOnly.normalizeBrokerProtectedLinearError({
    error: "better_auth_session_required",
    profileId: "work",
  });

  expect(message).toContain("hack auth login");
  expect(message).toContain('profile "work"');
});

test("normalizeBrokerProtectedLinearError explains profile access failures", () => {
  const message = __testOnly.normalizeBrokerProtectedLinearError({
    error: "better_auth_profile_forbidden",
    profileId: "work",
  });

  expect(message).toContain("does not have access");
  expect(message).toContain('profile "work"');
  expect(message).toContain("hack auth login");
});

test("resolveLinearToken keeps local token setup ungated", async () => {
  const result = await resolveLinearToken({
    controlPlaneConfig: {} as Parameters<
      typeof resolveLinearToken
    >[0]["controlPlaneConfig"],
    env: {},
    store: {
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.error).toContain("hack x linear connect");
  expect(result.error).not.toContain("hack auth login");
});

test("parseUpsertAssigneeMappingArgs requires a local assignee and remote target", () => {
  const parsed = __testOnly.parseUpsertAssigneeMappingArgs({
    args: ["--profile", "work", "--local-assignee", "alice@hack"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("--linear-user-id");
});

test("parseUpsertAssigneeMappingArgs parses explicit mapping fields", () => {
  const parsed = __testOnly.parseUpsertAssigneeMappingArgs({
    args: [
      "--profile",
      "work",
      "--team-id",
      "team-1",
      "--local-assignee",
      "alice@hack",
      "--linear-user-id",
      "user-1",
      "--linear-user-name",
      "Alice Example",
      "--linear-user-email",
      "alice@example.com",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    profileId: "work",
    teamId: "team-1",
    localAssignee: "alice@hack",
    linearUserId: "user-1",
    linearUserName: "Alice Example",
    linearUserEmail: "alice@example.com",
    json: true,
  });
});

test("parseRemoveAssigneeMappingArgs requires a local assignee", () => {
  const parsed = __testOnly.parseRemoveAssigneeMappingArgs({
    args: ["--profile", "work"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("--local-assignee");
});

test("detectAuthoritativeFieldConflicts reports divergence for hack-owned tickets", () => {
  const conflicts = __testOnly.detectAuthoritativeFieldConflicts({
    authority: "hack",
    ticket: {
      ticketId: "T-00001",
      title: "Local title",
      body: "Local body",
      status: "in_progress",
      createdAt: "2026-03-05T10:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "hack",
      tags: [],
      projectId: "proj-local",
      projectName: "Local Project",
    },
    issue: {
      id: "issue-1",
      identifier: "ENG-123",
      title: "Remote title",
      description: "Remote body",
      url: "https://linear.app/issue/ENG-123",
      state: {
        id: "state-1",
        name: "Started",
        type: "started",
      },
      teamId: "team-1",
      projectId: "proj-remote",
      projectName: "Remote Project",
      labels: [],
    },
    remoteProjection: {
      body: "Remote body\n\n---\n\nLinear Issue: ENG-123\n\nLinear URL: https://linear.app/issue/ENG-123",
      status: "done",
    },
  });

  expect(conflicts.map((conflict) => conflict.field)).toEqual([
    "title",
    "description",
    "status",
    "project",
  ]);
});

test("selectLinearCommentsToAppend keeps unmatched remote ids in FIFO order", () => {
  const selected = __testOnly.selectLinearCommentsToAppend({
    localComments: [
      {
        commentId: "comment-1",
        ticketId: "T-00001",
        body: "Already synced",
        source: "linear",
        actor: "linear",
        createdAt: "2026-03-05T10:00:00.000Z",
        externalId: "linear-comment-1",
      },
    ],
    remoteComments: [
      {
        id: "linear-comment-1",
        body: "Already synced",
        createdAt: "2026-03-05T09:00:00.000Z",
      },
      {
        id: "linear-comment-2",
        body: "Same body duplicate",
        createdAt: "2026-03-05T09:05:00.000Z",
      },
      {
        id: "linear-comment-3",
        body: "Same body duplicate",
        createdAt: "2026-03-05T09:06:00.000Z",
      },
    ],
  });

  expect(selected.map((comment) => comment.id)).toEqual([
    "linear-comment-2",
    "linear-comment-3",
  ]);
});

test("selectTicketCommentsToPush keeps unsynced local comments even when bodies repeat", () => {
  const selected = __testOnly.selectTicketCommentsToPush({
    localComments: [
      {
        commentId: "comment-1",
        ticketId: "T-00001",
        body: "Push me",
        source: "hack",
        actor: "dio",
        createdAt: "2026-03-05T10:00:00.000Z",
        externalId: "linear-comment-1",
      },
      {
        commentId: "comment-2",
        ticketId: "T-00001",
        body: "Push me",
        source: "hack",
        actor: "dio",
        createdAt: "2026-03-05T10:01:00.000Z",
      },
      {
        commentId: "comment-3",
        ticketId: "T-00001",
        body: "Came from Linear",
        source: "linear",
        actor: "linear",
        createdAt: "2026-03-05T10:02:00.000Z",
        externalId: "linear-comment-3",
      },
    ],
    remoteComments: [],
  });

  expect(selected.map((comment) => comment.commentId)).toEqual(["comment-2"]);
});

test("resolveTicketAssigneeForLinear prefers explicit mappings before fuzzy user matching", async () => {
  const resolution = await __testOnly.resolveTicketAssigneeForLinear({
    runtime: {
      profileId: "work",
      assigneeMappings: [
        {
          profileId: "work",
          teamId: "team-1",
          localAssignee: "backend-owner",
          linearUserId: "user-2",
          linearUserName: "Backend Owner",
        },
      ],
      linear: {
        listTeamUsers: async () => ({
          ok: true as const,
          data: [
            {
              id: "user-1",
              email: "backend-owner@example.com",
              displayName: "Wrong Match",
            },
          ],
        }),
      },
    },
    ticket: {
      ticketId: "T-00001",
      title: "Ship explicit assignee mappings",
      body: "",
      status: "open",
      createdAt: "2026-03-05T10:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "hack",
      assignee: "backend-owner",
      tags: [],
    },
    teamId: "team-1",
  });

  expect(resolution).toEqual({
    requestedAssignee: "backend-owner",
    matchedUserId: "user-2",
    matchedUserDisplayName: "Backend Owner",
    applied: true,
  });
});

test("syncIssueFromLinearToTicket preserves hack authority, appends comments, and records checkpoints", async () => {
  const conflicts: string[] = [];
  const appendedBodies: string[] = [];
  const checkpoints: string[] = [];
  const updatedTickets: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      additionalProjects: [],
    },
    tickets: {
      listTickets: async () => [
        {
          ticketId: "T-00001",
          title: "Hack-owned title",
          body: "Hack-owned body",
          status: "open" as const,
          createdAt: "2026-03-05T10:00:00.000Z",
          updatedAt: "2026-03-05T10:00:00.000Z",
          dependsOn: [],
          blocks: [],
          owner: "hack",
          source: "hack",
          assignee: "Local Owner",
          tags: [],
          externalSystem: "linear",
          externalId: "issue-1",
          externalKey: "ENG-123",
          externalProjectId: "proj-local",
        },
      ],
      updateTicket: async (input: Record<string, unknown>) => {
        updatedTickets.push(input);
        return { ok: true as const };
      },
      setStatus: async () => ({ ok: true as const }),
      createTicket: async () => {
        throw new Error("createTicket should not be called");
      },
      getTicket: async () => null,
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [
          {
            commentId: "comment-1",
            ticketId: "T-00001",
            body: "Already synced",
            source: "linear",
            actor: "linear",
            createdAt: "2026-03-05T10:00:00.000Z",
            externalId: "linear-comment-1",
          },
        ],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      appendComment: async (input: { readonly body: string }) => {
        appendedBodies.push(input.body);
        return {
          ok: true as const,
          comment: {
            commentId: "comment-new",
            ticketId: "T-00001",
            body: input.body,
            source: "linear",
            actor: "linear",
            createdAt: "2026-03-05T10:05:00.000Z",
          },
        };
      },
      recordSyncCheckpoint: async (input: { readonly direction?: string }) => {
        checkpoints.push(input.direction ?? "");
        return {
          ok: true as const,
          checkpoint: {
            checkpointId: "checkpoint-1",
            ticketId: "T-00001",
            provider: "linear",
            direction: input.direction,
            actor: "test",
            createdAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
      recordSyncConflict: async (input: { readonly field: string }) => {
        conflicts.push(input.field);
        return {
          ok: true as const,
          conflict: {
            conflictId: `conflict-${input.field}`,
            ticketId: "T-00001",
            provider: "linear",
            field: input.field,
            status: "open" as const,
            createdAt: "2026-03-05T10:10:00.000Z",
            updatedAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
    },
    linear: {
      getIssueById: async () => ({ ok: true as const, data: null }),
      getIssueByIdentifier: async () => ({
        ok: true as const,
        data: {
          id: "issue-1",
          identifier: "ENG-123",
          title: "Linear title",
          description: "Linear body",
          url: "https://linear.app/issue/ENG-123",
          state: {
            id: "state-1",
            name: "Done",
            type: "completed" as const,
          },
          teamId: "team-1",
          projectId: "proj-remote",
          projectName: "Remote Project",
          assigneeDisplayName: "Remote Owner",
          labels: [],
        },
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [
          {
            id: "linear-comment-1",
            body: "Already synced",
            createdAt: "2026-03-05T09:00:00.000Z",
          },
          {
            id: "linear-comment-2",
            body: "Fresh remote note",
            createdAt: "2026-03-05T09:10:00.000Z",
            userDisplayName: "Remote Owner",
          },
        ],
      }),
    },
  };

  const result = await __testOnly.syncIssueFromLinearToTicket({
    runtime,
    issueIdentifier: "ENG-123",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.commentsPulled).toBe(1);
  expect(result.conflictsRecorded).toBe(4);
  expect(appendedBodies).toEqual(["Fresh remote note"]);
  expect(conflicts).toEqual(["title", "description", "status", "project"]);
  expect(checkpoints).toEqual(["linear_to_hack"]);
  expect(updatedTickets).toHaveLength(1);
  expect(updatedTickets[0]?.title).toBeUndefined();
  expect(updatedTickets[0]?.body).toBeUndefined();
  expect(updatedTickets[0]?.assignee).toBe("Remote Owner");
});

test("syncIssueFromLinearToTicket records review-required conflicts for dual-homed authority", async () => {
  const recordedConflicts: Array<{
    readonly field: string;
    readonly authority?: string;
  }> = [];
  const updatedTickets: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      additionalProjects: [],
    },
    tickets: {
      listTickets: async () => [
        {
          ticketId: "T-00004",
          title: "Local title",
          body: "Local body",
          status: "open" as const,
          createdAt: "2026-03-05T10:00:00.000Z",
          updatedAt: "2026-03-05T10:00:00.000Z",
          dependsOn: [],
          blocks: [],
          owner: "hack",
          source: "linear",
          assignee: "Local Owner",
          tags: [],
          externalId: "issue-4",
          externalKey: "ENG-444",
          externalProjectId: "proj-local",
        },
      ],
      updateTicket: async (input: Record<string, unknown>) => {
        updatedTickets.push(input);
        return { ok: true as const };
      },
      setStatus: async () => ({ ok: true as const }),
      createTicket: async () => {
        throw new Error("createTicket should not be called");
      },
      getTicket: async () => null,
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      appendComment: async () => ({
        ok: true as const,
        comment: {
          commentId: "comment-new",
          ticketId: "T-00004",
          body: "Fresh remote note",
          source: "linear",
          actor: "linear",
          createdAt: "2026-03-05T10:05:00.000Z",
        },
      }),
      recordSyncCheckpoint: async () => ({
        ok: true as const,
        checkpoint: {
          checkpointId: "checkpoint-4",
          ticketId: "T-00004",
          provider: "linear",
          direction: "linear_to_hack",
          actor: "test",
          createdAt: "2026-03-05T10:10:00.000Z",
        },
      }),
      recordSyncConflict: async (input: {
        readonly field: string;
        readonly authority?: string;
      }) => {
        recordedConflicts.push(input);
        return {
          ok: true as const,
          conflict: {
            conflictId: `conflict-${input.field}`,
            ticketId: "T-00004",
            provider: "linear",
            field: input.field,
            status: "open" as const,
            authority: input.authority,
            createdAt: "2026-03-05T10:10:00.000Z",
            updatedAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
    },
    linear: {
      getIssueById: async () => ({ ok: true as const, data: null }),
      getIssueByIdentifier: async () => ({
        ok: true as const,
        data: {
          id: "issue-4",
          identifier: "ENG-444",
          title: "Linear title",
          description: "Linear body",
          url: "https://linear.app/issue/ENG-444",
          state: {
            id: "state-1",
            name: "Done",
            type: "completed" as const,
          },
          teamId: "team-1",
          projectId: "proj-remote",
          projectName: "Remote Project",
          assigneeDisplayName: "Remote Owner",
          labels: [],
        },
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [
          {
            id: "linear-comment-4",
            body: "Fresh remote note",
            createdAt: "2026-03-05T09:10:00.000Z",
            userDisplayName: "Remote Owner",
          },
        ],
      }),
    },
  };

  const result = await __testOnly.syncIssueFromLinearToTicket({
    runtime,
    issueIdentifier: "ENG-444",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.conflictsRecorded).toBe(4);
  expect(recordedConflicts).toEqual([
    expect.objectContaining({ field: "title", authority: "review_required" }),
    expect.objectContaining({
      field: "description",
      authority: "review_required",
    }),
    expect.objectContaining({ field: "status", authority: "review_required" }),
    expect.objectContaining({ field: "project", authority: "review_required" }),
  ]);
  expect(updatedTickets).toHaveLength(1);
  expect(updatedTickets[0]?.title).toBeUndefined();
  expect(updatedTickets[0]?.body).toBeUndefined();
  expect(updatedTickets[0]?.owner).toBeUndefined();
  expect(updatedTickets[0]?.source).toBeUndefined();
});

test("syncTicketToLinearIssue pushes missing local comments and records a checkpoint", async () => {
  const pushedBodies: string[] = [];
  const checkpoints: string[] = [];
  const linkedComments: Array<{
    readonly commentId: string;
    readonly externalId: string;
  }> = [];
  const updatedIssues: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      teamId: "team-1",
      additionalProjects: [],
    },
    assigneeMappings: [],
    tickets: {
      getTicket: async () => ({
        ticketId: "T-00001",
        title: "Hack title",
        body: "Hack body",
        status: "open" as const,
        createdAt: "2026-03-05T10:00:00.000Z",
        updatedAt: "2026-03-05T10:00:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "hack",
        source: "hack",
        assignee: "alice@example.com",
        tags: [],
        externalSystem: "linear",
        externalId: "issue-1",
        externalKey: "ENG-123",
        externalTeamId: "team-1",
      }),
      updateTicket: async () => ({ ok: true as const }),
      listTickets: async () => [],
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [
          {
            commentId: "comment-1",
            ticketId: "T-00001",
            body: "Already remote",
            source: "hack",
            actor: "dio",
            createdAt: "2026-03-05T10:00:00.000Z",
          },
          {
            commentId: "comment-2",
            ticketId: "T-00001",
            body: "Push me",
            source: "hack",
            actor: "dio",
            createdAt: "2026-03-05T10:01:00.000Z",
          },
        ],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      linkCommentExternalId: async (input: {
        readonly commentId: string;
        readonly externalId: string;
      }) => {
        linkedComments.push({
          commentId: input.commentId,
          externalId: input.externalId,
        });
        return { ok: true as const };
      },
      recordSyncCheckpoint: async (input: { readonly direction?: string }) => {
        checkpoints.push(input.direction ?? "");
        return {
          ok: true as const,
          checkpoint: {
            checkpointId: "checkpoint-1",
            ticketId: "T-00001",
            provider: "linear",
            direction: input.direction,
            actor: "test",
            createdAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
      recordSyncConflict: async () => {
        throw new Error("recordSyncConflict should not be called");
      },
    },
    linear: {
      getIssueById: async () => ({
        ok: true as const,
        data: {
          id: "issue-1",
          identifier: "ENG-123",
          title: "Hack title",
          description: "Hack body",
          state: {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          teamId: "team-1",
          assigneeEmail: "alice@example.com",
          labels: [],
        },
      }),
      updateIssue: async (input: Record<string, unknown>) => {
        updatedIssues.push(input);
        return {
          ok: true as const,
          data: {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Hack title",
            description: "Hack body",
            state: {
              id: "state-1",
              name: "Todo",
              type: "unstarted" as const,
            },
            teamId: "team-1",
            assigneeId: "user-1",
            labels: [],
          },
        };
      },
      createIssue: async () => {
        throw new Error("createIssue should not be called");
      },
      listTeamStates: async () => ({
        ok: true as const,
        data: [
          {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
        ],
      }),
      listTeamLabels: async () => ({
        ok: true as const,
        data: [],
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [
          {
            id: "linear-comment-1",
            body: "Already remote",
            createdAt: "2026-03-05T09:00:00.000Z",
          },
        ],
      }),
      createComment: async (input: { readonly body: string }) => {
        pushedBodies.push(input.body);
        return {
          ok: true as const,
          data: {
            id: `linear-${pushedBodies.length}`,
            body: input.body,
            createdAt: "2026-03-05T10:15:00.000Z",
          },
        };
      },
      listTeamUsers: async () => ({
        ok: true as const,
        data: [
          {
            id: "user-1",
            email: "alice@example.com",
            displayName: "Alice",
          },
        ],
      }),
      getIssueByIdentifier: async () => ({ ok: true as const, data: null }),
      getProject: async () => ({ ok: true as const, data: null }),
    },
  };

  const result = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00001",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.commentsPushed).toBe(1);
  expect(result.assignee.matchedUserId).toBe("user-1");
  expect(result.assignee.applied).toBe(true);
  expect(pushedBodies).toEqual(["Push me"]);
  expect(linkedComments).toEqual([
    {
      commentId: "comment-2",
      externalId: "linear-1",
    },
  ]);
  expect(checkpoints).toEqual(["hack_to_linear"]);
  expect(updatedIssues[0]?.assigneeId).toBe("user-1");
});

test("syncTicketToLinearIssue reuses a linked Linear issue inferred from provenance metadata", async () => {
  const updatedIssues: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      teamId: "team-1",
      additionalProjects: [],
    },
    assigneeMappings: [],
    tickets: {
      getTicket: async () => ({
        ticketId: "T-00002",
        title: "Synced from Linear",
        body: "Keep using the existing Linear issue.",
        status: "open" as const,
        createdAt: "2026-03-05T10:00:00.000Z",
        updatedAt: "2026-03-05T10:00:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "hack",
        source: "linear",
        tags: [],
        externalId: "issue-2",
        externalKey: "ENG-222",
        externalUrl: "https://linear.app/hack/issue/ENG-222",
        externalProjectId: "proj-2",
        externalTeamId: "team-1",
      }),
      updateTicket: async () => ({ ok: true as const }),
      listTickets: async () => [],
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      linkCommentExternalId: async () => ({ ok: true as const }),
      recordSyncCheckpoint: async () => ({
        ok: true as const,
        checkpoint: {
          checkpointId: "checkpoint-2",
          ticketId: "T-00002",
          provider: "linear",
          direction: "hack_to_linear",
          actor: "test",
          createdAt: "2026-03-05T10:10:00.000Z",
        },
      }),
      recordSyncConflict: async () => ({ ok: true as const, conflict: null }),
    },
    linear: {
      getIssueById: async () => ({
        ok: true as const,
        data: {
          id: "issue-2",
          identifier: "ENG-222",
          title: "Synced from Linear",
          description: "Keep using the existing Linear issue.",
          state: {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          url: "https://linear.app/hack/issue/ENG-222",
          teamId: "team-1",
          projectId: "proj-2",
          labels: [],
        },
      }),
      getIssueByIdentifier: async () => ({ ok: true as const, data: null }),
      updateIssue: async (input: Record<string, unknown>) => {
        updatedIssues.push(input);
        return {
          ok: true as const,
          data: {
            id: "issue-2",
            identifier: "ENG-222",
            title: "Synced from Linear",
            description: "Keep using the existing Linear issue.",
            state: {
              id: "state-1",
              name: "Todo",
              type: "unstarted" as const,
            },
            url: "https://linear.app/hack/issue/ENG-222",
            teamId: "team-1",
            projectId: "proj-2",
            labels: [],
          },
        };
      },
      createIssue: async () => {
        throw new Error("createIssue should not be called");
      },
      listTeamStates: async () => ({
        ok: true as const,
        data: [
          {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
        ],
      }),
      listTeamLabels: async () => ({
        ok: true as const,
        data: [],
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [],
      }),
      createComment: async () => {
        throw new Error("createComment should not be called");
      },
      listTeamUsers: async () => ({
        ok: true as const,
        data: [],
      }),
      getProject: async () => ({ ok: true as const, data: null }),
    },
  };

  const result = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00002",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.operation).toBe("updated");
  expect(updatedIssues).toHaveLength(1);
});

test("syncTicketToLinearIssue preserves remote issue fields for review-required authority", async () => {
  const recordedConflicts: Array<{
    readonly field: string;
    readonly authority?: string;
  }> = [];
  const updatedIssues: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      teamId: "team-1",
      additionalProjects: [],
    },
    assigneeMappings: [],
    tickets: {
      getTicket: async () => ({
        ticketId: "T-00005",
        title: "Local title",
        body: "Local body",
        status: "open" as const,
        createdAt: "2026-03-05T10:00:00.000Z",
        updatedAt: "2026-03-05T10:00:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "hack",
        source: "linear",
        assignee: "alice@example.com",
        tags: [],
        externalSystem: "linear",
        externalId: "issue-5",
        externalKey: "ENG-555",
        externalProjectId: "proj-local",
        externalTeamId: "team-1",
      }),
      updateTicket: async () => ({ ok: true as const }),
      listTickets: async () => [],
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      linkCommentExternalId: async () => ({ ok: true as const }),
      recordSyncCheckpoint: async () => ({
        ok: true as const,
        checkpoint: {
          checkpointId: "checkpoint-5",
          ticketId: "T-00005",
          provider: "linear",
          direction: "hack_to_linear",
          actor: "test",
          createdAt: "2026-03-05T10:10:00.000Z",
        },
      }),
      recordSyncConflict: async (input: {
        readonly field: string;
        readonly authority?: string;
      }) => {
        recordedConflicts.push(input);
        return {
          ok: true as const,
          conflict: {
            conflictId: `conflict-${input.field}`,
            ticketId: "T-00005",
            provider: "linear",
            field: input.field,
            status: "open" as const,
            authority: input.authority,
            createdAt: "2026-03-05T10:10:00.000Z",
            updatedAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
    },
    linear: {
      getIssueById: async () => ({
        ok: true as const,
        data: {
          id: "issue-5",
          identifier: "ENG-555",
          title: "Linear title",
          description: "Linear body",
          state: {
            id: "state-2",
            name: "Done",
            type: "completed" as const,
          },
          url: "https://linear.app/hack/issue/ENG-555",
          teamId: "team-1",
          projectId: "proj-remote",
          assigneeId: "user-1",
          labels: [],
        },
      }),
      getIssueByIdentifier: async () => ({ ok: true as const, data: null }),
      updateIssue: async (input: Record<string, unknown>) => {
        updatedIssues.push(input);
        return {
          ok: true as const,
          data: {
            id: "issue-5",
            identifier: "ENG-555",
            title: "Linear title",
            description: "Linear body",
            state: {
              id: "state-2",
              name: "Done",
              type: "completed" as const,
            },
            url: "https://linear.app/hack/issue/ENG-555",
            teamId: "team-1",
            projectId: "proj-remote",
            assigneeId: "user-1",
            labels: [],
          },
        };
      },
      createIssue: async () => {
        throw new Error("createIssue should not be called");
      },
      listTeamStates: async () => ({
        ok: true as const,
        data: [
          {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          {
            id: "state-2",
            name: "Done",
            type: "completed" as const,
          },
        ],
      }),
      listTeamLabels: async () => ({
        ok: true as const,
        data: [],
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [],
      }),
      createComment: async () => {
        throw new Error("createComment should not be called");
      },
      listTeamUsers: async () => ({
        ok: true as const,
        data: [
          {
            id: "user-1",
            email: "alice@example.com",
            displayName: "Alice",
          },
        ],
      }),
      getProject: async () => ({ ok: true as const, data: null }),
    },
  };

  const result = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00005",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(recordedConflicts).toEqual([
    expect.objectContaining({ field: "title", authority: "review_required" }),
    expect.objectContaining({
      field: "description",
      authority: "review_required",
    }),
    expect.objectContaining({ field: "status", authority: "review_required" }),
    expect.objectContaining({ field: "project", authority: "review_required" }),
  ]);
  expect(updatedIssues).toHaveLength(1);
  expect(updatedIssues[0]).toEqual(
    expect.objectContaining({
      issueId: "issue-5",
      title: "Linear title",
      description: "Linear body",
      stateId: "state-2",
      projectId: "proj-remote",
      assigneeId: "user-1",
    })
  );
});

test("syncTicketToLinearIssue does not duplicate legacy body conflicts after field normalization", async () => {
  const recordedConflicts: Array<{
    readonly field: string;
    readonly authority?: string;
  }> = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      teamId: "team-1",
      additionalProjects: [],
    },
    assigneeMappings: [],
    tickets: {
      getTicket: async () => ({
        ticketId: "T-00006",
        title: "Local title",
        body: "Local body",
        status: "open" as const,
        createdAt: "2026-03-05T10:00:00.000Z",
        updatedAt: "2026-03-05T10:00:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "hack",
        source: "linear",
        assignee: "alice@example.com",
        tags: [],
        externalSystem: "linear",
        externalId: "issue-6",
        externalKey: "ENG-666",
        externalProjectId: "proj-local",
        externalTeamId: "team-1",
      }),
      updateTicket: async () => ({ ok: true as const }),
      listTickets: async () => [],
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [
          {
            conflictId: "conflict-body",
            ticketId: "T-00006",
            provider: "linear" as const,
            field: "body",
            status: "open" as const,
            authority: "review_required" as const,
            localValue: "Local body",
            remoteValue: "Linear body",
            createdAt: "2026-03-05T10:05:00.000Z",
            updatedAt: "2026-03-05T10:05:00.000Z",
          },
        ],
      }),
      linkCommentExternalId: async () => ({ ok: true as const }),
      recordSyncCheckpoint: async () => ({
        ok: true as const,
        checkpoint: {
          checkpointId: "checkpoint-6",
          ticketId: "T-00006",
          provider: "linear",
          direction: "hack_to_linear",
          actor: "test",
          createdAt: "2026-03-05T10:10:00.000Z",
        },
      }),
      recordSyncConflict: async (input: {
        readonly field: string;
        readonly authority?: string;
      }) => {
        recordedConflicts.push(input);
        return {
          ok: true as const,
          conflict: {
            conflictId: `conflict-${input.field}`,
            ticketId: "T-00006",
            provider: "linear",
            field: input.field,
            status: "open" as const,
            authority: input.authority,
            createdAt: "2026-03-05T10:10:00.000Z",
            updatedAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
    },
    linear: {
      getIssueById: async () => ({
        ok: true as const,
        data: {
          id: "issue-6",
          identifier: "ENG-666",
          title: "Linear title",
          description: "Linear body",
          state: {
            id: "state-2",
            name: "Done",
            type: "completed" as const,
          },
          url: "https://linear.app/hack/issue/ENG-666",
          teamId: "team-1",
          projectId: "proj-remote",
          assigneeId: "user-1",
          labels: [],
        },
      }),
      getIssueByIdentifier: async () => ({ ok: true as const, data: null }),
      updateIssue: async () => ({
        ok: true as const,
        data: {
          id: "issue-6",
          identifier: "ENG-666",
          title: "Linear title",
          description: "Linear body",
          state: {
            id: "state-2",
            name: "Done",
            type: "completed" as const,
          },
          url: "https://linear.app/hack/issue/ENG-666",
          teamId: "team-1",
          projectId: "proj-remote",
          assigneeId: "user-1",
          labels: [],
        },
      }),
      createIssue: async () => {
        throw new Error("createIssue should not be called");
      },
      listTeamStates: async () => ({
        ok: true as const,
        data: [
          {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          {
            id: "state-2",
            name: "Done",
            type: "completed" as const,
          },
        ],
      }),
      listTeamLabels: async () => ({
        ok: true as const,
        data: [],
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [],
      }),
      createComment: async () => {
        throw new Error("createComment should not be called");
      },
      listTeamUsers: async () => ({
        ok: true as const,
        data: [
          {
            id: "user-1",
            email: "alice@example.com",
            displayName: "Alice",
          },
        ],
      }),
      getProject: async () => ({ ok: true as const, data: null }),
    },
  };

  const result = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00006",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(recordedConflicts).toEqual([
    expect.objectContaining({ field: "title", authority: "review_required" }),
    expect.objectContaining({ field: "status", authority: "review_required" }),
    expect.objectContaining({ field: "project", authority: "review_required" }),
  ]);
});

test("syncTicketToLinearIssue records a deterministic checkpoint idempotency key", async () => {
  const checkpointInputs: Record<string, unknown>[] = [];

  const runtime = {
    profileId: "default",
    apiUrl: "https://api.linear.app/graphql",
    projectBinding: {
      teamId: "team-1",
      additionalProjects: [],
    },
    assigneeMappings: [],
    tickets: {
      getTicket: async () => ({
        ticketId: "T-00003",
        title: "Deterministic checkpoint",
        body: "Keep checkpoint writes idempotent.",
        status: "open" as const,
        createdAt: "2026-03-05T10:00:00.000Z",
        updatedAt: "2026-03-05T10:00:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "hack",
        source: "hack",
        assignee: "alice@example.com",
        tags: [],
        externalSystem: "linear",
        externalId: "issue-3",
        externalKey: "ENG-333",
        externalTeamId: "team-1",
      }),
      updateTicket: async () => ({ ok: true as const }),
      listTickets: async () => [],
      getTicketDetail: async () => ({
        ticket: null,
        events: [],
        comments: [],
        reviewNotes: [],
        syncCheckpoints: [],
        conflicts: [],
      }),
      linkCommentExternalId: async () => ({ ok: true as const }),
      recordSyncCheckpoint: async (input: Record<string, unknown>) => {
        checkpointInputs.push(input);
        return {
          ok: true as const,
          checkpoint: {
            checkpointId: "checkpoint-3",
            ticketId: "T-00003",
            provider: "linear",
            direction: input.direction,
            actor: "test",
            createdAt: "2026-03-05T10:10:00.000Z",
          },
        };
      },
      recordSyncConflict: async () => ({ ok: true as const, conflict: null }),
    },
    linear: {
      getIssueById: async () => ({
        ok: true as const,
        data: {
          id: "issue-3",
          identifier: "ENG-333",
          title: "Deterministic checkpoint",
          description: "Keep checkpoint writes idempotent.",
          state: {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          teamId: "team-1",
          assigneeId: "user-1",
          labels: [],
        },
      }),
      updateIssue: async () => ({
        ok: true as const,
        data: {
          id: "issue-3",
          identifier: "ENG-333",
          title: "Deterministic checkpoint",
          description: "Keep checkpoint writes idempotent.",
          state: {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
          teamId: "team-1",
          assigneeId: "user-1",
          labels: [],
        },
      }),
      createIssue: async () => {
        throw new Error("createIssue should not be called");
      },
      listTeamStates: async () => ({
        ok: true as const,
        data: [
          {
            id: "state-1",
            name: "Todo",
            type: "unstarted" as const,
          },
        ],
      }),
      listTeamLabels: async () => ({
        ok: true as const,
        data: [],
      }),
      listIssueComments: async () => ({
        ok: true as const,
        data: [],
      }),
      createComment: async () => {
        throw new Error("createComment should not be called");
      },
      listTeamUsers: async () => ({
        ok: true as const,
        data: [
          {
            id: "user-1",
            email: "alice@example.com",
            displayName: "Alice",
          },
        ],
      }),
      getIssueByIdentifier: async () => ({ ok: true as const, data: null }),
      getProject: async () => ({ ok: true as const, data: null }),
    },
  };

  const first = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00003",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });
  expect(first.ok).toBe(true);

  const second = await __testOnly.syncTicketToLinearIssue({
    runtime,
    ticketId: "T-00003",
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: false,
      projects: true,
    },
  });
  expect(second.ok).toBe(true);

  expect(checkpointInputs).toHaveLength(2);
  expect(checkpointInputs[0]?.idempotencyKey).toBe(
    checkpointInputs[1]?.idempotencyKey
  );
  expect(checkpointInputs[0]?.idempotencyKey).toContain(
    "linear:checkpoint:T-00003"
  );
});

test("runProjectLinearAutosync syncs issue and project deliveries, then applies them", async () => {
  const appliedDeliveryIds: string[] = [];
  const issueSyncCalls: Array<{ issueIdentifier?: string; issueId?: string }> =
    [];
  const projectSyncCalls: string[][] = [];

  const result = await __testOnly.runProjectLinearAutosync({
    binding: {
      profileId: "work",
      projectId: "proj-default",
      projectName: "Default",
      teamId: "team-default",
      additionalProjects: [
        {
          profileId: "ops",
          projectId: "proj-ops",
          projectName: "Ops",
          teamId: "team-ops",
        },
      ],
    },
    syncToggles: {
      labels: false,
      statuses: true,
      dependencies: true,
      projects: true,
    },
    limit: 10,
    deps: {
      createRuntime: async ({ profileId }) => ({
        ok: true as const,
        value: {
          profileId: profileId ?? "work",
        },
      }),
      listSubscriptions: async ({ profileId, projectId }) => ({
        ok: true as const,
        data: {
          profileId,
          subscriptions:
            profileId === "work" && projectId === "proj-default"
              ? [
                  {
                    id: "sub-default",
                    profileId,
                    projectId,
                    teamId: "team-default",
                    mode: "auto_apply" as const,
                    status: "active" as const,
                  },
                ]
              : [],
        },
      }),
      listDeliveries: async ({ profileId, projectId }) => ({
        ok: true as const,
        data: {
          profileId,
          status: "pending",
          limit: 10,
          deliveries:
            profileId === "work" && projectId === "proj-default"
              ? [
                  {
                    id: "delivery-issue",
                    status: "pending",
                    profileId,
                    projectId,
                    teamId: "team-default",
                    issueIdentifier: "ENG-101",
                  },
                  {
                    id: "delivery-project",
                    status: "pending",
                    profileId,
                    projectId,
                    teamId: "team-default",
                  },
                ]
              : [],
        },
      }),
      syncIssue: async ({ delivery }) => {
        issueSyncCalls.push({
          issueIdentifier: delivery.issueIdentifier,
          issueId: delivery.issueId,
        });
        return {
          ok: true as const,
          operation: "updated" as const,
          ticketId: "T-00101",
          issueIdentifier: delivery.issueIdentifier ?? "ENG-101",
          commentsPulled: 1,
          conflictsRecorded: 0,
          checkpointRecorded: true,
        };
      },
      syncProject: async ({ projectIds }) => {
        projectSyncCalls.push([...projectIds]);
        return {
          ok: true as const,
          projectIds,
          processed: 3,
          created: 1,
          updated: 2,
          commentsPulled: 4,
          conflictsRecorded: 0,
          checkpointsRecorded: 3,
        };
      },
      applyDelivery: async ({ deliveryId }) => {
        appliedDeliveryIds.push(deliveryId);
        return {
          ok: true as const,
          data: {
            deliveryId,
            status: "applied",
          },
        };
      },
      claimedBy: "local-test-runner",
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(issueSyncCalls).toEqual([
    {
      issueIdentifier: "ENG-101",
      issueId: undefined,
    },
  ]);
  expect(projectSyncCalls).toEqual([["proj-default"]]);
  expect(appliedDeliveryIds).toEqual(["delivery-issue", "delivery-project"]);
  expect(result.subscribedRoutes).toBe(1);
  expect(result.processedDeliveries).toBe(2);
  expect(result.appliedDeliveries).toBe(2);
  expect(result.failedDeliveries).toBe(0);
  expect(result.skippedDeliveries).toBe(0);
  expect(result.created).toBe(1);
  expect(result.updated).toBe(3);
  expect(result.commentsPulled).toBe(5);
  expect(result.checkpointsRecorded).toBe(4);
});
