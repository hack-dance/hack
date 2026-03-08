import { isRecord } from "../../../lib/guards.ts";

export type LinearWorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export type LinearWorkflowState = {
  readonly id: string;
  readonly name: string;
  readonly type: LinearWorkflowStateType;
};

export type LinearLabel = {
  readonly id: string;
  readonly name: string;
};

export type LinearProject = {
  readonly id: string;
  readonly name: string;
  readonly teamId: string;
  readonly teamKey?: string;
  readonly teamName?: string;
};

export type LinearUser = {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly active?: boolean;
};

export type LinearComment = {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly userDisplayName?: string;
  readonly userEmail?: string;
};

export type LinearIssue = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly state: LinearWorkflowState;
  readonly teamId: string;
  readonly teamKey?: string;
  readonly teamName?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly assigneeId?: string;
  readonly assigneeName?: string;
  readonly assigneeDisplayName?: string;
  readonly assigneeEmail?: string;
  readonly assigneeActive?: boolean;
  readonly labels: readonly LinearLabel[];
  readonly parentId?: string;
  readonly parentIdentifier?: string;
};

type LinearGraphQlError = {
  readonly message: string;
};

type LinearRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly graphQLErrors?: readonly LinearGraphQlError[];
    };

type LinearProjectIssuePage = {
  readonly project: LinearProject;
  readonly issues: readonly LinearIssue[];
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
};

export type LinearClient = {
  readonly getViewer: () => Promise<
    LinearRequestResult<{
      readonly id: string;
      readonly name?: string;
      readonly email?: string;
      readonly displayName?: string;
    }>
  >;
  readonly listProjects: (input?: {
    readonly first?: number;
  }) => Promise<LinearRequestResult<readonly LinearProject[]>>;
  readonly getProject: (input: {
    readonly projectId: string;
  }) => Promise<LinearRequestResult<LinearProject | null>>;
  readonly getIssueByIdentifier: (input: {
    readonly identifier: string;
  }) => Promise<LinearRequestResult<LinearIssue | null>>;
  readonly getIssueById: (input: {
    readonly issueId: string;
  }) => Promise<LinearRequestResult<LinearIssue | null>>;
  readonly createIssue: (input: {
    readonly teamId: string;
    readonly title: string;
    readonly description?: string;
    readonly projectId?: string;
    readonly stateId?: string;
    readonly assigneeId?: string;
    readonly labelIds?: readonly string[];
    readonly parentId?: string;
  }) => Promise<LinearRequestResult<LinearIssue>>;
  readonly updateIssue: (input: {
    readonly issueId: string;
    readonly title?: string;
    readonly description?: string;
    readonly projectId?: string;
    readonly stateId?: string;
    readonly assigneeId?: string;
    readonly labelIds?: readonly string[];
    readonly parentId?: string;
  }) => Promise<LinearRequestResult<LinearIssue>>;
  readonly listProjectIssuesPage: (input: {
    readonly projectId: string;
    readonly first?: number;
    readonly after?: string;
  }) => Promise<LinearRequestResult<LinearProjectIssuePage>>;
  readonly listTeamStates: (input: {
    readonly teamId: string;
  }) => Promise<LinearRequestResult<readonly LinearWorkflowState[]>>;
  readonly listTeamLabels: (input: {
    readonly teamId: string;
  }) => Promise<LinearRequestResult<readonly LinearLabel[]>>;
  readonly listTeamUsers: (input: {
    readonly teamId: string;
    readonly first?: number;
  }) => Promise<LinearRequestResult<readonly LinearUser[]>>;
  readonly listIssueComments: (input: {
    readonly issueId: string;
    readonly first?: number;
  }) => Promise<LinearRequestResult<readonly LinearComment[]>>;
  readonly createComment: (input: {
    readonly issueId: string;
    readonly body: string;
  }) => Promise<LinearRequestResult<LinearComment>>;
};

