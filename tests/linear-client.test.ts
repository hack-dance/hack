import { afterEach, expect, test } from "bun:test";

import { createLinearClient } from "../src/control-plane/extensions/linear/client.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("getIssueByIdentifier includes assignee data when present", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            id: "issue_123",
            identifier: "ENG-123",
            title: "Ship assignee sync",
            description: "Make assignee sync work",
            url: "https://linear.app/issue/ENG-123",
            state: {
              id: "state_123",
              name: "In Progress",
              type: "started",
            },
            team: {
              id: "team_123",
              key: "ENG",
              name: "Engineering",
            },
            project: {
              id: "project_123",
              name: "Linear Sync",
            },
            assignee: {
              id: "user_123",
              name: "Alice Example",
              displayName: "Alice",
              email: "alice@example.com",
              active: true,
            },
            labels: {
              nodes: [],
            },
            parent: null,
          },
        },
      }),
      { status: 200 }
    );
  };

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.getIssueByIdentifier({ identifier: "ENG-123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(String(requestBody?.query)).toContain("assignee {");
  expect(result.data?.assigneeId).toBe("user_123");
  expect(result.data?.assigneeName).toBe("Alice Example");
  expect(result.data?.assigneeDisplayName).toBe("Alice");
  expect(result.data?.assigneeEmail).toBe("alice@example.com");
  expect(result.data?.assigneeActive).toBe(true);
});

test("listTeamUsers returns membership users for assignee mapping", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          team: {
            memberships: {
              nodes: [
                {
                  user: {
                    id: "user_123",
                    name: "Alice Example",
                    displayName: "Alice",
                    email: "alice@example.com",
                    active: true,
                  },
                },
                {
                  user: {
                    id: "user_456",
                    name: "Bob Example",
                    email: "bob@example.com",
                    active: false,
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  };

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listTeamUsers({ teamId: "team_123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(String(requestBody?.query)).toContain("memberships");
  expect(result.data).toEqual([
    {
      id: "user_123",
      name: "Alice Example",
      displayName: "Alice",
      email: "alice@example.com",
      active: true,
    },
    {
      id: "user_456",
      name: "Bob Example",
      email: "bob@example.com",
      active: false,
    },
  ]);
});

test("listIssueComments parses issue comments", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  id: "comment_123",
                  body: "First sync comment",
                  createdAt: "2026-03-05T10:00:00.000Z",
                  updatedAt: "2026-03-05T10:00:00.000Z",
                  user: {
                    id: "user_123",
                    name: "Alice Example",
                    displayName: "Alice",
                    email: "alice@example.com",
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  };

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listIssueComments({ issueId: "issue_123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(String(requestBody?.query)).toContain("comments(");
  expect(result.data).toEqual([
    {
      id: "comment_123",
      body: "First sync comment",
      createdAt: "2026-03-05T10:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
      userId: "user_123",
      userName: "Alice Example",
      userDisplayName: "Alice",
      userEmail: "alice@example.com",
    },
  ]);
});

test("createComment returns created comment payload", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment_123",
              body: "Ship it",
              createdAt: "2026-03-05T11:00:00.000Z",
              updatedAt: "2026-03-05T11:00:00.000Z",
              user: {
                id: "user_123",
                displayName: "Alice",
              },
            },
          },
        },
      }),
      { status: 200 }
    );
  };

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.createComment({
    issueId: "issue_123",
    body: "Ship it",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(String(requestBody?.query)).toContain("commentCreate");
  expect(requestBody?.variables).toEqual({
    input: {
      issueId: "issue_123",
      body: "Ship it",
    },
  });
  expect(result.data).toEqual({
    id: "comment_123",
    body: "Ship it",
    createdAt: "2026-03-05T11:00:00.000Z",
    updatedAt: "2026-03-05T11:00:00.000Z",
    userId: "user_123",
    userDisplayName: "Alice",
  });
});

test("updateIssue forwards assigneeId when provided", async () => {
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue_123",
              identifier: "ENG-123",
              title: "Ship assignee sync",
              description: "Make assignee sync work",
              state: {
                id: "state_123",
                name: "In Progress",
                type: "started",
              },
              team: {
                id: "team_123",
              },
              assignee: {
                id: "user_123",
                displayName: "Alice",
                email: "alice@example.com",
              },
              labels: {
                nodes: [],
              },
              parent: null,
            },
          },
        },
      }),
      { status: 200 }
    );
  };

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.updateIssue({
    issueId: "issue_123",
    title: "Ship assignee sync",
    assigneeId: "user_123",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(requestBody?.variables).toEqual({
    id: "issue_123",
    input: {
      title: "Ship assignee sync",
      assigneeId: "user_123",
    },
  });
  expect(result.data?.assigneeId).toBe("user_123");
});
