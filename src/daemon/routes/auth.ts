import { randomUUID } from "node:crypto";

import { secrets } from "bun";
import { Elysia, t } from "elysia";

import {
  DEFAULT_AUTH_ALIAS_HOST,
  DEFAULT_AUTH_SERVER_PORT,
} from "../../constants.ts";
import {
  resolveGitHubAuthSettings,
  saveGitHubAppToken,
} from "../../control-plane/extensions/github/auth.ts";
import { readControlPlaneConfig } from "../../control-plane/sdk/config.ts";
import { updateGlobalConfig } from "../../lib/config.ts";
import { isRecord } from "../../lib/guards.ts";

const GITHUB_EXTENSION_ID = "dance.hack.github";
const GITHUB_SECRET_SERVICE = "hack-github-auth";
const DEFAULT_CLIENT_SECRET_AUTH_REF = "github.oauth.client_secret";
const DEFAULT_GITHUB_OAUTH_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
const DEFAULT_GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_GITHUB_OAUTH_SCOPES = "repo,read:org";
const FLOW_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATH_SUFFIX_PATTERN = /\/gh\/callback$/;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const AUTH_BASE_URL_HEADER = "x-hack-auth-base-url";

type GitHubOAuthFlowStatus = "pending" | "complete" | "error" | "expired";

type GitHubOAuthFlow = {
  readonly id: string;
  readonly state: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly authorizeUrl: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string;
  readonly apiBaseUrl: string;
  status: GitHubOAuthFlowStatus;
  error?: string;
  accountLogin?: string;
  accountName?: string;
  accountId?: string;
  installationId?: string;
  completedAt?: string;
};

