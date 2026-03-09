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
import { issueBrokerManagementToken } from "../better-auth/management-token.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import { buildHackDesktopDeepLink } from "../github-oauth/service.ts";
import { persistLinearLocalAccessCustody } from "../linear-connections/local-access.ts";
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

type CallbackPageAction = {
  readonly label: string;
  readonly url: string;
};

export function createFlow(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly query: Pick<
    LinearOAuthModel["startQuery"],
    "profile" | "setDefault" | "desktopRedirectUrl"
  >;
  readonly requestedBy?: {
    readonly betterAuthUserId: string;
    readonly betterAuthOrganizationId?: string | null;
    readonly betterAuthTeamId?: string | null;
  } | null;
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
  const desktopRedirectUrl = normalizeDesktopRedirectUrl(
    input.query.desktopRedirectUrl
  );
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
    ...(desktopRedirectUrl ? { desktopRedirectUrl } : {}),
    ...(input.requestedBy?.betterAuthUserId
      ? {
          requestedByBetterAuthUserId: input.requestedBy.betterAuthUserId,
          ...(input.requestedBy.betterAuthOrganizationId
            ? {
                requestedByBetterAuthOrganizationId:
                  input.requestedBy.betterAuthOrganizationId,
              }
            : {}),
          ...(input.requestedBy.betterAuthTeamId
            ? {
                requestedByBetterAuthTeamId: input.requestedBy.betterAuthTeamId,
              }
            : {}),
        }
      : {}),
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
  try {
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
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
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
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
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
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
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
        statusCode: 200,
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
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
        statusCode: 200,
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
      });
    }

    const betterAuthLink = await resolveBetterAuthUserFromLinearAccount({
      runtime: input.betterAuthRuntime,
      account: identity.account,
      autoProvision: input.config.betterAuthLinearAutoProvisionUsers,
    });
    const betterAuthSession = flow.requestedByBetterAuthUserId
      ? createRequestedBetterAuthSession({ flow })
      : await resolveBetterAuthSession({
          runtime: input.betterAuthRuntime,
          request: input.request,
        });
    const linkedAccount = {
      ...identity.account,
      ...((betterAuthSession.session?.userId ?? betterAuthLink.userId)
        ? {
            betterAuthUserId:
              betterAuthSession.session?.userId ?? betterAuthLink.userId,
          }
        : {}),
      ...(betterAuthLink.state
        ? { betterAuthLinkState: betterAuthLink.state }
        : {}),
    } as const;
    const managementToken = issueBrokerManagementToken({
      userId: betterAuthSession.session?.userId ?? betterAuthLink.userId ?? "",
      profileId: flow.profileId,
      organizationId: betterAuthSession.session?.organizationId ?? null,
      teamId: betterAuthSession.session?.teamId ?? null,
    });

    await input.connectionStore.upsertConnection({
      profileId: flow.profileId,
      accountId: identity.account.accountId,
      accountName: identity.account.accountName,
      accountEmail: identity.account.accountEmail,
      betterAuthUserId:
        betterAuthSession.session?.userId ?? betterAuthLink.userId ?? null,
      betterAuthOrganizationId:
        betterAuthSession.session?.organizationId ?? null,
      betterAuthTeamId: betterAuthSession.session?.teamId ?? null,
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

    const persistedLocalAccess = await persistLinearLocalAccessCustody({
      config: input.config,
      connectionStore: input.connectionStore,
      profileId: flow.profileId,
      token: exchange.token,
      tokenExpiresAt: exchange.tokenExpiresAt,
      refreshToken: exchange.refreshToken,
      refreshTokenExpiresAt: exchange.refreshTokenExpiresAt,
    });
    if (!persistedLocalAccess.ok) {
      return markLinearFlowError({
        flowStore: input.flowStore,
        flowId: flow.id,
        error: persistedLocalAccess.error,
        status: "error",
        title: "Connection failed",
        body:
          persistedLocalAccess.error === "provider_token_custody_not_configured"
            ? "Hack could not secure this Linear account for reuse yet. Return to Hack and try again later."
            : "Hack could not finish securing this Linear account. Return to Hack and try again.",
        statusCode: 200,
        ...(flow.desktopRedirectUrl
          ? {
              actions: [
                buildOpenHackAction({
                  flow,
                  status: "error",
                }),
              ],
            }
          : {}),
      });
    }

    input.flowStore.markComplete({
      flowId: flow.id,
      account: linkedAccount,
      token: exchange.token,
      tokenExpiresAt: exchange.tokenExpiresAt,
      refreshToken: exchange.refreshToken,
      refreshTokenExpiresAt: exchange.refreshTokenExpiresAt,
      managementToken: managementToken?.token,
      managementTokenExpiresAt: managementToken?.expiresAt,
    });

    return renderCallbackPage({
      title: "Linear connected",
      body: "Authorization is complete. Return to Hack to finish account setup.",
      statusCode: 200,
      success: true,
      actions: flow.desktopRedirectUrl
        ? [
            buildOpenHackAction({
              flow,
              status: "complete",
            }),
          ]
        : [],
    });
  } catch (error) {
    const actions = flow.desktopRedirectUrl
      ? [
          buildOpenHackAction({
            flow,
            status: "error",
          }),
        ]
      : [];
    try {
      return markLinearFlowError({
        flowStore: input.flowStore,
        flowId: flow.id,
        error:
          error instanceof Error ? error.message : "linear_callback_failed",
        status: "error",
        title: "Connection failed",
        body: "Linear authorization could not be completed. Return to Hack and try again.",
        statusCode: 200,
        actions,
      });
    } catch {
      return renderCallbackPage({
        title: "Connection failed",
        body: "Linear authorization could not be completed. Return to Hack and try again.",
        statusCode: 200,
        actions,
      });
    }
  }
}

