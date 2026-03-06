import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import { resolveBetterAuthUserFromLinearAccount } from "../../better-auth-link.ts";
import type { BrokerConfig } from "../../config.ts";
import { type FlowStore, hashDeviceCode } from "../../flow-store.ts";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchIdentity,
  refreshAccessToken,
} from "../../linear.ts";
import type { OAuthFlow } from "../../types.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import type { LinearConnectionStore } from "../linear-connections/service.ts";
import type { LinearOAuthModel } from "./model.ts";

export type StartFlowPayload = {
  readonly flowId: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly authorizeUrl: string;
  readonly requestedScopes: string;
  readonly deviceCode: string;
  readonly pollUrl: string;
  readonly expiresAt: string;
};

export function createFlow(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly query: Pick<
    LinearOAuthModel["startQuery"],
    "profile" | "setDefault"
  >;
}): StartFlowPayload {
  if (!(input.config.linearClientId && input.config.linearRedirectUri)) {
    throw new Error("linear_oauth_not_configured");
  }
  const nowMs = Date.now();
  const flowId = randomUUID();
  const state = makeToken();
  const deviceCode = makeToken();
  const profileId = normalizeText(input.query.profile) ?? "default";
  const setDefault = isTruthy(input.query.setDefault);
  const expiresAtMs = nowMs + input.config.flowTtlMs;
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const authorizeUrl = buildAuthorizeUrl({
    authorizeUrl: input.config.linearAuthorizeUrl,
    clientId: input.config.linearClientId,
    redirectUri: input.config.linearRedirectUri,
    actor: input.config.linearActor,
    scopes: input.config.linearScopes,
    state,
    codeChallenge,
  });

  input.flowStore.createFlow({
    id: flowId,
    provider: "linear",
    state,
    profileId,
    setDefault,
    deviceCodeHash: hashDeviceCode(deviceCode),
    authorizeUrl,
    codeVerifier,
    createdAtMs: nowMs,
    expiresAtMs,
    redirectUri: input.config.linearRedirectUri,
    status: "pending",
  });

  return {
    flowId,
    profileId,
    setDefault,
    authorizeUrl,
    requestedScopes: input.config.linearScopes,
    deviceCode,
    pollUrl: `${input.config.publicBaseUrl}/v1/auth/linear/flows/${flowId}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function handleLinearCallback(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly connectionStore: LinearConnectionStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
  readonly request: Request;
  readonly query: LinearOAuthModel["callbackQuery"];
}): Promise<Response> {
  const flowResult = resolveLinearCallbackFlow({
    flowStore: input.flowStore,
    query: input.query,
  });
  if (!flowResult.ok) {
    return flowResult.response;
  }
  const flow = flowResult.flow;

  const oauthError = normalizeText(input.query.error);
  if (oauthError) {
    const oauthDescription = normalizeText(input.query.error_description);
    return markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: oauthDescription
        ? `${oauthError}: ${oauthDescription}`
        : oauthError,
      status: "error",
      title: "Linear authorization failed",
      body:
        oauthDescription ??
        "Linear denied access. Return to Hack and try again.",
      statusCode: 400,
    });
  }

  const code = normalizeText(input.query.code);
  if (!code) {
    return markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: "missing_authorization_code",
      status: "error",
      title: "Missing authorization code",
      body: "Linear did not return a code for this sign-in request.",
      statusCode: 400,
    });
  }

  const clientId = input.config.linearClientId;
  if (!(clientId && flow.codeVerifier)) {
    return markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: "linear_oauth_not_configured",
      status: "error",
      title: "Linear OAuth not configured",
      body: "The auth broker is missing Linear OAuth configuration.",
      statusCode: 412,
    });
  }

  const exchange = await exchangeCodeForToken({
    tokenUrl: input.config.linearTokenUrl,
    clientId,
    ...(input.config.linearClientSecret
      ? { clientSecret: input.config.linearClientSecret }
      : {}),
    code,
    redirectUri: flow.redirectUri,
    codeVerifier: flow.codeVerifier,
  });
  if (!exchange.ok) {
    return markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: exchange.error,
      status: "error",
      title: "Token exchange failed",
      body: exchange.error,
      statusCode: 502,
    });
  }

  const identity = await fetchIdentity({
    apiBaseUrl: input.config.linearApiBaseUrl,
    token: exchange.token,
  });
  if (!identity.ok) {
    return markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: identity.error,
      status: "error",
      title: "Linear account lookup failed",
      body: identity.error,
      statusCode: 502,
    });
  }

  const betterAuthLink = await resolveBetterAuthUserFromLinearAccount({
    runtime: input.betterAuthRuntime,
    account: identity.account,
    autoProvision: input.config.betterAuthLinearAutoProvisionUsers,
  });
  const betterAuthSession = await resolveBetterAuthSession({
    runtime: input.betterAuthRuntime,
    request: input.request,
  });
  const linkedAccount = {
    ...identity.account,
    ...(betterAuthLink.userId
      ? { betterAuthUserId: betterAuthLink.userId }
      : {}),
    ...(betterAuthLink.state
      ? { betterAuthLinkState: betterAuthLink.state }
      : {}),
  } as const;

  input.flowStore.markComplete({
    flowId: flow.id,
    account: linkedAccount,
    token: exchange.token,
    tokenExpiresAt: exchange.tokenExpiresAt,
    refreshToken: exchange.refreshToken,
    refreshTokenExpiresAt: exchange.refreshTokenExpiresAt,
  });
  try {
    await input.connectionStore.upsertConnection({
      profileId: flow.profileId,
      accountId: identity.account.accountId,
      accountName: identity.account.accountName,
      accountEmail: identity.account.accountEmail,
      betterAuthUserId: betterAuthLink.userId ?? null,
      betterAuthOrganizationId:
        betterAuthSession.session?.organizationId ?? null,
      organizationId: identity.account.organizationId,
      teamId: identity.account.teamIds?.[0] ?? null,
      metadata: {
        ...(betterAuthLink.state
          ? { betterAuthLinkState: betterAuthLink.state }
          : {}),
        ...(identity.account.organizationName
          ? { organizationName: identity.account.organizationName }
          : {}),
        ...(identity.account.teamIds
          ? { teamIds: identity.account.teamIds }
          : {}),
      },
    });
  } catch {
    // Connection persistence is diagnostic state and must not fail OAuth completion.
  }

  return renderCallbackPage({
    title: "Linear connected",
    body: "Authorization is complete. Return to Hack to finish account setup.",
    statusCode: 200,
    success: true,
  });
}

function resolveLinearCallbackFlow(input: {
  readonly flowStore: FlowStore;
  readonly query: LinearOAuthModel["callbackQuery"];
}):
  | { readonly ok: true; readonly flow: OAuthFlow }
  | { readonly ok: false; readonly response: Response } {
  const state = normalizeText(input.query.state);
  if (!state) {
    return {
      ok: false,
      response: renderCallbackPage({
        title: "Missing state",
        body: "This Linear sign-in session is missing a state token.",
        statusCode: 400,
      }),
    };
  }
  const flow = input.flowStore.getByState(state);
  if (!(flow && flow.provider === "linear")) {
    return {
      ok: false,
      response: renderCallbackPage({
        title: "Session not found",
        body: "This Linear sign-in session was not found or already expired.",
        statusCode: 404,
      }),
    };
  }
  if (Date.now() <= flow.expiresAtMs) {
    return {
      ok: true,
      flow,
    };
  }
  return {
    ok: false,
    response: markLinearFlowError({
      flowStore: input.flowStore,
      flowId: flow.id,
      error: "oauth_flow_expired",
      status: "expired",
      title: "Session expired",
      body: "This Linear sign-in session expired. Start a new flow from Hack.",
      statusCode: 410,
    }),
  };
}

function markLinearFlowError(input: {
  readonly flowStore: FlowStore;
  readonly flowId: string;
  readonly error: string;
  readonly status: "error" | "expired";
  readonly title: string;
  readonly body: string;
  readonly statusCode: number;
}): Response {
  input.flowStore.markError({
    flowId: input.flowId,
    error: input.error,
    status: input.status,
  });
  return renderCallbackPage({
    title: input.title,
    body: input.body,
    statusCode: input.statusCode,
  });
}

export async function handleRefreshToken(input: {
  readonly config: BrokerConfig;
  readonly body: LinearOAuthModel["refreshBody"];
}): Promise<
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt?: string;
      readonly refreshToken?: string;
      readonly refreshTokenExpiresAt?: string;
    }
  | { readonly ok: false; readonly error: string; readonly statusCode: number }
> {
  const refreshToken = normalizeText(input.body.refreshToken);
  if (!refreshToken) {
    return {
      ok: false,
      error: "missing_refresh_token",
      statusCode: 400,
    };
  }
  if (!input.config.linearClientId) {
    return {
      ok: false,
      error: "linear_oauth_not_configured",
      statusCode: 412,
    };
  }

  const refresh = await refreshAccessToken({
    tokenUrl: input.config.linearTokenUrl,
    clientId: input.config.linearClientId,
    ...(input.config.linearClientSecret
      ? { clientSecret: input.config.linearClientSecret }
      : {}),
    refreshToken,
  });
  if (!refresh.ok) {
    return {
      ok: false,
      error: refresh.error,
      statusCode: refresh.statusCode >= 400 ? refresh.statusCode : 502,
    };
  }

  return {
    ok: true,
    token: refresh.token,
    ...(refresh.tokenExpiresAt ? { expiresAt: refresh.tokenExpiresAt } : {}),
    ...(refresh.refreshToken ? { refreshToken: refresh.refreshToken } : {}),
    ...(refresh.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: refresh.refreshTokenExpiresAt }
      : {}),
  };
}

export function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
    },
  });
}

function renderCallbackPage(input: {
  readonly title: string;
  readonly body: string;
  readonly statusCode: number;
  readonly success?: boolean;
}): Response {
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${escapeHtml(input.title)}</title>`,
    "  <style>",
    "    :root { color-scheme: light dark; }",
    "    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0b0c0e; color: #f4f5f7; }",
    "    .card { max-width: 520px; margin: 10vh auto; padding: 24px; border-radius: 16px; background: rgba(22, 24, 29, 0.92); border: 1px solid rgba(255,255,255,0.08); }",
    "    h1 { margin: 0 0 12px; font-size: 22px; }",
    "    p { margin: 0; line-height: 1.5; opacity: 0.92; white-space: pre-wrap; }",
    `    .tone { color: ${input.success ? "#73e2a7" : "#ffb3b3"}; }`,
    "  </style>",
    "</head>",
    "<body>",
    '  <div class="card">',
    `    <h1 class="tone">${escapeHtml(input.title)}</h1>`,
    `    <p>${escapeHtml(input.body)}</p>`,
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n");
  return new Response(html, {
    status: input.statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