const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";
const DEFAULT_PAGE_SIZE = 50;

/**
 * Build a Linear GraphQL client for issue/project sync operations.
 */
export function createLinearClient(input: {
  readonly token: string;
  readonly apiUrl?: string;
}): LinearClient {
  const token = input.token.trim();
  const apiUrl = normalizeApiUrl({
    value: input.apiUrl ?? DEFAULT_LINEAR_API_URL,
  });

  const request = async <T>(req: {
    readonly query: string;
    readonly variables?: Record<string, unknown>;
  }): Promise<LinearRequestResult<T>> => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "hack-cli",
      },
      body: JSON.stringify({
        query: req.query,
        ...(req.variables ? { variables: req.variables } : {}),
      }),
    });

    const payload = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(payload)) {
      return {
        ok: false,
        status: response.status,
        error: `Linear request failed (${response.status}): invalid response payload.`,
      };
    }

    const errors = parseGraphQlErrors(payload.errors);
    if (!(response.ok && errors.length === 0)) {
      const errorMessage =
        errors[0]?.message ?? `Linear request failed (${response.status}).`;
      return {
        ok: false,
        status: response.status,
        error: errorMessage,
        ...(errors.length > 0 ? { graphQLErrors: errors } : {}),
      };
    }

    return {
      ok: true,
      data: payload.data as T,
    };
  };

  return {
    getViewer: async () => {
      const result = await request<{
        readonly viewer?: unknown;
      }>({
        query: [
          "query LinearViewer {",
          "  viewer {",
          "    id",
          "    name",
          "    email",
          "    displayName",
          "  }",
          "}",
        ].join("\n"),
      });
      if (!result.ok) {
        return result;
      }
      const viewer = parseViewer(result.data.viewer);
      if (!viewer) {
        return {
          ok: false,
          status: 500,
          error: "Linear viewer payload missing required fields.",
        };
      }
      return {
        ok: true,
        data: viewer,
      };
    },

    listProjects: async (input = {}) => {
      const first = normalizePositiveInt({
        value: input.first,
        fallback: DEFAULT_PAGE_SIZE,
      });
      const result = await request<{
        readonly viewer?: unknown;
      }>({
        query: [
          "query LinearProjects($first: Int!) {",
          "  viewer {",
          "    projects(first: $first) {",
          "      nodes {",
          "        id",
          "        name",
          "        team { id key name }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { first },
      });
      if (!result.ok) {
        return result;
      }
      const projects = parseViewerProjects(result.data.viewer);
      return { ok: true, data: projects };
    },

    getProject: async ({ projectId }) => {
      const id = projectId.trim();
      if (!id) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear project id.",
        };
      }
      const result = await request<{
        readonly project?: unknown;
      }>({
        query: [
          "query LinearProject($projectId: String!) {",
          "  project(id: $projectId) {",
          "    id",
          "    name",
          "    team { id key name }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          projectId: id,
        },
      });
      if (!result.ok) {
        return result;
      }
      const project = parseProject(result.data.project);
      return {
        ok: true,
        data: project,
      };
    },

    getIssueByIdentifier: async ({ identifier }) => {
      const normalized = identifier.trim();
      if (!normalized) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear issue identifier.",
        };
      }
      const result = await request<{
        readonly issue?: unknown;
      }>({
        query: issueFieldsQuery({
          root: "issue(identifier: $identifier)",
          operation: "IssueByIdentifier",
          variablesDef: "($identifier: String!)",
        }),
        variables: {
          identifier: normalized,
        },
      });
      if (!result.ok) {
        return result;
      }
      const issue = parseIssue(result.data.issue);
      return {
        ok: true,
        data: issue,
      };
    },

    getIssueById: async ({ issueId }) => {
      const normalized = issueId.trim();
      if (!normalized) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear issue id.",
        };
      }
      const result = await request<{
        readonly issue?: unknown;
      }>({
        query: issueFieldsQuery({
          root: "issue(id: $issueId)",
          operation: "IssueById",
          variablesDef: "($issueId: String!)",
        }),
        variables: {
          issueId: normalized,
        },
      });
      if (!result.ok) {
        return result;
      }
      const issue = parseIssue(result.data.issue);
      return {
        ok: true,
        data: issue,
      };
    },

    createIssue: async (input) => {
      const teamId = input.teamId.trim();
      const title = input.title.trim();
      if (!(teamId && title)) {
        return {
          ok: false,
          status: 400,
          error: "Linear issue creation requires teamId and title.",
        };
      }
      const mutationInput: Record<string, unknown> = {
        teamId,
        title,
      };
      if (input.description !== undefined) {
        mutationInput.description = input.description;
      }
      if (input.projectId) {
        mutationInput.projectId = input.projectId;
      }
      if (input.stateId) {
        mutationInput.stateId = input.stateId;
      }
      if (input.assigneeId) {
        mutationInput.assigneeId = input.assigneeId;
      }
      if (input.labelIds && input.labelIds.length > 0) {
        mutationInput.labelIds = [...input.labelIds];
      }
      if (input.parentId) {
        mutationInput.parentId = input.parentId;
      }

      const result = await request<{
        readonly issueCreate?: unknown;
      }>({
        query: [
          "mutation LinearIssueCreate($input: IssueCreateInput!) {",
          "  issueCreate(input: $input) {",
          "    success",
          "    issue {",
          issueFieldsSelection(),
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          input: mutationInput,
        },
      });
      if (!result.ok) {
        return result;
      }
      const issue = parseIssueMutationIssue(result.data.issueCreate);
      if (!issue) {
        return {
          ok: false,
          status: 500,
          error: "Linear issueCreate payload missing issue data.",
        };
      }
      return {
        ok: true,
        data: issue,
      };
    },

    updateIssue: async (input) => {
      const issueId = input.issueId.trim();
      if (!issueId) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear issue id.",
        };
      }
      const mutationInput: Record<string, unknown> = {};
      if (input.title !== undefined) {
        mutationInput.title = input.title;
      }
      if (input.description !== undefined) {
        mutationInput.description = input.description;
      }
      if (input.projectId !== undefined) {
        mutationInput.projectId = input.projectId;
      }
      if (input.stateId !== undefined) {
        mutationInput.stateId = input.stateId;
      }
      if (input.assigneeId !== undefined) {
        mutationInput.assigneeId = input.assigneeId;
      }
      if (input.labelIds !== undefined) {
        mutationInput.labelIds = [...input.labelIds];
      }
      if (input.parentId !== undefined) {
        mutationInput.parentId = input.parentId;
      }

      const result = await request<{
        readonly issueUpdate?: unknown;
      }>({
        query: [
          "mutation LinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {",
          "  issueUpdate(id: $id, input: $input) {",
          "    success",
          "    issue {",
          issueFieldsSelection(),
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          id: issueId,
          input: mutationInput,
        },
      });
      if (!result.ok) {
        return result;
      }
      const issue = parseIssueMutationIssue(result.data.issueUpdate);
      if (!issue) {
        return {
          ok: false,
          status: 500,
          error: "Linear issueUpdate payload missing issue data.",
        };
      }
      return {
        ok: true,
        data: issue,
      };
    },

    listProjectIssuesPage: async (input) => {
      const projectId = input.projectId.trim();
      if (!projectId) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear project id.",
        };
      }
      const first = normalizePositiveInt({
        value: input.first,
        fallback: DEFAULT_PAGE_SIZE,
      });
      const result = await request<{
        readonly project?: unknown;
      }>({
        query: [
          "query LinearProjectIssues($projectId: String!, $first: Int!, $after: String) {",
          "  project(id: $projectId) {",
          "    id",
          "    name",
          "    team { id key name }",
          "    issues(first: $first, after: $after) {",
          "      pageInfo {",
          "        hasNextPage",
          "        endCursor",
          "      }",
          "      nodes {",
          issueFieldsSelection(),
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          projectId,
          first,
          after: input.after ?? null,
        },
      });
      if (!result.ok) {
        return result;
      }
      const page = parseProjectIssuePage(result.data.project);
      if (!page) {
        return {
          ok: false,
          status: 500,
          error: "Linear project issue page payload is invalid.",
        };
      }
      return {
        ok: true,
        data: page,
      };
    },

    listTeamStates: async ({ teamId }) => {
      const id = teamId.trim();
      if (!id) {
        return {
          ok: false,
          status: 400,
          error: "Missing team id.",
        };
      }
      const result = await request<{
        readonly team?: unknown;
      }>({
        query: [
          "query LinearTeamStates($teamId: String!) {",
          "  team(id: $teamId) {",
          "    states {",
          "      nodes {",
          "        id",
          "        name",
          "        type",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { teamId: id },
      });
      if (!result.ok) {
        return result;
      }
      const states = parseTeamStates(result.data.team);
      return {
        ok: true,
        data: states,
      };
    },

    listTeamLabels: async ({ teamId }) => {
      const id = teamId.trim();
      if (!id) {
        return {
          ok: false,
          status: 400,
          error: "Missing team id.",
        };
      }
      const result = await request<{
        readonly team?: unknown;
      }>({
        query: [
          "query LinearTeamLabels($teamId: String!) {",
          "  team(id: $teamId) {",
          "    labels {",
          "      nodes {",
          "        id",
          "        name",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { teamId: id },
      });
      if (!result.ok) {
        return result;
      }
      const labels = parseTeamLabels(result.data.team);
      return {
        ok: true,
        data: labels,
      };
    },

    listTeamUsers: async (input) => {
      const teamId = input.teamId.trim();
      if (!teamId) {
        return {
          ok: false,
          status: 400,
          error: "Missing team id.",
        };
      }
      const first = normalizePositiveInt({
        value: input.first,
        fallback: DEFAULT_PAGE_SIZE,
      });
      const result = await request<{
        readonly team?: unknown;
      }>({
        query: [
          "query LinearTeamUsers($teamId: String!, $first: Int!) {",
          "  team(id: $teamId) {",
          "    memberships(first: $first) {",
          "      nodes {",
          "        user {",
          userFieldsSelection({ indent: "          " }),
          "        }",
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { teamId, first },
      });
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        data: parseTeamUsers(result.data.team),
      };
    },

    listIssueComments: async (input) => {
      const issueId = input.issueId.trim();
      if (!issueId) {
        return {
          ok: false,
          status: 400,
          error: "Missing Linear issue id.",
        };
      }
      const first = normalizePositiveInt({
        value: input.first,
        fallback: DEFAULT_PAGE_SIZE,
      });
      const result = await request<{
        readonly issue?: unknown;
      }>({
        query: [
          "query LinearIssueComments($issueId: String!, $first: Int!) {",
          "  issue(id: $issueId) {",
          "    comments(first: $first) {",
          "      nodes {",
          commentFieldsSelection({ indent: "        " }),
          "      }",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: { issueId, first },
      });
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        data: parseIssueComments(result.data.issue),
      };
    },

    createComment: async (input) => {
      const issueId = input.issueId.trim();
      const body = input.body.trim();
      if (!(issueId && body)) {
        return {
          ok: false,
          status: 400,
          error: "Linear comment creation requires issueId and body.",
        };
      }
      const result = await request<{
        readonly commentCreate?: unknown;
      }>({
        query: [
          "mutation LinearCommentCreate($input: CommentCreateInput!) {",
          "  commentCreate(input: $input) {",
          "    success",
          "    comment {",
          commentFieldsSelection({ indent: "      " }),
          "    }",
          "  }",
          "}",
        ].join("\n"),
        variables: {
          input: {
            issueId,
            body,
          },
        },
      });
      if (!result.ok) {
        return result;
      }
      const comment = parseCommentMutationComment(result.data.commentCreate);
      if (!comment) {
        return {
          ok: false,
          status: 500,
          error: "Linear commentCreate payload missing comment data.",
        };
      }
      return {
        ok: true,
        data: comment,
      };
    },
  };
}

