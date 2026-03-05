import type { OAuthFlowAccount } from "./types.ts";

const USER_AGENT = "hack-auth-broker";

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
  const response = await fetch(input.apiBaseUrl, {
    method: "POST",
    headers: {
      Authorization: input.token,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
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
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      statusCode: response.status,
      error: `identity_lookup_failed: invalid payload (${response.status})`,
    };
  }
  const errors = Array.isArray(payload.errors)
    ? payload.errors
        .map((entry) =>
          isRecord(entry) ? readOptionalString(entry.message) : null
        )
        .filter((entry): entry is string => Boolean(entry))
    : [];
  if (!response.ok || errors.length > 0) {
    return {
      ok: false,
      statusCode: response.status,
      error: errors[0] ?? response.statusText,
    };
  }

  const viewer =
    isRecord(payload.data) && isRecord(payload.data.viewer)
      ? payload.data.viewer
      : null;
  const accountId = viewer ? readOptionalString(viewer.id) : null;
  if (!accountId) {
    return {
      ok: false,
      statusCode: 502,
      error: "identity_lookup_failed: missing viewer.id",
    };
  }
  const accountName =
    (viewer && readOptionalString(viewer.displayName)) ??
    (viewer && readOptionalString(viewer.name)) ??
    undefined;
  const accountEmail =
    (viewer && readOptionalString(viewer.email)) ?? undefined;
  return {
    ok: true,
    account: {
      accountId,
      ...(accountName ? { accountName } : {}),
      ...(accountEmail ? { accountEmail } : {}),
      ...(accountName ? { accountHandle: accountName } : {}),
    },
  };
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
