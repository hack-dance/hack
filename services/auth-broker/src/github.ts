import type { GitHubFlowAccount } from "./types.ts";

const USER_AGENT = "hack-auth-broker";
const GITHUB_API_VERSION = "2022-11-28";
const TRAILING_SLASHES_PATTERN = /\/+$/;

type GitHubTokenExchangeResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly tokenExpiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly statusCode: number;
    };

type GitHubIdentityResult =
  | {
      readonly ok: true;
      readonly account: GitHubFlowAccount;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly statusCode: number;
    };

/**
 * Build the GitHub authorize URL for OAuth App login.
 */
export function buildAuthorizeUrl(opts: {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly state: string;
}): string {
  const url = new URL(opts.authorizeUrl);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

/**
 * Exchange authorization code for access token.
 */
export async function exchangeCodeForToken(opts: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly state: string;
}): Promise<GitHubTokenExchangeResult> {
  const body = new URLSearchParams();
  body.set("client_id", opts.clientId);
  body.set("client_secret", opts.clientSecret);
  body.set("code", opts.code);
  body.set("state", opts.state);
  body.set("redirect_uri", opts.redirectUri);

  const response = await fetch(opts.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
  });
  const payload = await decodeJson(response);
  if (!response.ok) {
    const message =
      pickString(payload, "error_description") ??
      pickString(payload, "error") ??
      response.statusText;
    return {
      ok: false,
      statusCode: response.status,
      error: `token_exchange_failed: ${message}`,
    };
  }

  const token = pickString(payload, "access_token");
  if (!token) {
    const message =
      pickString(payload, "error_description") ??
      pickString(payload, "error") ??
      "missing access_token";
    return {
      ok: false,
      statusCode: 502,
      error: `token_exchange_failed: ${message}`,
    };
  }

  const expiresIn = pickNumber(payload, "expires_in");
  const tokenExpiresAt =
    typeof expiresIn === "number"
      ? new Date(
          Date.now() + Math.max(0, Math.floor(expiresIn)) * 1000
        ).toISOString()
      : undefined;

  return {
    ok: true,
    token,
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
  };
}

/**
 * Resolve GitHub user identity + installation ids for the token.
 */
export async function fetchIdentity(opts: {
  readonly apiBaseUrl: string;
  readonly token: string;
}): Promise<GitHubIdentityResult> {
  const baseUrl = opts.apiBaseUrl.replace(TRAILING_SLASHES_PATTERN, "");
  const headers = buildApiHeaders({ token: opts.token });
  const userResponse = await fetch(`${baseUrl}/user`, {
    method: "GET",
    headers,
  });
  const userPayload = await decodeJson(userResponse);
  if (!userResponse.ok) {
    const message =
      pickString(userPayload, "message") ?? userResponse.statusText;
    return {
      ok: false,
      error: `identity_lookup_failed: ${message}`,
      statusCode: userResponse.status,
    };
  }

  const login = pickString(userPayload, "login");
  if (!login) {
    return {
      ok: false,
      error: "identity_lookup_failed: missing login",
      statusCode: 502,
    };
  }

  const accountName = pickString(userPayload, "name") ?? undefined;
  const accountId = pickString(userPayload, "id") ?? undefined;
  const installationIds = await fetchInstallationIds({ baseUrl, headers });
  return {
    ok: true,
    account: {
      login,
      ...(accountName ? { accountName } : {}),
      ...(accountId ? { accountId } : {}),
      installationIds,
    },
  };
}

function buildApiHeaders(opts: {
  readonly token: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

async function fetchInstallationIds(opts: {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
}): Promise<readonly string[]> {
  const response = await fetch(
    `${opts.baseUrl}/user/installations?per_page=100`,
    {
      method: "GET",
      headers: opts.headers,
    }
  );
  const payload = await decodeJson(response);
  if (!response.ok) {
    return [];
  }
  const entries = pickArray(payload, "installations");
  const installationIds: string[] = [];
  for (const entry of entries) {
    const id = pickString(entry, "id");
    if (!id) {
      continue;
    }
    installationIds.push(id);
  }
  return installationIds;
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pickArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate;
}

function pickNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return null;
  }
  return candidate;
}

function pickString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const candidate = value[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(candidate);
  }
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