function createRequestedBetterAuthSession(input: {
  readonly flow: OAuthFlow;
}): {
  readonly enabled: true;
  readonly accessControlMode:
    | "better_auth_team_owned"
    | "better_auth_session_owned"
    | "better_auth_organization_owned";
  readonly session: {
    readonly userId: string;
    readonly email: null;
    readonly name: null;
    readonly organizationId: string | null;
    readonly teamId: string | null;
    readonly managementTokenProfileId: null;
  };
} {
  let accessControlMode:
    | "better_auth_team_owned"
    | "better_auth_session_owned"
    | "better_auth_organization_owned" = "better_auth_session_owned";
  if (input.flow.requestedByBetterAuthTeamId) {
    accessControlMode = "better_auth_team_owned";
  } else if (input.flow.requestedByBetterAuthOrganizationId) {
    accessControlMode = "better_auth_organization_owned";
  }
  return {
    enabled: true,
    accessControlMode,
    session: {
      userId: input.flow.requestedByBetterAuthUserId ?? "",
      email: null,
      name: null,
      organizationId: input.flow.requestedByBetterAuthOrganizationId ?? null,
      teamId: input.flow.requestedByBetterAuthTeamId ?? null,
      managementTokenProfileId: null,
    },
  };
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
  readonly actions?: readonly CallbackPageAction[];
}): Response {
  try {
    input.flowStore.markError({
      flowId: input.flowId,
      error: input.error,
      status: input.status,
    });
  } catch {
    // Rendering the browser recovery page matters more than recording flow
    // state. Callback failures must never surface as raw host errors.
  }
  return renderCallbackPage({
    title: input.title,
    body: input.body,
    statusCode: input.statusCode,
    actions: input.actions,
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
  readonly actions?: readonly CallbackPageAction[];
}): Response {
  const actions = input.actions ?? [];
  const actionsHtml =
    actions.length > 0
      ? `<div class="actions">${actions
          .map(
            (action) =>
              `<a class="button" href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a>`
          )
          .join("")}</div>`
      : "";
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
      background: #0a0a0a;
      color: #f5f5f5;
      font-family: ui-monospace, "SF Mono", Menlo, Monaco, monospace;
    }
    main {
      width: min(92vw, 560px);
      display: grid;
      gap: 18px;
      justify-items: center;
      text-align: center;
    }
    .brand {
      font-size: 28px;
      letter-spacing: 0.22em;
      color: #d4d4d8;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: ${input.success ? "#e4e4e7" : "#fca5a5"};
    }
    p {
      margin: 0;
      max-width: 440px;
      font-size: 13px;
      line-height: 1.6;
      color: #a1a1aa;
      white-space: pre-wrap;
    }
    .actions {
      display: grid;
      gap: 12px;
      width: min(92vw, 360px);
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      padding: 0 20px;
      border: 1px solid #52525b;
      border-radius: 0;
      color: #f5f5f5;
      text-decoration: none;
      font-size: 13px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: transparent;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">HACK</div>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.body)}</p>
    ${actionsHtml}
  </main>
</body>
</html>`;
  return new Response(html, {
    status: input.statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function buildOpenHackAction(input: {
  readonly flow: OAuthFlow;
  readonly status: string;
}): CallbackPageAction {
  return {
    label: "Open Hack",
    url: buildHackDesktopDeepLink({
      flowId: input.flow.id,
      profileId: input.flow.profileId,
      status: input.status,
      ...(input.flow.desktopRedirectUrl
        ? { baseUrl: input.flow.desktopRedirectUrl }
        : {}),
    }),
  };
}

function normalizeDesktopRedirectUrl(value: string | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    if (url.protocol !== "hack:" && url.protocol !== "hack-dev:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
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
