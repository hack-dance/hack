import { isRecord } from "../../../lib/guards.ts";

export type GitHubRepoRef = {
  readonly owner: string;
  readonly repo: string;
};

export type GitHubPullRequest = {
  readonly number: number;
  readonly url: string;
  readonly htmlUrl: string;
  readonly title: string;
  readonly state: string;
  readonly headRef: string;
  readonly baseRef: string;
};

type GitHubRequestResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_SSH_REMOTE_PATTERN =
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;
const LEADING_SLASH_PATTERN = /^\/+/;
const TRAILING_DOT_GIT_PATTERN = /\.git$/i;

export type GitHubAppClient = {
  readonly findOpenPullRequest: (input: {
    readonly repo: GitHubRepoRef;
    readonly headRef: string;
  }) => Promise<GitHubRequestResult<GitHubPullRequest | null>>;
  readonly createPullRequest: (input: {
    readonly repo: GitHubRepoRef;
    readonly title: string;
    readonly body: string;
    readonly headRef: string;
    readonly baseRef: string;
  }) => Promise<GitHubRequestResult<GitHubPullRequest>>;
  readonly updatePullRequest: (input: {
    readonly repo: GitHubRepoRef;
    readonly number: number;
    readonly title?: string;
    readonly body?: string;
    readonly state?: "open" | "closed";
  }) => Promise<GitHubRequestResult<GitHubPullRequest>>;
  readonly createIssueComment: (input: {
    readonly repo: GitHubRepoRef;
    readonly issueNumber: number;
    readonly body: string;
  }) => Promise<
    GitHubRequestResult<{ readonly id: number; readonly url: string }>
  >;
};

/**
 * Build a GitHub API client using an App installation token.
 */
export function createGitHubAppClient(input: {
  readonly token: string;
  readonly userAgent?: string;
}): GitHubAppClient {
  const token = input.token.trim();
  const userAgent = input.userAgent?.trim() || "hack-cli";

  const request = async <T>(req: {
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly body?: Record<string, unknown>;
  }): Promise<GitHubRequestResult<T>> => {
    const url = `${GITHUB_API_BASE}${req.path}`;
    const res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const message =
        getGitHubErrorMessage(json) ?? `${res.status} ${res.statusText}`;
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, data: json as T };
  };

  return {
    findOpenPullRequest: async (input) => {
      const head = encodeURIComponent(`${input.repo.owner}:${input.headRef}`);
      const found = await request<unknown[]>({
        method: "GET",
        path: `/repos/${input.repo.owner}/${input.repo.repo}/pulls?head=${head}&state=open&per_page=1`,
      });
      if (!found.ok) {
        return found;
      }
      const first = Array.isArray(found.data) ? found.data[0] : null;
      if (!first) {
        return { ok: true, data: null };
      }
      const parsed = parsePullRequest(first);
      return parsed
        ? { ok: true, data: parsed }
        : {
            ok: false,
            status: 500,
            error: "Invalid GitHub pull request payload.",
          };
    },
    createPullRequest: async (input) => {
      const created = await request<unknown>({
        method: "POST",
        path: `/repos/${input.repo.owner}/${input.repo.repo}/pulls`,
        body: {
          title: input.title,
          body: input.body,
          head: input.headRef,
          base: input.baseRef,
        },
      });
      if (!created.ok) {
        return created;
      }
      const parsed = parsePullRequest(created.data);
      return parsed
        ? { ok: true, data: parsed }
        : {
            ok: false,
            status: 500,
            error: "Invalid GitHub pull request payload.",
          };
    },
    updatePullRequest: async (input) => {
      const updated = await request<unknown>({
        method: "PATCH",
        path: `/repos/${input.repo.owner}/${input.repo.repo}/pulls/${input.number}`,
        body: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
          ...(input.state ? { state: input.state } : {}),
        },
      });
      if (!updated.ok) {
        return updated;
      }
      const parsed = parsePullRequest(updated.data);
      return parsed
        ? { ok: true, data: parsed }
        : {
            ok: false,
            status: 500,
            error: "Invalid GitHub pull request payload.",
          };
    },
    createIssueComment: async (input) => {
      const comment = await request<unknown>({
        method: "POST",
        path: `/repos/${input.repo.owner}/${input.repo.repo}/issues/${input.issueNumber}/comments`,
        body: { body: input.body },
      });
      if (!comment.ok) {
        return comment;
      }
      if (
        !(
          isRecord(comment.data) &&
          typeof comment.data.id === "number" &&
          typeof comment.data.url === "string"
        )
      ) {
        return {
          ok: false,
          status: 500,
          error: "Invalid GitHub comment payload.",
        };
      }
      return {
        ok: true,
        data: {
          id: comment.data.id,
          url: comment.data.url,
        },
      };
    },
  };
}

/**
 * Parse a GitHub repository reference from SSH or HTTPS remote URL.
 */
export function parseGitHubRepoRef(input: {
  readonly remoteUrl: string;
}): GitHubRepoRef | null {
  const raw = input.remoteUrl.trim();
  if (!raw) {
    return null;
  }

  const sshMatch = raw.match(GITHUB_SSH_REMOTE_PATTERN);
  if (sshMatch?.[1] && sshMatch[2]) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    const path = url.pathname
      .replace(LEADING_SLASH_PATTERN, "")
      .replace(TRAILING_DOT_GIT_PATTERN, "");
    const [owner, repo] = path.split("/");
    if (!(owner && repo)) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

function parsePullRequest(value: unknown): GitHubPullRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(
      typeof value.number === "number" &&
      typeof value.url === "string" &&
      typeof value.html_url === "string" &&
      typeof value.title === "string" &&
      typeof value.state === "string" &&
      isRecord(value.head) &&
      typeof value.head.ref === "string" &&
      isRecord(value.base) &&
      typeof value.base.ref === "string"
    )
  ) {
    return null;
  }
  return {
    number: value.number,
    url: value.url,
    htmlUrl: value.html_url,
    title: value.title,
    state: value.state,
    headRef: value.head.ref,
    baseRef: value.base.ref,
  };
}

function getGitHubErrorMessage(value: unknown): string | null {
  if (!(isRecord(value) && typeof value.message === "string")) {
    return null;
  }
  return value.message;
}
