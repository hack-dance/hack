import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { resolveLinearToken } from "../src/control-plane/extensions/linear/auth.ts";
import {
  __testOnly,
  LINEAR_COMMANDS,
} from "../src/control-plane/extensions/linear/commands.ts";

let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(resolve(tmpdir(), "hack-linear-artifacts-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
});

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
    "body",
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
  expect(conflicts).toEqual(["title", "body", "status", "project"]);
  expect(checkpoints).toEqual(["linear_to_hack"]);
  expect(updatedTickets).toHaveLength(1);
  expect(updatedTickets[0]?.title).toBeUndefined();
  expect(updatedTickets[0]?.body).toBeUndefined();
  expect(updatedTickets[0]?.assignee).toBe("Remote Owner");
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

test("parseProjectDocumentsArgs parses verb and shared routing flags", () => {
  const parsed = __testOnly.parseProjectDocumentsArgs({
    args: [
      "list",
      "--profile",
      "work",
      "--project-id",
      "proj_123",
      "--project-name",
      "Platform",
      "--team-id",
      "team_123",
      "--path",
      ".hack/linear/projects/proj_123/documents",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    verb: "list",
    profileId: "work",
    projectId: "proj_123",
    projectName: "Platform",
    teamId: "team_123",
    path: ".hack/linear/projects/proj_123/documents",
    json: true,
  });
});

test("parseProjectMilestonesArgs parses apply verbs and file paths", () => {
  const parsed = __testOnly.parseProjectMilestonesArgs({
    args: [
      "apply",
      "--path",
      ".hack/linear/projects/proj_123/milestones/private-beta.md",
      "--json",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    verb: "apply",
    path: ".hack/linear/projects/proj_123/milestones/private-beta.md",
    json: true,
  });
});

test("parseProjectStatusUpdatesArgs parses publish verbs", () => {
  const parsed = __testOnly.parseProjectStatusUpdatesArgs({
    args: [
      "publish",
      "--profile",
      "work",
      "--project-id",
      "proj_123",
      "--path",
      ".hack/linear/projects/proj_123/status-updates/drafts/2026-03-14-weekly.md",
    ],
  });

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }

  expect(parsed.value).toEqual({
    verb: "publish",
    profileId: "work",
    projectId: "proj_123",
    path: ".hack/linear/projects/proj_123/status-updates/drafts/2026-03-14-weekly.md",
    json: false,
  });
});

test("parseProjectDocumentsArgs rejects archive until destructive flows are implemented", () => {
  const parsed = __testOnly.parseProjectDocumentsArgs({
    args: ["archive"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("Expected list|pull|plan|apply");
});

test("parseProjectMilestonesArgs rejects archive until destructive flows are implemented", () => {
  const parsed = __testOnly.parseProjectMilestonesArgs({
    args: ["archive"],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) {
    return;
  }

  expect(parsed.error).toContain("Expected list|pull|plan|apply");
});

test("LINEAR_COMMANDS registers project artifact command families", () => {
  const names = LINEAR_COMMANDS.map((command) => command.name);

  expect(names).toContain("documents");
  expect(names).toContain("milestones");
  expect(names).toContain("status-updates");
});

test("runProjectArtifactCommand pulls project documents into repo state", async () => {
  const projectDir = ensureTempDir();
  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "pull",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_123",
              title: "Launch plan",
              content: "# Launch plan\n",
              slugId: "launch-plan",
              sortOrder: 1,
              icon: "rocket",
              archived: false,
              updatedAt: "2026-03-14T10:00:00.000Z",
            },
          ],
        }),
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.payload.changed).toBe(1);
  expect(result.payload.writtenPaths).toEqual([
    resolve(
      projectDir,
      ".hack/linear/projects/proj_123/documents/launch-plan.md"
    ),
  ]);

  const file = await Bun.file(result.payload.writtenPaths[0] ?? "").text();
  expect(file).toContain("kind: linear-project-document");
  expect(file).toContain("linearId: doc_123");
  expect(file).toContain("icon: rocket");
});

test("runProjectArtifactCommand pull refuses to overwrite unmanaged files", async () => {
  const projectDir = ensureTempDir();
  const targetPath = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents/launch-plan.md"
  );
  await mkdir(resolve(targetPath, ".."), { recursive: true });
  await writeFile(targetPath, "# local scratch notes\n");

  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "pull",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_123",
              title: "Launch plan",
              content: "# Launch plan\n",
              slugId: "launch-plan",
              archived: false,
            },
          ],
        }),
      },
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.error).toContain("Refusing to overwrite unmanaged file");
  expect(await Bun.file(targetPath).text()).toBe("# local scratch notes\n");
});