type GitHubOAuthConfig =
  | {
      readonly ok: true;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scopes: string;
      readonly authorizeUrl: string;
      readonly tokenUrl: string;
      readonly apiBaseUrl: string;
      readonly redirectUri: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type GitHubIdentityResult =
  | {
      readonly ok: true;
      readonly login: string;
      readonly accountId?: string;
      readonly accountName?: string;
      readonly installations: readonly { readonly id: string }[];
    }
  | { readonly ok: false; readonly error: string };

const GITHUB_FLOWS_BY_ID = new Map<string, GitHubOAuthFlow>();
const GITHUB_FLOW_ID_BY_STATE = new Map<string, string>();
let AUTH_ROUTE_APP: ReturnType<typeof createAuthRouteApp> | null = null;

type AuthRouteMiddlewareContext = {
  readonly authBaseUrl: string;
  readonly authUrl: URL;
};

/**
 * Handles local auth routes exposed by the daemon-side browser auth service.
 *
 * Routing is implemented with composable Elysia plugins so health/provider/core
 * and GitHub callback plumbing share a consistent middleware/controller shape.
 */
export async function handleAuthRoutes(opts: {
  readonly req: Request;
  readonly baseUrl: string;
}): Promise<Response> {
  const request = withAuthBaseUrlHeader({
    req: opts.req,
    baseUrl: opts.baseUrl,
  });
  const app = AUTH_ROUTE_APP ?? createAuthRouteApp();
  AUTH_ROUTE_APP = app;
  return await app.handle(request);
}

/**
 * Compose the auth route app as feature plugins.
 */
function createAuthRouteApp() {
  return new Elysia({
    name: "hack-auth.local-routes",
  })
    .onBeforeHandle((ctx: unknown) => {
      const request = (ctx as { readonly request: Request }).request;
      pruneExpiredFlows();
      if (request.method === "GET" || request.method === "POST") {
        return;
      }
      return jsonResponse({ error: "method_not_allowed" }, 405);
    })
    .use(createAuthSharedMiddlewarePlugin())
    .use(createAuthCoreRoutesPlugin())
    .use(createAuthGitHubRoutesPlugin())
    .all("*", () => jsonResponse({ error: "not_found" }, 404));
}

/**
 * Shared middleware plugin for route guard + request-scoped base URL context.
 */
function createAuthSharedMiddlewarePlugin() {
  return new Elysia({
    name: "hack-auth.shared-middleware",
  }).derive(
    ({ request }): AuthRouteMiddlewareContext => ({
      authBaseUrl: resolveRequestBaseUrl({ request }),
      authUrl: new URL(request.url),
    })
  );
}

/**
 * Core route plugin (health + provider discovery).
 */
function createAuthCoreRoutesPlugin() {
  return new Elysia({
    name: "hack-auth.core-routes",
  })
    .all("/health", () => authHealthResponse())
    .all("/v1/auth/providers", () => authProvidersResponse());
}

/**
 * GitHub OAuth route plugin used by desktop/browser callback flows.
 */
function createAuthGitHubRoutesPlugin() {
  return new Elysia({
    name: "hack-auth.github-routes",
  })
    .all("/gh/start", async (ctx: unknown) => {
      const { request, authBaseUrl, authUrl } = ctx as {
        readonly request: Request;
      } & AuthRouteMiddlewareContext;
      return await handleGitHubStartHtmlRoute({
        req: request,
        baseUrl: authBaseUrl,
        url: authUrl,
      });
    })
    .all("/gh/callback", async (ctx: unknown) => {
      const { request, authUrl } = ctx as {
        readonly request: Request;
      } & AuthRouteMiddlewareContext;
      return await handleGitHubCallbackRoute({
        req: request,
        url: authUrl,
      });
    })
    .all("/v1/auth/github/config", async (ctx: unknown) => {
      const { authBaseUrl } = ctx as AuthRouteMiddlewareContext;
      return await handleGitHubConfigRoute({ baseUrl: authBaseUrl });
    })
    .all("/v1/auth/github/start", async (ctx: unknown) => {
      const { request, authBaseUrl, authUrl } = ctx as {
        readonly request: Request;
      } & AuthRouteMiddlewareContext;
      return await handleGitHubStartJsonRoute({
        req: request,
        baseUrl: authBaseUrl,
        url: authUrl,
      });
    })
    .all(
      "/v1/auth/github/flows/:flowId",
      (ctx: unknown) => {
        const { params } = ctx as {
          readonly params: { readonly flowId: string };
        };
        return handleGitHubFlowStatusRoute({ flowId: params.flowId });
      },
      {
        params: t.Object({
          flowId: t.String(),
        }),
      }
    );
}

function withAuthBaseUrlHeader(opts: {
  readonly req: Request;
  readonly baseUrl: string;
}): Request {
  const headers = new Headers(opts.req.headers);
  headers.set(
    AUTH_BASE_URL_HEADER,
    normalizeBaseUrl({ baseUrl: opts.baseUrl })
  );
  return new Request(opts.req, { headers });
}

function resolveRequestBaseUrl(opts: { readonly request: Request }): string {
  const headerBaseUrl = normalizeString(
    opts.request.headers.get(AUTH_BASE_URL_HEADER)
  );
  if (headerBaseUrl) {
    return normalizeBaseUrl({ baseUrl: headerBaseUrl });
  }
  const url = new URL(opts.request.url);
  return normalizeBaseUrl({
    baseUrl: `${url.protocol}//${url.host}`,
  });
}

function authHealthResponse(): Response {
  return jsonResponse({
    status: "ok",
    service: "hack-auth",
    now: new Date().toISOString(),
  });
}

function authProvidersResponse(): Response {
  return jsonResponse({
    providers: ["github"],
    service: "hack-auth",
    now: new Date().toISOString(),
  });
}

async function handleGitHubStartHtmlRoute(opts: {
  readonly req: Request;
  readonly url: URL;
  readonly baseUrl: string;
}): Promise<Response> {
  if (opts.req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const started = await startGitHubFlow({
    url: opts.url,
    baseUrl: opts.baseUrl,
  });
  if (!started.ok) {
    return htmlResponse({
      title: "Hack GitHub auth setup required",
      body: started.error,
    });
  }
  return redirectResponse({ location: started.flow.authorizeUrl });
}

async function handleGitHubCallbackRoute(opts: {
  readonly req: Request;
  readonly url: URL;
}): Promise<Response> {
  if (opts.req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  return await handleGitHubCallback({
    url: opts.url,
  });
}

async function handleGitHubConfigRoute(opts: {
  readonly baseUrl: string;
}): Promise<Response> {
  const config = await resolveGitHubOAuthConfig({ baseUrl: opts.baseUrl });
  if (!config.ok) {
    return jsonResponse(config, 412);
  }
  return jsonResponse({
    ok: true,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    apiBaseUrl: config.apiBaseUrl,
  });
}

async function handleGitHubStartJsonRoute(opts: {
  readonly req: Request;
  readonly url: URL;
  readonly baseUrl: string;
}): Promise<Response> {
  if (opts.req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const started = await startGitHubFlow({
    url: opts.url,
    baseUrl: opts.baseUrl,
  });
  if (!started.ok) {
    return jsonResponse(started, 412);
  }
  return jsonResponse({
    ok: true,
    flowId: started.flow.id,
    profileId: started.flow.profileId,
    setDefault: started.flow.setDefault,
    authorizeUrl: started.flow.authorizeUrl,
    statusUrl: `${normalizeBaseUrl({ baseUrl: opts.baseUrl })}/v1/auth/github/flows/${started.flow.id}`,
    expiresAt: new Date(started.flow.expiresAtMs).toISOString(),
  });
}

function handleGitHubFlowStatusRoute(opts: {
  readonly flowId: string;
}): Response {
  const flowId = normalizeString(opts.flowId);
  if (!flowId) {
    return jsonResponse({ error: "flow_not_found" }, 404);
  }
  const flow = GITHUB_FLOWS_BY_ID.get(flowId);
  if (!flow) {
    return jsonResponse({ error: "flow_not_found" }, 404);
  }
  return jsonResponse({
    id: flow.id,
    status: flow.status,
    profileId: flow.profileId,
    setDefault: flow.setDefault,
    createdAt: new Date(flow.createdAtMs).toISOString(),
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
    completedAt: flow.completedAt ?? null,
    accountLogin: flow.accountLogin ?? null,
    accountName: flow.accountName ?? null,
    accountId: flow.accountId ?? null,
    installationId: flow.installationId ?? null,
    error: flow.error ?? null,
  });
}

async function startGitHubFlow(opts: {
  readonly url: URL;
  readonly baseUrl: string;
}): Promise<
  | { readonly ok: true; readonly flow: GitHubOAuthFlow }
  | { readonly ok: false; readonly error: string }
> {
  const config = await resolveGitHubOAuthConfig({ baseUrl: opts.baseUrl });
  if (!config.ok) {
    return config;
  }

  const profileId =
    normalizeString(opts.url.searchParams.get("profile")) ?? "default";
  const setDefault = parseBooleanQuery({
    value: opts.url.searchParams.get("set_default"),
    defaultValue: true,
  });
  const flowId = randomUUID();
  const state = randomUUID();
  const now = Date.now();
  const expiresAtMs = now + FLOW_TTL_MS;
  const authorizeUrl = buildGitHubAuthorizeUrl({
    authorizeUrl: config.authorizeUrl,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    state,
  });
  const flow: GitHubOAuthFlow = {
    id: flowId,
    state,
    profileId,
    setDefault,
    authorizeUrl,
    createdAtMs: now,
    expiresAtMs,
    redirectUri: config.redirectUri,
    apiBaseUrl: config.apiBaseUrl,
    status: "pending",
  };
  GITHUB_FLOWS_BY_ID.set(flowId, flow);
  GITHUB_FLOW_ID_BY_STATE.set(state, flowId);
  return { ok: true, flow };
}

async function handleGitHubCallback(opts: {
  readonly url: URL;
}): Promise<Response> {
  const errorMessage = normalizeString(opts.url.searchParams.get("error"));
  const errorDescription = normalizeString(
    opts.url.searchParams.get("error_description")
  );
  const state = normalizeString(opts.url.searchParams.get("state"));
  const code = normalizeString(opts.url.searchParams.get("code"));

  if (!state) {
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: "Missing state parameter in callback.",
    });
  }
  const flowId = GITHUB_FLOW_ID_BY_STATE.get(state);
  if (!flowId) {
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: "Flow not found or expired. Start a new connection from the app.",
    });
  }
  const flow = GITHUB_FLOWS_BY_ID.get(flowId);
  if (!flow) {
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: "Flow not found or expired. Start a new connection from the app.",
    });
  }
  if (Date.now() > flow.expiresAtMs) {
    flow.status = "expired";
    flow.error = "Flow expired before callback completed.";
    return htmlResponse({
      title: "Hack GitHub auth expired",
      body: "Flow expired. Return to Hack Desktop and try again.",
    });
  }

  if (errorMessage) {
    flow.status = "error";
    flow.error = errorDescription ?? errorMessage;
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth denied",
      body: flow.error ?? "Authorization was denied.",
    });
  }
  if (!code) {
    flow.status = "error";
    flow.error = "Missing authorization code in callback.";
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: flow.error,
    });
  }

  const config = await resolveGitHubOAuthConfig({
    baseUrl: flow.redirectUri.replace(CALLBACK_PATH_SUFFIX_PATTERN, ""),
  });
  if (!config.ok) {
    flow.status = "error";
    flow.error = config.error;
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth setup required",
      body: config.error,
    });
  }

  const exchanged = await exchangeGitHubOAuthCode({
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    state,
    redirectUri: flow.redirectUri,
  });
  if (!exchanged.ok) {
    flow.status = "error";
    flow.error = exchanged.error;
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: exchanged.error,
    });
  }

  const identity = await fetchGitHubIdentity({
    apiBaseUrl: flow.apiBaseUrl,
    token: exchanged.token,
  });
  if (!identity.ok) {
    flow.status = "error";
    flow.error = identity.error;
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: identity.error,
    });
  }

  const installationIdFromCallback = normalizeString(
    opts.url.searchParams.get("installation_id")
  );
  const installationId =
    installationIdFromCallback ??
    (identity.installations.length === 1
      ? identity.installations[0]?.id
      : undefined);

  const persisted = await persistGitHubFlowToken({
    flow,
    token: exchanged.token,
    expiresAt: exchanged.expiresAt,
    accountLogin: identity.login,
    accountName: identity.accountName,
    accountId: identity.accountId,
    installationId,
  });
  if (!persisted.ok) {
    flow.status = "error";
    flow.error = persisted.error;
    flow.completedAt = new Date().toISOString();
    return htmlResponse({
      title: "Hack GitHub auth failed",
      body: persisted.error,
    });
  }

  flow.status = "complete";
  flow.accountLogin = identity.login;
  flow.accountName = identity.accountName;
  flow.accountId = identity.accountId;
  flow.installationId = installationId;
  flow.completedAt = new Date().toISOString();

  return htmlResponse({
    title: "GitHub account connected",
    body: [
      `Profile: ${flow.profileId}`,
      `Account: ${identity.login}${identity.accountName ? ` (${identity.accountName})` : ""}`,
      flow.setDefault ? "Set as default profile." : "Profile saved.",
      "You can close this tab and return to Hack Desktop.",
    ].join("\n"),
  });
}