function issueFieldsQuery(input: {
  readonly operation: string;
  readonly variablesDef: string;
  readonly root: string;
}): string {
  return [
    `query ${input.operation}${input.variablesDef} {`,
    `  ${input.root} {`,
    issueFieldsSelection(),
    "  }",
    "}",
  ].join("\n");
}

function issueFieldsSelection(): string {
  return [
    "id",
    "identifier",
    "title",
    "description",
    "url",
    "state {",
    "  id",
    "  name",
    "  type",
    "}",
    "team {",
    "  id",
    "  key",
    "  name",
    "}",
    "project {",
    "  id",
    "  name",
    "}",
    "assignee {",
    userFieldsSelection({ indent: "  " }),
    "}",
    "labels {",
    "  nodes {",
    "    id",
    "    name",
    "  }",
    "}",
    "parent {",
    "  id",
    "  identifier",
    "}",
  ].join("\n");
}

function userFieldsSelection(input: { readonly indent: string }): string {
  return ["id", "name", "displayName", "email", "active"]
    .map((field) => `${input.indent}${field}`)
    .join("\n");
}

function commentFieldsSelection(input: { readonly indent: string }): string {
  return [
    `${input.indent}id`,
    `${input.indent}body`,
    `${input.indent}createdAt`,
    `${input.indent}updatedAt`,
    `${input.indent}user {`,
    userFieldsSelection({ indent: `${input.indent}  ` }),
    `${input.indent}}`,
  ].join("\n");
}