test("runProjectArtifactCommand pull reconciles renamed managed files to the canonical path", async () => {
  const projectDir = ensureTempDir();
  const documentsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents"
  );
  await mkdir(documentsDir, { recursive: true });
  const oldPath = resolve(documentsDir, "old-plan.md");
  await writeFile(
    oldPath,
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Old plan
linearId: doc_123
slug: old-plan
archived: false
---
# Old plan
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "pull",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_123",
              title: "Launch plan",
              content: "# Launch plan\n",
              slugId: "launch-plan",
              archived: false,
            },
          ],
        }),
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  const newPath = resolve(documentsDir, "launch-plan.md");
  expect(result.payload.writtenPaths).toEqual([newPath]);
  expect(await Bun.file(newPath).exists()).toBe(true);
  expect(await Bun.file(oldPath).exists()).toBe(false);
});

test("runProjectArtifactCommand plans create update noop and remote-only documents", async () => {
  const projectDir = ensureTempDir();
  const documentsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents"
  );
  await mkdir(documentsDir, { recursive: true });
  await writeFile(
    resolve(documentsDir, "create-me.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Create me
slug: create-me
archived: false
---
# Create me
`
  );
  await writeFile(
    resolve(documentsDir, "update-me.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Update me
linearId: doc_update
slug: update-me
archived: false
---
# Updated body
`
  );
  await writeFile(
    resolve(documentsDir, "noop-me.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: No-op me
linearId: doc_noop
slug: noop-me
archived: false
---
# No changes
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "plan",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_update",
              title: "Update me",
              content: "# Old body\n",
              slugId: "update-me",
              archived: false,
            },
            {
              id: "doc_noop",
              title: "No-op me",
              content: "# No changes\n",
              slugId: "noop-me",
              archived: false,
            },
            {
              id: "doc_remote",
              title: "Remote only",
              content: "# Remote only\n",
              slugId: "remote-only",
              archived: false,
            },
          ],
        }),
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.payload.summary).toEqual({
    create: 1,
    update: 1,
    noop: 1,
    remoteOnly: 1,
    errors: 0,
  });
});

