import { randomBytes, randomUUID } from "node:crypto";

import type { BrokerConfig } from "../../config.ts";
import { type FlowStore, hashDeviceCode } from "../../flow-store.ts";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchIdentity,
} from "../../github.ts";
import type { GitHubOAuthModel } from "./model.ts";

export type StartFlowPayload = {
  readonly flowId: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly authorizeUrl: string;
  readonly deviceCode: string;
  readonly pollUrl: string;
  readonly expiresAt: string;
};

/**
 * Build and persist a new GitHub OAuth flow state.
 */
export function createFlow(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly query: Pick<
    GitHubOAuthModel["startQuery"],
    "profile" | "setDefault"
  >;
}): StartFlowPayload {
  const nowMs = Date.now();
  const flowId = randomUUID();
  const state = makeToken();
  const deviceCode = makeToken();
  const profileId = normalizeText(input.query.profile) ?? "default";
  const setDefault = isTruthy(input.query.setDefault);
  const expiresAtMs = nowMs + input.config.flowTtlMs;
  const authorizeUrl = buildAuthorizeUrl({
    authorizeUrl: input.config.githubAuthorizeUrl,
    clientId: input.config.githubClientId,
    redirectUri: input.config.githubRedirectUri,
    scopes: input.config.githubScopes,
    state,
  });

  input.flowStore.createFlow({
    id: flowId,
    state,
    profileId,
    setDefault,
    deviceCodeHash: hashDeviceCode(deviceCode),
    authorizeUrl,
    createdAtMs: nowMs,
    expiresAtMs,
    redirectUri: input.config.githubRedirectUri,
    status: "pending",
  });

  return {
    flowId,
    profileId,
    setDefault,
    authorizeUrl,
    deviceCode,
    pollUrl: `${input.config.publicBaseUrl}/v1/auth/github/flows/${flowId}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Complete OAuth callback flow and return browser-facing HTML response.
 */
export async function handleGitHubCallback(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly query: GitHubOAuthModel["callbackQuery"];
}): Promise<Response> {
  const state = normalizeText(input.query.state);
  if (!state) {
    return renderCallbackPage({
      title: "Missing state",
      body: "This sign-in session is missing a state token.",
      statusCode: 400,
    });
  }

  const flow = input.flowStore.getByState(state);
  if (!flow) {
    return renderCallbackPage({
      title: "Session not found",
      body: "This sign-in session was not found or already expired.",
      statusCode: 404,
    });
  }

  const nowMs = Date.now();
  if (nowMs > flow.expiresAtMs) {
    input.flowStore.markError({
      flowId: flow.id,
      error: "oauth_flow_expired",
      status: "expired",
    });
    return renderCallbackPage({
      title: "Session expired",
      body: "This sign-in session expired. Start a new sign-in flow from Hack.",
      statusCode: 410,
    });
  }

  const oauthError = normalizeText(input.query.error);
  if (oauthError) {
    const oauthDescription = normalizeText(input.query.error_description);
    input.flowStore.markError({
      flowId: flow.id,
      error: oauthDescription
        ? `${oauthError}: ${oauthDescription}`
        : oauthError,
      status: "error",
    });
    return renderCallbackPage({
      title: "GitHub authorization failed",
      body:
        oauthDescription ??
        "GitHub denied access. Return to Hack and try again.",
      statusCode: 400,
    });
  }

  const code = normalizeText(input.query.code);
  if (!code) {
    input.flowStore.markError({
      flowId: flow.id,
      error: "missing_authorization_code",
      status: "error",
    });
    return renderCallbackPage({
      title: "Missing authorization code",
      body: "GitHub did not return a code for this sign-in request.",
      statusCode: 400,
    });
  }

  const exchange = await exchangeCodeForToken({
    tokenUrl: input.config.githubTokenUrl,
    clientId: input.config.githubClientId,
    clientSecret: input.config.githubClientSecret,
    code,
    redirectUri: flow.redirectUri,
    state,
  });
  if (!exchange.ok) {
    input.flowStore.markError({
      flowId: flow.id,
      error: exchange.error,
      status: "error",
    });
    return renderCallbackPage({
      title: "Token exchange failed",
      body: exchange.error,
      statusCode: 502,
    });
  }

  const identity = await fetchIdentity({
    apiBaseUrl: input.config.githubApiBaseUrl,
    token: exchange.token,
  });
  if (!identity.ok) {
    input.flowStore.markError({
      flowId: flow.id,
      error: identity.error,
      status: "error",
    });
    return renderCallbackPage({
      title: "GitHub account lookup failed",
      body: identity.error,
      statusCode: 502,
    });
  }

  input.flowStore.markComplete({
    flowId: flow.id,
    account: identity.account,
    token: exchange.token,
    tokenExpiresAt: exchange.tokenExpiresAt,
  });
  return renderCallbackPage({
    title: "GitHub connected",
    body: "Authorization is complete. Return to Hack to finish account setup.",
    success: true,
    statusCode: 200,
  });
}

export function normalizeText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isTruthy(value: string | undefined): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

function renderCallbackPage(input: {
  readonly title: string;
  readonly body: string;
  readonly success?: boolean;
  readonly statusCode: number;
}): Response {
  const statusColor = input.success ? "#16a34a" : "#ef4444";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0b1020;
      color: #d1d5db;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    main {
      width: min(92vw, 640px);
      border: 1px solid #1f2937;
      border-radius: 16px;
      padding: 28px;
      background: #0f172a;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    }
    h1 {
      margin: 0 0 12px;
      color: ${statusColor};
      font-size: 1.4rem;
      line-height: 1.2;
    }
    p {
      margin: 0;
      color: #9ca3af;
      line-height: 1.55;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.body)}</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: input.statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