function parseGraphQlErrors(value: unknown): LinearGraphQlError[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const errors: LinearGraphQlError[] = [];
  for (const item of value) {
    if (!(isRecord(item) && typeof item.message === "string")) {
      continue;
    }
    errors.push({
      message: item.message,
    });
  }
  return errors;
}

function parseViewer(value: unknown): {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
  readonly displayName?: string;
} | null {
  if (!(isRecord(value) && typeof value.id === "string")) {
    return null;
  }
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
  };
}

function parseViewerProjects(value: unknown): LinearProject[] {
  if (!isRecord(value)) {
    return [];
  }
  const projects = isRecord(value.projects) ? value.projects : null;
  const nodes = Array.isArray(projects?.nodes) ? projects.nodes : [];
  const out: LinearProject[] = [];
  for (const node of nodes) {
    const parsed = parseProject(node);
    if (!parsed) {
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function parseUser(value: unknown): LinearUser | null {
  if (!(isRecord(value) && typeof value.id === "string")) {
    return null;
  }
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.active === "boolean" ? { active: value.active } : {}),
  };
}

function parseProject(value: unknown): LinearProject | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!(typeof value.id === "string" && typeof value.name === "string")) {
    return null;
  }
  const team = isRecord(value.team) ? value.team : null;
  if (!(team && typeof team.id === "string")) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    teamId: team.id,
    ...(typeof team.key === "string" ? { teamKey: team.key } : {}),
    ...(typeof team.name === "string" ? { teamName: team.name } : {}),
  };
}