async function persistGitHubFlowToken(opts: {
  readonly flow: GitHubOAuthFlow;
  readonly token: string;
  readonly expiresAt?: string;
  readonly accountLogin: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly installationId?: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const controlPlaneResult = await readControlPlaneConfig({});
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: controlPlaneResult.config,
    profileId: opts.flow.profileId,
    allowProjectOverride: false,
  });
  try {
    await saveGitHubAppToken({
      controlPlaneConfig: controlPlaneResult.config,
      profileId: opts.flow.profileId,
      allowProjectOverride: false,
      token: opts.token,
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      authRef: settings.authRef,
      service: settings.service,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Failed to store token in keychain: ${message}`,
    };
  }

  const profilePath = githubProfilePath({ profileId: opts.flow.profileId });
  try {
    await Promise.all([
      updateGlobalConfig({
        path: `controlPlane.extensions["${GITHUB_EXTENSION_ID}"].enabled`,
        value: true,
      }),
      updateGlobalConfig({
        path: `${profilePath}.tokenEnv`,
        value: settings.tokenEnv,
      }),
      updateGlobalConfig({
        path: `${profilePath}.authRef`,
        value: settings.authRef,
      }),
      updateGlobalConfig({
        path: `${profilePath}.service`,
        value: settings.service,
      }),
      updateGlobalConfig({
        path: `${profilePath}.mode`,
        value: "token",
      }),
      updateGlobalConfig({
        path: `${profilePath}.appId`,
        value: settings.appId ?? "",
      }),
      updateGlobalConfig({
        path: `${profilePath}.installationId`,
        value: opts.installationId ?? settings.installationId ?? "",
      }),
      updateGlobalConfig({
        path: `${profilePath}.privateKeyEnv`,
        value: settings.privateKeyEnv,
      }),
      updateGlobalConfig({
        path: `${profilePath}.privateKeyAuthRef`,
        value: settings.privateKeyAuthRef ?? "",
      }),
      updateGlobalConfig({
        path: `${profilePath}.apiBaseUrl`,
        value: settings.apiBaseUrl,
      }),
      updateGlobalConfig({
        path: `${profilePath}.accountLogin`,
        value: opts.accountLogin,
      }),
      updateGlobalConfig({
        path: `${profilePath}.accountName`,
        value: opts.accountName ?? "",
      }),
      updateGlobalConfig({
        path: `${profilePath}.accountId`,
        value: opts.accountId ?? "",
      }),
      ...(opts.flow.setDefault
        ? [
            updateGlobalConfig({
              path: `controlPlane.extensions["${GITHUB_EXTENSION_ID}"].config.defaultProfile`,
              value: opts.flow.profileId,
            }),
          ]
        : []),
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Failed to update GitHub profile config: ${message}`,
    };
  }

  return { ok: true };
}

