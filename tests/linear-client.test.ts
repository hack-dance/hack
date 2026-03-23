import { afterEach, expect, test } from "bun:test";

import { createLinearClient } from "../src/control-plane/extensions/linear/client.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("getIssueByIdentifier includes assignee data when present", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
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
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.getIssueByIdentifier({ identifier: "ENG-123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("assignee {");
  expect(result.data?.assigneeId).toBe("user_123");
  expect(result.data?.assigneeName).toBe("Alice Example");
  expect(result.data?.assigneeDisplayName).toBe("Alice");
  expect(result.data?.assigneeEmail).toBe("alice@example.com");
  expect(result.data?.assigneeActive).toBe(true);
});

test("getViewer sends bearer authorization for oauth tokens", async () => {
  let authorization: string | null = null;
  let requestedUrl: string | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestedUrl =
      typeof _input === "string"
        ? _input
        : _input instanceof URL
          ? _input.toString()
          : _input.url;
    if (
      init?.headers &&
      typeof Headers !== "undefined" &&
      init.headers instanceof Headers
    ) {
      authorization = init.headers.get("Authorization");
    } else if (init?.headers && !Array.isArray(init.headers)) {
      authorization =
        (init.headers as Record<string, string>).Authorization ?? null;
    }
    return new Response(
      JSON.stringify({
        data: {
          viewer: {
            id: "usr_123",
            name: "Alice Example",
            email: "alice@example.com",
            displayName: "Alice",
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({
    token: "linear-oauth-token",
    apiUrl: "https://api.linear.app",
  });
  const result = await client.getViewer();

  expect(result.ok).toBe(true);
  expect(authorization ?? "").toBe("Bearer linear-oauth-token");
  expect(requestedUrl ?? "").toBe("https://api.linear.app/graphql");
});

test("listProjects queries the top-level projects connection", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          projects: {
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
            nodes: [
              {
                id: "project_123",
                name: "Event Agent",
                teams: {
                  nodes: [
                    {
                      id: "team_123",
                      key: "OPS",
                      name: "Operations",
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listProjects();

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("projects(first: $first, after: $after)");
  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).not.toContain("viewer {");
  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("teams {");
  expect(result.data).toEqual([
    {
      id: "project_123",
      name: "Event Agent",
      teamId: "team_123",
      teamKey: "OPS",
      teamName: "Operations",
    },
  ]);
});

test("listProjectIssuesPage queries project teams instead of deprecated project.team", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          project: {
            id: "project_live_nation",
            name: "Live Nation",
            teams: {
              nodes: [
                {
                  id: "team_hack",
                  key: "HACK",
                  name: "Hack",
                },
              ],
            },
            issues: {
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
              nodes: [
                {
                  id: "issue_123",
                  identifier: "HACK-123",
                  title: "Sync Linear issues",
                  description: "Bring issues across.",
                  url: "https://linear.app/issue/HACK-123",
                  state: {
                    id: "state_1",
                    name: "Todo",
                    type: "unstarted",
                  },
                  team: {
                    id: "team_hack",
                    key: "HACK",
                    name: "Hack",
                  },
                  project: {
                    id: "project_live_nation",
                    name: "Live Nation",
                  },
                  assignee: null,
                  labels: { nodes: [] },
                  parent: null,
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listProjectIssuesPage({
    projectId: "project_live_nation",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  const query = String(
    (requestBody as { readonly query?: unknown } | null)?.query ?? ""
  );
  expect(query).toContain("project(id: $projectId)");
  expect(query).toContain("teams {");
  expect(query).not.toContain(
    "project(id: $projectId) {\n    id\n    name\n    team {"
  );
  expect(result.data.project).toEqual({
    id: "project_live_nation",
    name: "Live Nation",
    teamId: "team_hack",
    teamKey: "HACK",
    teamName: "Hack",
  });
  expect(result.data.issues).toHaveLength(1);
  expect(result.data.issues[0]?.projectName).toBe("Live Nation");
});

test("listTeamUsers returns membership users for assignee mapping", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
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
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listTeamUsers({ teamId: "team_123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("memberships");
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
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
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
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listIssueComments({ issueId: "issue_123" });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("comments(");
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
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
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
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.createComment({
    issueId: "issue_123",
    body: "Ship it",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("commentCreate");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
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
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
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
  }) as typeof fetch;

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

  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    id: "issue_123",
    input: {
      title: "Ship assignee sync",
      assigneeId: "user_123",
    },
  });
  expect(result.data?.assigneeId).toBe("user_123");
});

test("listProjectDocuments returns project-scoped documents", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          project: {
            documents: {
              nodes: [
                {
                  id: "doc_123",
                  title: "Launch plan",
                  content: "# Launch plan",
                  url: "https://linear.app/docs/doc_123",
                  slugId: "launch-plan",
                  sortOrder: 42,
                  icon: "rocket",
                  trashed: false,
                  updatedAt: "2026-03-14T10:00:00.000Z",
                  project: {
                    id: "project_123",
                    name: "Linear dogfood",
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listProjectDocuments({
    projectId: "project_123",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("documents(first: $first)");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    projectId: "project_123",
    first: 50,
  });
  expect(result.data).toEqual([
    {
      id: "doc_123",
      title: "Launch plan",
      content: "# Launch plan",
      url: "https://linear.app/docs/doc_123",
      slugId: "launch-plan",
      sortOrder: 42,
      icon: "rocket",
      projectId: "project_123",
      projectName: "Linear dogfood",
      archived: false,
      updatedAt: "2026-03-14T10:00:00.000Z",
    },
  ]);
});

test("createProjectDocument sends documentCreate mutation for a project", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          documentCreate: {
            success: true,
            document: {
              id: "doc_123",
              title: "Launch plan",
              content: "# Launch plan",
              slugId: "launch-plan",
              sortOrder: 1,
              icon: "rocket",
              trashed: false,
              project: {
                id: "project_123",
                name: "Linear dogfood",
              },
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.createProjectDocument({
    projectId: "project_123",
    title: "Launch plan",
    content: "# Launch plan",
    icon: "rocket",
    sortOrder: 1,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("mutation LinearDocumentCreate");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    input: {
      projectId: "project_123",
      title: "Launch plan",
      content: "# Launch plan",
      icon: "rocket",
      sortOrder: 1,
    },
  });
  expect(result.data).toMatchObject({
    id: "doc_123",
    projectId: "project_123",
    projectName: "Linear dogfood",
    archived: false,
  });
});

test("updateProjectDocument sends documentUpdate mutation for a managed document", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          documentUpdate: {
            success: true,
            document: {
              id: "doc_123",
              title: "Launch plan v2",
              content: "# Launch plan v2",
              slugId: "launch-plan",
              sortOrder: 2,
              icon: "rocket",
              trashed: false,
              project: {
                id: "project_123",
                name: "Linear dogfood",
              },
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.updateProjectDocument({
    documentId: "doc_123",
    title: "Launch plan v2",
    content: "# Launch plan v2",
    sortOrder: 2,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("mutation LinearDocumentUpdate");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    id: "doc_123",
    input: {
      title: "Launch plan v2",
      content: "# Launch plan v2",
      sortOrder: 2,
    },
  });
  expect(result.data.title).toBe("Launch plan v2");
});

test("listProjectMilestones returns structured milestones", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          project: {
            projectMilestones: {
              nodes: [
                {
                  id: "milestone_123",
                  name: "Private beta",
                  description: "Ship the beta cohort",
                  sortOrder: 7,
                  status: "pending",
                  targetDate: "2026-04-01",
                  archivedAt: null,
                  updatedAt: "2026-03-14T10:00:00.000Z",
                  project: {
                    id: "project_123",
                    name: "Linear dogfood",
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listProjectMilestones({
    projectId: "project_123",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("projectMilestones(first: $first)");
  expect(result.data).toEqual([
    {
      id: "milestone_123",
      title: "Private beta",
      description: "Ship the beta cohort",
      sortOrder: 7,
      status: "pending",
      targetDate: "2026-04-01",
      projectId: "project_123",
      projectName: "Linear dogfood",
      archived: false,
      updatedAt: "2026-03-14T10:00:00.000Z",
    },
  ]);
});

test("createProjectMilestone sends projectMilestoneCreate mutation", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          projectMilestoneCreate: {
            success: true,
            projectMilestone: {
              id: "milestone_123",
              name: "Private beta",
              description: "Ship the beta cohort",
              sortOrder: 7,
              status: "pending",
              targetDate: "2026-04-01",
              archivedAt: null,
              project: {
                id: "project_123",
                name: "Linear dogfood",
              },
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.createProjectMilestone({
    projectId: "project_123",
    title: "Private beta",
    description: "Ship the beta cohort",
    sortOrder: 7,
    targetDate: "2026-04-01",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("mutation LinearProjectMilestoneCreate");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    input: {
      projectId: "project_123",
      name: "Private beta",
      description: "Ship the beta cohort",
      sortOrder: 7,
      targetDate: "2026-04-01",
    },
  });
  expect(result.data.title).toBe("Private beta");
});

test("listProjectUpdates returns project updates with health", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          project: {
            projectUpdates: {
              nodes: [
                {
                  id: "update_123",
                  body: "Still on track for dogfooding.",
                  health: "onTrack",
                  slugId: "weekly-update",
                  createdAt: "2026-03-14T10:00:00.000Z",
                  updatedAt: "2026-03-14T10:15:00.000Z",
                  url: "https://linear.app/project/update_123",
                  user: {
                    id: "user_123",
                    name: "Alice Example",
                    displayName: "Alice",
                    email: "alice@example.com",
                  },
                  project: {
                    id: "project_123",
                    name: "Linear dogfood",
                  },
                },
              ],
            },
          },
        },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.listProjectUpdates({
    projectId: "project_123",
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("projectUpdates(first: $first)");
  expect(result.data).toEqual([
    {
      id: "update_123",
      body: "Still on track for dogfooding.",
      health: "onTrack",
      slugId: "weekly-update",
      createdAt: "2026-03-14T10:00:00.000Z",
      updatedAt: "2026-03-14T10:15:00.000Z",
      url: "https://linear.app/project/update_123",
      projectId: "project_123",
      projectName: "Linear dogfood",
      userId: "user_123",
      userName: "Alice Example",
      userDisplayName: "Alice",
      userEmail: "alice@example.com",
    },
  ]);
});

test("createProjectUpdate sends projectUpdateCreate mutation", async () => {
  let requestBody: {
    readonly query?: unknown;
    readonly variables?: unknown;
  } | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as {
      readonly query?: unknown;
      readonly variables?: unknown;
    };
    return new Response(
      JSON.stringify({
        data: {
          projectUpdateCreate: {
            success: true,
            projectUpdate: {
              id: "update_123",
              body: "Still on track for dogfooding.",
              health: "onTrack",
              slugId: "weekly-update",
              createdAt: "2026-03-14T10:00:00.000Z",
              updatedAt: "2026-03-14T10:15:00.000Z",
              project: {
                id: "project_123",
                name: "Linear dogfood",
              },
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
  }) as typeof fetch;

  const client = createLinearClient({ token: "linear-token" });
  const result = await client.createProjectUpdate({
    projectId: "project_123",
    body: "Still on track for dogfooding.",
    health: "onTrack",
    isDiffHidden: true,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }

  expect(
    String((requestBody as { readonly query?: unknown } | null)?.query ?? "")
  ).toContain("mutation LinearProjectUpdateCreate");
  expect(
    (requestBody as { readonly variables?: unknown } | null)?.variables
  ).toEqual({
    input: {
      projectId: "project_123",
      body: "Still on track for dogfooding.",
      health: "onTrack",
      isDiffHidden: true,
    },
  });
  expect(result.data.userDisplayName).toBe("Alice");
});