function parseIssue(value: unknown): LinearIssue | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseIssue = parseIssueBase(value);
  if (!baseIssue) {
    return null;
  }

  const state = parseWorkflowState(value.state);
  const team = isRecord(value.team) ? value.team : null;
  if (!(state && team && typeof team.id === "string")) {
    return null;
  }
  const project = isRecord(value.project) ? value.project : null;
  const assignee = parseUser(value.assignee);
  const labels = parseLabels(value.labels);
  const parent = isRecord(value.parent) ? value.parent : null;

  return {
    ...baseIssue,
    state,
    teamId: team.id,
    ...(typeof team.key === "string" ? { teamKey: team.key } : {}),
    ...(typeof team.name === "string" ? { teamName: team.name } : {}),
    ...parseIssueProjectFields(project),
    ...parseIssueAssigneeFields(assignee),
    labels,
    ...parseIssueParentFields(parent),
  };
}

function parseIssueMutationIssue(value: unknown): LinearIssue | null {
  if (!isRecord(value)) {
    return null;
  }
  const success = value.success;
  if (typeof success === "boolean" && !success) {
    return null;
  }
  return parseIssue(value.issue);
}

function parseWorkflowState(value: unknown): LinearWorkflowState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      isLinearWorkflowStateType(value.type)
    )
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
  };
}

