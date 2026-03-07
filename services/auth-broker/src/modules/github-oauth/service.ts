import { randomBytes, randomUUID } from "node:crypto";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import { resolveBetterAuthUserFromGitHubAccount } from "../../better-auth-link.ts";
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
  readonly requireInstallation: boolean;
  readonly authorizeUrl: string;
  readonly requestedScopes: string;
  readonly deviceCode: string;
  readonly pollUrl: string;
  readonly appInstallUrl?: string;
  readonly appId?: string;
  readonly appSlug?: string;
  readonly expiresAt: string;
};

type CallbackPageAction = {
  readonly label: string;
  readonly url: string;
  readonly openInNewTab?: boolean;
};

/**
 * Build and persist a new GitHub OAuth flow state.
 */
export function createFlow(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly query: Pick<
    GitHubOAuthModel["startQuery"],
    "profile" | "setDefault" | "requireInstallation" | "desktopRedirectUrl"
  >;
}): StartFlowPayload {
  const nowMs = Date.now();
  const flowId = randomUUID();
  const state = makeToken();
  const deviceCode = makeToken();
  const profileId = normalizeText(input.query.profile) ?? "default";
  const setDefault = isTruthy(input.query.setDefault);
  const requireInstallation = isTruthy(input.query.requireInstallation);
  const desktopRedirectUrl = normalizeDesktopRedirectUrl(
    input.query.desktopRedirectUrl
  );
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
    provider: "github",
    state,
    profileId,
    setDefault,
    deviceCodeHash: hashDeviceCode(deviceCode),
    authorizeUrl,
    ...(input.config.githubAppId ? { appId: input.config.githubAppId } : {}),
    ...(input.config.githubAppSlug
      ? { appSlug: input.config.githubAppSlug }
      : {}),
    ...(input.config.githubAppInstallUrl
      ? { appInstallUrl: input.config.githubAppInstallUrl }
      : {}),
    createdAtMs: nowMs,
    expiresAtMs,
    redirectUri: input.config.githubRedirectUri,
    ...(desktopRedirectUrl ? { desktopRedirectUrl } : {}),
    status: "pending",
  });

  return {
    flowId,
    profileId,
    setDefault,
    requireInstallation,
    authorizeUrl,
    requestedScopes: input.config.githubScopes,
    deviceCode,
    pollUrl: `${input.config.publicBaseUrl}/v1/auth/github/flows/${flowId}`,
    ...(input.config.githubAppInstallUrl
      ? { appInstallUrl: input.config.githubAppInstallUrl }
      : {}),
    ...(input.config.githubAppId ? { appId: input.config.githubAppId } : {}),
    ...(input.config.githubAppSlug
      ? { appSlug: input.config.githubAppSlug }
      : {}),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Refresh a completed flow's installation visibility while token is still claimable.
 */
export async function refreshFlowInstallationsIfNeeded(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly flowId: string;
}): Promise<void> {
  const flow = input.flowStore.getById(input.flowId);
  if (!flow) {
    return;
  }
  if (!(flow.status === "complete" && flow.token && flow.account)) {
    return;
  }
  if (flow.installationId) {
    return;
  }
  const identity = await fetchIdentity({
    apiBaseUrl: input.config.githubApiBaseUrl,
    token: flow.token,
  });
  if (!identity.ok) {
    return;
  }
  const installationIds = identity.account.installationIds ?? [];
  const installationId =
    installationIds.length === 1
      ? (installationIds[0] ?? undefined)
      : undefined;
  input.flowStore.updateInstallationState({
    flowId: flow.id,
    installationIds,
    ...(installationId ? { installationId } : {}),
  });
}

/**
 * Complete OAuth callback flow and return browser-facing HTML response.
 */
export async function handleGitHubCallback(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
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
  const installationIdFromCallback = normalizeText(input.query.installation_id);
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

  const installationIds = identity.account.installationIds ?? [];
  const installationId =
    installationIdFromCallback ??
    (installationIds.length === 1
      ? (installationIds[0] ?? undefined)
      : undefined);

  const betterAuthLink = await resolveBetterAuthUserFromGitHubAccount({
    runtime: input.betterAuthRuntime,
    account: identity.account,
    autoProvision: input.config.betterAuthGitHubAutoProvisionUsers,
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
    ...(installationId ? { installationId } : {}),
  });
  const openHackAppAction: CallbackPageAction = {
    label: "Open Hack app",
    url: buildHackDesktopDeepLink({
      flowId: flow.id,
      profileId: flow.profileId,
      status: installationId ? "complete" : "install_required",
      ...(flow.desktopRedirectUrl ? { baseUrl: flow.desktopRedirectUrl } : {}),
      ...(installationId ? { installationId } : {}),
    }),
  };

  if (installationId) {
    return renderCallbackPage({
      title: "GitHub connected",
      body: "Authorization and app installation are complete. Return to Hack.",
      actions: [openHackAppAction],
      success: true,
      statusCode: 200,
    });
  }
  if (input.config.githubAppInstallUrl) {
    return renderCallbackPage({
      title: "Authorize complete, install required",
      body: "Authorization succeeded, but no GitHub App installation is selected yet. Install the app for your target org/repositories, then return to Hack.",
      actions: [
        {
          label: "Open GitHub App install",
          url: input.config.githubAppInstallUrl,
          openInNewTab: true,
        },
        openHackAppAction,
      ],
      success: true,
      statusCode: 200,
    });
  }

  return renderCallbackPage({
    title: "GitHub connected",
    body: "Authorization is complete. Return to Hack to finish account setup.",
    actions: [openHackAppAction],
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

/**
 * Build desktop deep link used by auth callback pages to return focus to Hack.
 */
export function buildHackDesktopDeepLink(input: {
  readonly flowId: string;
  readonly profileId: string;
  readonly status: string;
  readonly baseUrl?: string;
  readonly installationId?: string;
}): string {
  const url = new URL(input.baseUrl ?? "hack://auth/github/callback");
  url.searchParams.set("flowId", input.flowId);
  url.searchParams.set("profileId", input.profileId);
  url.searchParams.set("status", input.status);
  if (input.installationId) {
    url.searchParams.set("installationId", input.installationId);
  }
  return url.toString();
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

function renderCallbackPage(input: {
  readonly title: string;
  readonly body: string;
  readonly actions?: readonly CallbackPageAction[];
  readonly success?: boolean;
  readonly statusCode: number;
}): Response {
  const statusColor = input.success ? "#16a34a" : "#ef4444";
  const actions = input.actions ?? [];
  const actionsHtml =
    actions.length > 0
      ? `<div class="actions">${actions
          .map(
            (action) =>
              `<a class="button" href="${escapeHtml(action.url)}"${action.openInNewTab ? ' rel="noopener noreferrer" target="_blank"' : ""}>${escapeHtml(action.label)}</a>`
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
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .button {
      display: inline-flex;
      align-items: center;
      border-radius: 10px;
      border: 1px solid #334155;
      background: #111827;
      color: #e5e7eb;
      text-decoration: none;
      padding: 8px 12px;
      font-size: 13px;
      line-height: 1.2;
    }
    .button:hover {
      border-color: #475569;
      background: #1f2937;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.body)}</p>
    ${actionsHtml}
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
