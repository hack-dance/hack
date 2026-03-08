import type { OAuthFlowAccount } from "./types.ts";

const USER_AGENT = "hack-auth-broker";
const TRAILING_PATH_SLASHES_PATTERN = /\/+$/;
const LINEAR_VIEWER_QUERY = [
  "query LinearViewer {",
  "  viewer {",
  "    id",
  "    name",
  "    email",
  "    displayName",
  "    organization {",
  "      id",
  "      name",
  "    }",
  "    teams(first: 50) {",
  "      nodes {",
  "        id",
  "        name",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

type LinearTokenExchangeResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly tokenExpiresAt?: string;
      readonly refreshToken?: string;
      readonly refreshTokenExpiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly statusCode: number;
    };

type LinearIdentityResult =
  | {
      readonly ok: true;
      readonly account: OAuthFlowAccount;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly statusCode: number;
    };

export function buildAuthorizeUrl(input: {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly actor?: "user" | "app";
  readonly scopes: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.actor) {
    url.searchParams.set("actor", input.actor);
  }
  url.searchParams.set("scope", input.scopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCodeForToken(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}): Promise<LinearTokenExchangeResult> {
  return await exchangeLinearToken({
    tokenUrl: input.tokenUrl,
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    body: {
      grant_type: "authorization_code",
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
  });
}

export async function refreshAccessToken(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
}): Promise<LinearTokenExchangeResult> {
  return await exchangeLinearToken({
    tokenUrl: input.tokenUrl,
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    body: {
      grant_type: "refresh_token",
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      refresh_token: input.refreshToken,
    },
  });
}

async function exchangeLinearToken(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly body: Record<string, string>;
}): Promise<LinearTokenExchangeResult> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(input.body)) {
    form.set(key, value);
  }
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: form.toString(),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      statusCode: response.status,
      error: `token_exchange_failed: invalid payload (${response.status})`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error:
        readOptionalString(payload.error_description) ??
        readOptionalString(payload.error) ??
        response.statusText,
    };
  }
  const token = readOptionalString(payload.access_token);
  if (!token) {
    return {
      ok: false,
      statusCode: 502,
      error: "token_exchange_failed: missing access_token",
    };
  }
  const expiresIn = readOptionalPositiveInt(payload.expires_in);
  const refreshToken = readOptionalString(payload.refresh_token);
  const refreshTokenExpiresIn = readOptionalPositiveInt(
    payload.refresh_token_expires_in
  );
  return {
    ok: true,
    token,
    ...(expiresIn !== null
      ? {
          tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        }
      : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshTokenExpiresIn !== null
      ? {
          refreshTokenExpiresAt: new Date(
            Date.now() + refreshTokenExpiresIn * 1000
          ).toISOString(),
        }
      : {}),
  };
}

export async function fetchIdentity(input: {
  readonly apiBaseUrl: string;
  readonly token: string;
}): Promise<LinearIdentityResult> {
  const response = await fetch(normalizeGraphqlUrl(input.apiBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      query: LINEAR_VIEWER_QUERY,
    }),
  });
  const payload = await readJsonRecord({
    response,
    errorPrefix: "identity_lookup_failed",
  });
  if (!payload.ok) {
    return payload;
  }
  const responseError = readGraphqlResponseError({
    payload: payload.value,
    response,
  });
  if (responseError) {
    return responseError;
  }
  const account = buildIdentityAccount({ payload: payload.value });
  if (!account) {
    return {
      ok: false,
      statusCode: 502,
      error: "identity_lookup_failed: missing viewer.id",
    };
  }
  return { ok: true, account };
}

function normalizeGraphqlUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "https://api.linear.app/graphql";
  }
  const url = new URL(trimmed);
  const pathname = url.pathname.replace(TRAILING_PATH_SLASHES_PATTERN, "");
  url.pathname = pathname.length === 0 ? "/graphql" : pathname;
  return url.toString();
}

function buildIdentityAccount(input: {
  readonly payload: Record<string, unknown>;
}): OAuthFlowAccount | null {
  const viewer = readViewerRecord({ payload: input.payload });
  const accountId = readOptionalString(viewer?.id);
  if (!accountId) {
    return null;
  }
  const accountName =
    readOptionalString(viewer?.displayName) ??
    readOptionalString(viewer?.name) ??
    undefined;
  const accountEmail = readOptionalString(viewer?.email) ?? undefined;
  const organization = readRecord(viewer?.organization);
  const organizationId = readOptionalString(organization?.id) ?? undefined;
  const organizationName = readOptionalString(organization?.name) ?? undefined;
  const teamIds = readTeamIds({ viewer });
  return {
    accountId,
    ...(accountName ? { accountName, accountHandle: accountName } : {}),
    ...(accountEmail ? { accountEmail } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(organizationName ? { organizationName } : {}),
    ...(teamIds.length > 0 ? { teamIds } : {}),
  };
}

async function readJsonRecord(input: {
  readonly response: Response;
  readonly errorPrefix: string;
}): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string; readonly statusCode: number }
> {
  const payload = (await input.response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      statusCode: input.response.status,
      error: `${input.errorPrefix}: invalid payload (${input.response.status})`,
    };
  }
  return {
    ok: true,
    value: payload,
  };
}

function readGraphqlResponseError(input: {
  readonly payload: Record<string, unknown>;
  readonly response: Response;
}): {
  readonly ok: false;
  readonly error: string;
  readonly statusCode: number;
} | null {
  const errors = Array.isArray(input.payload.errors)
    ? input.payload.errors
        .map((entry) => readOptionalString(readRecord(entry)?.message))
        .filter((entry): entry is string => Boolean(entry))
    : [];
  if (input.response.ok && errors.length === 0) {
    return null;
  }
  return {
    ok: false,
    statusCode: input.response.status,
    error: errors[0] ?? input.response.statusText,
  };
}

function readViewerRecord(input: {
  readonly payload: Record<string, unknown>;
}): Record<string, unknown> | null {
  const data = readRecord(input.payload.data);
  return readRecord(data?.viewer);
}

function readTeamIds(input: {
  readonly viewer: Record<string, unknown> | null;
}): string[] {
  const teams = readRecord(input.viewer?.teams);
  const nodes = Array.isArray(teams?.nodes) ? teams.nodes : [];
  return nodes
    .map((entry) => readOptionalString(readRecord(entry)?.id))
    .filter((entry): entry is string => Boolean(entry));
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