function parseLabels(value: unknown): LinearLabel[] {
  if (!isRecord(value)) {
    return [];
  }
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const labels: LinearLabel[] = [];
  for (const node of nodes) {
    if (!(isRecord(node) && typeof node.id === "string")) {
      continue;
    }
    const name = typeof node.name === "string" ? node.name : "";
    labels.push({
      id: node.id,
      name,
    });
  }
  return labels;
}

function parseProjectIssuePage(value: unknown): LinearProjectIssuePage | null {
  if (!isRecord(value)) {
    return null;
  }
  const project = parseProject(value);
  if (!project) {
    return null;
  }
  const issuesConnection = isRecord(value.issues) ? value.issues : null;
  const nodes = Array.isArray(issuesConnection?.nodes)
    ? issuesConnection.nodes
    : [];
  const pageInfo = isRecord(issuesConnection?.pageInfo)
    ? issuesConnection.pageInfo
    : null;
  if (!(pageInfo && typeof pageInfo.hasNextPage === "boolean")) {
    return null;
  }
  const issues: LinearIssue[] = [];
  for (const node of nodes) {
    const issue = parseIssue(node);
    if (!issue) {
      continue;
    }
    issues.push(issue);
  }
  return {
    project,
    issues,
    hasNextPage: pageInfo.hasNextPage,
    ...(typeof pageInfo.endCursor === "string"
      ? { endCursor: pageInfo.endCursor }
      : {}),
  };
}

function parseTeamStates(value: unknown): LinearWorkflowState[] {
  if (!isRecord(value)) {
    return [];
  }
  const states = isRecord(value.states) ? value.states : null;
  const nodes = Array.isArray(states?.nodes) ? states.nodes : [];
  const out: LinearWorkflowState[] = [];
  for (const node of nodes) {
    const parsed = parseWorkflowState(node);
    if (!parsed) {
      continue;
    }
    out.push(parsed);
  }
  return out;
}

function parseTeamLabels(value: unknown): LinearLabel[] {
  if (!isRecord(value)) {
    return [];
  }
  const labels = isRecord(value.labels) ? value.labels : null;
  const nodes = Array.isArray(labels?.nodes) ? labels.nodes : [];
  const out: LinearLabel[] = [];
  for (const node of nodes) {
    if (!(isRecord(node) && typeof node.id === "string")) {
      continue;
    }
    const name = typeof node.name === "string" ? node.name : "";
    out.push({
      id: node.id,
      name,
    });
  }
  return out;
}

function parseTeamUsers(value: unknown): LinearUser[] {
  if (!isRecord(value)) {
    return [];
  }
  const memberships = isRecord(value.memberships) ? value.memberships : null;
  const nodes = Array.isArray(memberships?.nodes) ? memberships.nodes : [];
  const out: LinearUser[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const user = parseUser(node.user);
    if (!user) {
      continue;
    }
    out.push(user);
  }
  return out;
}