function githubProfilePath(opts: { readonly profileId: string }): string {
  const escapedProfileId = opts.profileId
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `controlPlane.extensions["${GITHUB_EXTENSION_ID}"].config.profiles["${escapedProfileId}"]`;
}

async function resolveGitHubOAuthConfig(opts: {
  readonly baseUrl: string;
}): Promise<GitHubOAuthConfig> {
  const controlPlaneResult = await readControlPlaneConfig({});
  const extConfig = readGitHubExtensionConfig({
    controlPlaneConfig: controlPlaneResult.config,
  });
  const clientId = normalizeString(extConfig.oauthClientId);
  if (!clientId) {
    return {
      ok: false,
      error:
        'GitHub OAuth client id is not configured. Set `controlPlane.extensions["dance.hack.github"].config.oauthClientId` first.',
    };
  }
  const secretAuthRef =
    normalizeString(extConfig.oauthClientSecretAuthRef) ??
    DEFAULT_CLIENT_SECRET_AUTH_REF;
  const secretService =
    normalizeString(extConfig.oauthClientSecretService) ??
    GITHUB_SECRET_SERVICE;
  const clientSecret = await secrets.get({
    service: secretService,
    name: secretAuthRef,
  });
  if (!clientSecret) {
    return {
      ok: false,
      error: `GitHub OAuth client secret not found in keychain ref ${secretAuthRef} (service ${secretService}).`,
    };
  }

  const scopes =
    normalizeString(extConfig.oauthScopes) ?? DEFAULT_GITHUB_OAUTH_SCOPES;
  const authorizeUrl =
    normalizeString(extConfig.oauthAuthorizeUrl) ??
    DEFAULT_GITHUB_OAUTH_AUTHORIZE_URL;
  const tokenUrl =
    normalizeString(extConfig.oauthTokenUrl) ?? DEFAULT_GITHUB_OAUTH_TOKEN_URL;
  const apiBaseUrl =
    normalizeString(extConfig.oauthApiBaseUrl) ?? DEFAULT_GITHUB_API_BASE_URL;
  const redirectUri =
    normalizeString(extConfig.oauthRedirectUri) ??
    `${normalizeBaseUrl({ baseUrl: opts.baseUrl })}/gh/callback`;

  return {
    ok: true,
    clientId,
    clientSecret,
    scopes,
    authorizeUrl,
    tokenUrl,
    apiBaseUrl,
    redirectUri,
  };
}