test("runProjectArtifactCommand plan fails on duplicate managed mappings", async () => {
  const projectDir = ensureTempDir();
  const documentsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents"
  );
  await mkdir(documentsDir, { recursive: true });
  await writeFile(
    resolve(documentsDir, "first.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: First
linearId: doc_dup
slug: first
archived: false
---
# First
`
  );
  await writeFile(
    resolve(documentsDir, "second.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Second
linearId: doc_dup
slug: second
archived: false
---
# Second
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "plan",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [],
        }),
      },
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.error).toContain('Duplicate local linearId "doc_dup"');
});

test("runProjectArtifactCommand applies document upserts and writes back linear ids", async () => {
  const projectDir = ensureTempDir();
  const documentsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents"
  );
  await mkdir(documentsDir, { recursive: true });
  await writeFile(
    resolve(documentsDir, "create-me.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Create me
slug: create-me
archived: false
---
# Create me
`
  );
  await writeFile(
    resolve(documentsDir, "update-me.md"),
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Update me
linearId: doc_update
slug: update-me
archived: false
---
# Updated body
`
  );

  const createCalls: string[] = [];
  const updateCalls: string[] = [];
  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "apply",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_update",
              title: "Update me",
              content: "# Old body\n",
              slugId: "update-me",
              archived: false,
            },
          ],
        }),
        createProjectDocument: async ({ title }) => {
          createCalls.push(title);
          return {
            ok: true as const,
            data: {
              id: "doc_create",
              title,
              content: "# Create me\n",
              slugId: "create-me",
              archived: false,
              updatedAt: "2026-03-15T09:00:00.000Z",
            },
          };
        },
        updateProjectDocument: async ({ documentId, title }) => {
          updateCalls.push(`${documentId}:${title ?? ""}`);
          return {
            ok: true as const,
            data: {
              id: documentId,
              title: title ?? "Update me",
              content: "# Updated body\n",
              slugId: "update-me",
              archived: false,
              updatedAt: "2026-03-15T10:00:00.000Z",
            },
          };
        },
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(createCalls).toEqual(["Create me"]);
  expect(updateCalls).toEqual(["doc_update:Update me"]);
  expect(result.payload.summary.created).toBe(1);
  expect(result.payload.summary.updated).toBe(1);

  const createdText = await Bun.file(
    resolve(documentsDir, "create-me.md")
  ).text();
  expect(createdText).toContain("linearId: doc_create");
  expect(createdText).toContain("updatedAt: 2026-03-15T09:00:00.000Z");
});

test("runProjectArtifactCommand apply rewrites renamed managed documents to the canonical path", async () => {
  const projectDir = ensureTempDir();
  const documentsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/documents"
  );
  await mkdir(documentsDir, { recursive: true });
  const oldPath = resolve(documentsDir, "old-name.md");
  await writeFile(
    oldPath,
    `---
kind: linear-project-document
linearProjectId: proj_123
title: Old name
linearId: doc_update
slug: old-name
archived: false
---
# Updated body
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "documents",
    verb: "apply",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        listProjectDocuments: async () => ({
          ok: true as const,
          data: [
            {
              id: "doc_update",
              title: "Old name",
              content: "# Old body\n",
              slugId: "old-name",
              archived: false,
            },
          ],
        }),
        updateProjectDocument: async ({ documentId }) => ({
          ok: true as const,
          data: {
            id: documentId,
            title: "New name",
            content: "# Updated body\n",
            slugId: "new-name",
            archived: false,
            updatedAt: "2026-03-15T10:00:00.000Z",
          },
        }),
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  const newPath = resolve(documentsDir, "new-name.md");
  expect(result.payload.writtenPaths).toEqual([newPath]);
  expect(await Bun.file(newPath).exists()).toBe(true);
  expect(await Bun.file(oldPath).exists()).toBe(false);
});

test("runProjectArtifactCommand publishes draft status updates and moves them to published", async () => {
  const projectDir = ensureTempDir();
  const draftsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/status-updates/drafts"
  );
  await mkdir(draftsDir, { recursive: true });
  await writeFile(
    resolve(draftsDir, "2026-03-14-weekly.md"),
    `---
kind: linear-project-status-update
linearProjectId: proj_123
title: Weekly update
slug: weekly
archived: false
date: 2026-03-14
health: onTrack
---
Still on track for dogfooding.
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "status-updates",
    verb: "publish",
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        createProjectUpdate: async ({ body, health }) => ({
          ok: true as const,
          data: {
            id: "update_123",
            body,
            health,
            slugId: "weekly",
            createdAt: "2026-03-14T10:00:00.000Z",
            updatedAt: "2026-03-14T10:15:00.000Z",
            projectId: "proj_123",
            projectName: "Dogfood",
          },
        }),
      },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(result.payload.summary.published).toBe(1);
  expect(result.payload.movedPaths).toEqual([
    {
      from: resolve(draftsDir, "2026-03-14-weekly.md"),
      to: resolve(
        projectDir,
        ".hack/linear/projects/proj_123/status-updates/published/2026-03-14-weekly.md"
      ),
    },
  ]);

  const publishedText = await Bun.file(
    result.payload.movedPaths[0]?.to ?? ""
  ).text();
  expect(publishedText).toContain("linearId: update_123");
  expect(publishedText).toContain("updatedAt: 2026-03-14T10:15:00.000Z");
});

test("runProjectArtifactCommand publish fails for drafts that already have a remote id", async () => {
  const projectDir = ensureTempDir();
  const draftsDir = resolve(
    projectDir,
    ".hack/linear/projects/proj_123/status-updates/drafts"
  );
  await mkdir(draftsDir, { recursive: true });
  const draftPath = resolve(draftsDir, "2026-03-14-weekly.md");
  await writeFile(
    draftPath,
    `---
kind: linear-project-status-update
linearProjectId: proj_123
title: Weekly update
linearId: update_123
slug: weekly
archived: false
date: 2026-03-14
health: onTrack
---
Still on track for dogfooding.
`
  );

  const result = await __testOnly.runProjectArtifactCommand({
    family: "status-updates",
    verb: "publish",
    path: draftPath,
    runtime: {
      profileId: "work",
      projectDir,
      projectId: "proj_123",
      linear: {
        createProjectUpdate: async () => {
          throw new Error("should not be called");
        },
      },
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }

  expect(result.error).toContain(
    "Publish requires a draft status update without a linearId"
  );
});

function ensureTempDir(): string {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  return tempDir;
}