function parseIssueComments(value: unknown): LinearComment[] {
  if (!isRecord(value)) {
    return [];
  }
  const comments = isRecord(value.comments) ? value.comments : null;
  const nodes = Array.isArray(comments?.nodes) ? comments.nodes : [];
  const out: LinearComment[] = [];
  for (const node of nodes) {
    const comment = parseComment(node);
    if (!comment) {
      continue;
    }
    out.push(comment);
  }
  return out;
}

function parseComment(value: unknown): LinearComment | null {
  if (!(isRecord(value) && typeof value.id === "string")) {
    return null;
  }
  if (
    !(typeof value.body === "string" && typeof value.createdAt === "string")
  ) {
    return null;
  }
  const user = parseUser(value.user);
  return {
    id: value.id,
    body: value.body,
    createdAt: value.createdAt,
    ...(typeof value.updatedAt === "string"
      ? { updatedAt: value.updatedAt }
      : {}),
    ...(user
      ? {
          userId: user.id,
          ...(typeof user.name === "string" ? { userName: user.name } : {}),
          ...(typeof user.displayName === "string"
            ? { userDisplayName: user.displayName }
            : {}),
          ...(typeof user.email === "string" ? { userEmail: user.email } : {}),
        }
      : {}),
  };
}

function parseCommentMutationComment(value: unknown): LinearComment | null {
  if (!isRecord(value)) {
    return null;
  }
  const success = value.success;
  if (typeof success === "boolean" && !success) {
    return null;
  }
  return parseComment(value.comment);
}

function parseIssueBase(value: Record<string, unknown>): {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
} | null {
  if (
    !(
      typeof value.id === "string" &&
      typeof value.identifier === "string" &&
      typeof value.title === "string"
    )
  ) {
    return null;
  }
  return {
    id: value.id,
    identifier: value.identifier,
    title: value.title,
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

function parseIssueProjectFields(
  value: Record<string, unknown> | null
): Pick<LinearIssue, "projectId" | "projectName"> {
  if (!(value && typeof value.id === "string")) {
    return {};
  }
  return {
    projectId: value.id,
    ...(typeof value.name === "string" ? { projectName: value.name } : {}),
  };
}

function parseIssueAssigneeFields(
  value: LinearUser | null
): Pick<
  LinearIssue,
  | "assigneeId"
  | "assigneeName"
  | "assigneeDisplayName"
  | "assigneeEmail"
  | "assigneeActive"
> {
  if (!value) {
    return {};
  }
  return {
    assigneeId: value.id,
    ...(typeof value.name === "string" ? { assigneeName: value.name } : {}),
    ...(typeof value.displayName === "string"
      ? { assigneeDisplayName: value.displayName }
      : {}),
    ...(typeof value.email === "string" ? { assigneeEmail: value.email } : {}),
    ...(typeof value.active === "boolean"
      ? { assigneeActive: value.active }
      : {}),
  };
}

function parseIssueParentFields(
  value: Record<string, unknown> | null
): Pick<LinearIssue, "parentId" | "parentIdentifier"> {
  if (!value) {
    return {};
  }
  return {
    ...(typeof value.id === "string" ? { parentId: value.id } : {}),
    ...(typeof value.identifier === "string"
      ? { parentIdentifier: value.identifier }
      : {}),
  };
}

function isLinearWorkflowStateType(
  value: unknown
): value is LinearWorkflowStateType {
  return (
    value === "triage" ||
    value === "backlog" ||
    value === "unstarted" ||
    value === "started" ||
    value === "completed" ||
    value === "canceled"
  );
}

function normalizePositiveInt(input: {
  readonly value: number | undefined;
  readonly fallback: number;
}): number {
  if (
    typeof input.value === "number" &&
    Number.isFinite(input.value) &&
    input.value > 0
  ) {
    return Math.floor(input.value);
  }
  return input.fallback;
}

function normalizeApiUrl(input: { readonly value: string }): string {
  const trimmed = input.value.trim();
  if (!trimmed) {
    return DEFAULT_LINEAR_API_URL;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