function readGitHubExtensionConfig(opts: {
  readonly controlPlaneConfig: Awaited<
    ReturnType<typeof readControlPlaneConfig>
  >["config"];
}): Record<string, unknown> {
  const extension =
    opts.controlPlaneConfig.extensions?.[
      GITHUB_EXTENSION_ID as keyof typeof opts.controlPlaneConfig.extensions
    ];
  if (!(extension && typeof extension === "object" && "config" in extension)) {
    return {};
  }
  const config = extension.config;
  return isRecord(config) ? config : {};
}

function normalizeBaseUrl(opts: { readonly baseUrl: string }): string {
  const trimmed = opts.baseUrl.trim();
  if (!trimmed) {
    return `http://127.0.0.1:${DEFAULT_AUTH_SERVER_PORT}`;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildGitHubAuthorizeUrl(opts: {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: string;
  readonly state: string;
}): string {
  const nextUrl = new URL(opts.authorizeUrl);
  nextUrl.searchParams.set("client_id", opts.clientId);
  nextUrl.searchParams.set("redirect_uri", opts.redirectUri);
  nextUrl.searchParams.set("scope", opts.scopes);
  nextUrl.searchParams.set("state", opts.state);
  nextUrl.searchParams.set("allow_signup", "false");
  return nextUrl.toString();
}

async function exchangeGitHubOAuthCode(opts: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}): Promise<
  | { readonly ok: true; readonly token: string; readonly expiresAt?: string }
  | { readonly ok: false; readonly error: string }
> {
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
      "User-Agent": "hack-auth",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: `GitHub token exchange failed (${response.status}): invalid response payload.`,
    };
  }
  if (!response.ok) {
    const message =
      normalizeString(payload.error_description) ??
      normalizeString(payload.error) ??
      response.statusText;
    return {
      ok: false,
      error: `GitHub token exchange failed (${response.status}): ${message}`,
    };
  }
  const token = normalizeString(payload.access_token);
  if (!token) {
    const message =
      normalizeString(payload.error_description) ??
      normalizeString(payload.error) ??
      "missing access_token";
    return {
      ok: false,
      error: `GitHub token exchange failed: ${message}`,
    };
  }
  const expiresInRaw = payload.expires_in;
  const expiresInSeconds =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
      ? Math.max(0, Math.floor(expiresInRaw))
      : null;
  const expiresAt =
    expiresInSeconds === null
      ? undefined
      : new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  return {
    ok: true,
    token,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function fetchGitHubIdentity(opts: {
  readonly apiBaseUrl: string;
  readonly token: string;
}): Promise<GitHubIdentityResult> {
  const base = opts.apiBaseUrl.replace(TRAILING_SLASHES_PATTERN, "");
  const headers = buildGitHubApiHeaders({ token: opts.token });
  const user = await fetchGitHubUserProfile({ base, headers });
  if (!user.ok) {
    return user;
  }
  const installations = await fetchGitHubInstallations({ base, headers });

  return {
    ok: true,
    login: user.login,
    ...(user.accountId ? { accountId: user.accountId } : {}),
    ...(user.accountName ? { accountName: user.accountName } : {}),
    installations,
  };
}

function buildGitHubApiHeaders(opts: {
  readonly token: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hack-auth",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubUserProfile(opts: {
  readonly base: string;
  readonly headers: Record<string, string>;
}): Promise<
  | {
      readonly ok: true;
      readonly login: string;
      readonly accountName?: string;
      readonly accountId?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    }
> {
  const userResponse = await fetch(`${opts.base}/user`, {
    method: "GET",
    headers: opts.headers,
  });
  const userPayload = (await userResponse.json().catch(() => null)) as unknown;
  if (!(userResponse.ok && isRecord(userPayload))) {
    const message =
      (isRecord(userPayload) ? normalizeString(userPayload.message) : null) ??
      userResponse.statusText;
    return {
      ok: false,
      error: `GitHub identity lookup failed (${userResponse.status}): ${message}`,
    };
  }
  const login = normalizeString(userPayload.login);
  if (!login) {
    return { ok: false, error: "GitHub identity payload missing login." };
  }
  const accountName = normalizeString(userPayload.name) ?? undefined;
  const accountId = normalizeGithubId({ value: userPayload.id });
  return {
    ok: true,
    login,
    ...(accountName ? { accountName } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

async function fetchGitHubInstallations(opts: {
  readonly base: string;
  readonly headers: Record<string, string>;
}): Promise<readonly { readonly id: string }[]> {
  const response = await fetch(`${opts.base}/user/installations?per_page=100`, {
    method: "GET",
    headers: opts.headers,
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!(response.ok && isRecord(payload))) {
    return [];
  }
  const rawInstallations = payload.installations;
  if (!Array.isArray(rawInstallations)) {
    return [];
  }
  const installations: { id: string }[] = [];
  for (const value of rawInstallations) {
    if (!isRecord(value)) {
      continue;
    }
    const id = normalizeGithubId({ value: value.id });
    if (!id) {
      continue;
    }
    installations.push({ id });
  }
  return installations;
}

function normalizeGithubId(opts: {
  readonly value: unknown;
}): string | undefined {
  if (typeof opts.value === "number" && Number.isFinite(opts.value)) {
    return String(opts.value);
  }
  const normalized = normalizeString(opts.value);
  return normalized ?? undefined;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseBooleanQuery(opts: {
  readonly value: string | null;
  readonly defaultValue: boolean;
}): boolean {
  const normalized = opts.value?.trim().toLowerCase();
  if (!normalized) {
    return opts.defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return opts.defaultValue;
}

function pruneExpiredFlows(): void {
  const now = Date.now();
  for (const [flowId, flow] of GITHUB_FLOWS_BY_ID.entries()) {
    if (flow.expiresAtMs > now) {
      continue;
    }
    GITHUB_FLOWS_BY_ID.delete(flowId);
    GITHUB_FLOW_ID_BY_STATE.delete(flow.state);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirectResponse(opts: { readonly location: string }): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: opts.location,
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(opts: {
  readonly title: string;
  readonly body: string;
}): Response {
  const escapedTitle = escapeHtml(opts.title);
  const escapedBody = escapeHtml(opts.body);
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapedTitle}</title>`,
    "<style>",
    "body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0b0f17;color:#e7edf5;margin:0;padding:32px}",
    ".card{max-width:760px;margin:0 auto;padding:20px;border:1px solid #2a3446;border-radius:14px;background:#111827}",
    "h1{font-size:20px;margin:0 0 12px}",
    "p{white-space:pre-line;line-height:1.45;opacity:.95}",
    "small{display:block;margin-top:12px;opacity:.7}",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    `<h1>${escapedTitle}</h1>`,
    `<p>${escapedBody}</p>`,
    `<small>Host: ${DEFAULT_AUTH_ALIAS_HOST}</small>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
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
