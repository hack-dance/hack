import { randomBytes, randomUUID } from "node:crypto";

import { Elysia, t } from "elysia";

import type {
  BetterAuthAccountLinkingPolicy,
  BetterAuthRuntime,
  BetterAuthSocialProvider,
} from "../../better-auth.ts";
import type { BrokerConfig } from "../../config.ts";
import { type FlowStore, hashDeviceCode } from "../../flow-store.ts";
import { issueBrokerManagementToken } from "./management-token.ts";
import { resolveBetterAuthSession } from "./session.ts";

const SESSION_FLOW_PROFILE_ID = "session";
const SAFE_RETURN_PROTOCOLS = new Set(["hack:"]);

const BetterAuthShellModel = {
  startQuery: t.Object({
    provider: t.Optional(t.String()),
    redirect: t.Optional(t.String()),
  }),
  flowStatusParams: t.Object({
    flowId: t.String(),
  }),
  flowStatusQuery: t.Object({
    deviceCode: t.String(),
    claim: t.Optional(t.String()),
  }),
  authPageQuery: t.Object({
    flowId: t.Optional(t.String()),
    deviceCode: t.Optional(t.String()),
    provider: t.Optional(t.String()),
    redirect: t.Optional(t.String()),
  }),
  accountPageQuery: t.Object({
    flowId: t.Optional(t.String()),
    deviceCode: t.Optional(t.String()),
    redirect: t.Optional(t.String()),
  }),
} as const;

type CreateBetterAuthShellPluginOptions = {
  readonly config: BrokerConfig;
  readonly runtime: BetterAuthRuntime;
  readonly flowStore: FlowStore;
};

type BrowserSessionUser = {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
};

type SessionFlowLifecycle =
  | {
      readonly state: "none";
    }
  | {
      readonly state: "sign_in_required";
      readonly flowId: string;
      readonly deviceCode: string;
      readonly returnUrl: string | null;
    }
  | {
      readonly state: "ready";
      readonly flowId: string;
      readonly deviceCode: string;
      readonly returnUrl: string | null;
    }
  | {
      readonly state: "claimed";
      readonly flowId: string;
      readonly deviceCode: string;
      readonly returnUrl: string | null;
    }
  | {
      readonly state: "invalid";
      readonly title: string;
      readonly message: string;
      readonly flowId?: string;
      readonly deviceCode?: string;
      readonly returnUrl: string | null;
    };

/**
 * Better Auth shell routes for browser sign-in, account linking, and
 * management-token bootstrap flows used by local clients.
 */
export function createBetterAuthShellPlugin({
  config,
  runtime,
  flowStore,
}: CreateBetterAuthShellPluginOptions) {
  return new Elysia({
    name: "hack-auth-broker.better-auth.shell",
  })
    .get(
      "/v1/auth/session/start",
      ({ query, set }) => {
        if (!(runtime.enabled && runtime.auth)) {
          set.status = 503;
          return {
            ok: false,
            error: runtime.reason ?? "Better Auth is not configured.",
          } as const;
        }

        const socialProviders = getSocialProviders({ runtime });
        if (socialProviders.length === 0) {
          set.status = 412;
          return {
            ok: false,
            error: "better_auth_social_providers_not_configured",
          } as const;
        }

        const requestedProviderId = normalizeProviderId({
          value: query.provider,
          providers: socialProviders,
        });
        if (query.provider && !requestedProviderId) {
          set.status = 400;
          return {
            ok: false,
            error: "provider_not_supported",
            socialProviders,
          } as const;
        }

        const nowMs = Date.now();
        const flowId = randomUUID();
        const deviceCode = makeToken();
        const expiresAtMs = nowMs + config.flowTtlMs;
        const returnUrl = normalizeSafeReturnUrl({
          value: query.redirect,
          publicBaseUrl: config.publicBaseUrl,
        });
        const authorizeUrl = buildAuthShellUrl({
          publicBaseUrl: config.publicBaseUrl,
          flowId,
          deviceCode,
          ...(requestedProviderId ? { providerId: requestedProviderId } : {}),
          ...(returnUrl ? { returnUrl } : {}),
        });

        flowStore.createFlow({
          id: flowId,
          provider: "session",
          state: makeToken(),
          profileId: SESSION_FLOW_PROFILE_ID,
          setDefault: false,
          deviceCodeHash: hashDeviceCode(deviceCode),
          authorizeUrl,
          createdAtMs: nowMs,
          expiresAtMs,
          redirectUri: `${config.publicBaseUrl}/auth/account`,
          status: "pending",
        });

        return {
          ok: true,
          flow: {
            flowId,
            authorizeUrl,
            deviceCode,
            pollUrl: `${config.publicBaseUrl}/v1/auth/session/flows/${flowId}`,
            expiresAt: new Date(expiresAtMs).toISOString(),
            socialProviders,
            ...(requestedProviderId ? { provider: requestedProviderId } : {}),
          },
        } as const;
      },
      {
        query: BetterAuthShellModel.startQuery,
      }
    )
    .get(
      "/v1/auth/session/flows/:flowId",
      ({ params, query, set }) => {
        const flow = flowStore.getById(params.flowId);
        if (!(flow && flow.provider === "session")) {
          set.status = 404;
          return {
            ok: false,
            error: "flow_not_found",
          } as const;
        }
        const status = flowStore.getStatus({
          flowId: params.flowId,
          deviceCode: query.deviceCode,
          claimToken: isTruthy(query.claim),
          requireInstallation: false,
        });
        if (!status.ok) {
          set.status = status.statusCode;
          return {
            ok: false,
            error: status.error,
          } as const;
        }
        return {
          ok: true,
          status: status.status,
        } as const;
      },
      {
        params: BetterAuthShellModel.flowStatusParams,
        query: BetterAuthShellModel.flowStatusQuery,
      }
    )
    .get("/v1/auth/me", async ({ request, set }) => {
      if (!(runtime.enabled && runtime.auth)) {
        set.status = 503;
        return {
          ok: false,
          error: runtime.reason ?? "Better Auth is not configured.",
        } as const;
      }
      const resolvedSession = await resolveBetterAuthSession({
        runtime,
        request,
      });
      return {
        ok: true,
        authenticated: Boolean(resolvedSession.session),
        accessControlMode: resolvedSession.accessControlMode,
        session: resolvedSession.session,
        socialProviders: getSocialProviders({ runtime }),
        accountLinkingPolicy: getAccountLinkingPolicy({ runtime }),
        shellPath: "/auth",
        accountPath: "/auth/account",
      } as const;
    })
    .get(
      "/auth",
      async ({ query, request }) => {
        const socialProviders = getSocialProviders({ runtime });
        const returnUrl = normalizeSafeReturnUrl({
          value: query.redirect,
          publicBaseUrl: config.publicBaseUrl,
        });
        if (!(runtime.enabled && runtime.auth)) {
          return renderHtmlPage({
            title: "Hack auth unavailable",
            body: renderStateCard({
              eyebrow: "Auth unavailable",
              title: "Hack auth is not configured",
              body:
                runtime.reason ??
                "The auth broker is missing Better Auth configuration.",
              tone: "muted",
            }),
          });
        }

        const preferredProviderId = normalizeProviderId({
          value: query.provider,
          providers: socialProviders,
        });
        const resolvedSession = await resolveBetterAuthSession({
          runtime,
          request,
        });
        if (resolvedSession.session) {
          return Response.redirect(
            buildAccountPageUrl({
              publicBaseUrl: config.publicBaseUrl,
              flowId: query.flowId,
              deviceCode: query.deviceCode,
              returnUrl,
            }),
            302
          );
        }

        const callbackUrl = buildAccountPageUrl({
          publicBaseUrl: config.publicBaseUrl,
          flowId: query.flowId,
          deviceCode: query.deviceCode,
          returnUrl,
        });
        const autoProviderId =
          preferredProviderId ??
          (socialProviders.length === 1
            ? (socialProviders[0]?.id ?? null)
            : null);
        return renderHtmlPage({
          title: "Hack auth",
          body: [
            renderStateCard({
              eyebrow: "Sign in",
              title: "Connect Hack auth",
              body: "Use a configured provider to open a first-party Hack session in this browser.",
              tone: "neutral",
            }),
            socialProviders.length > 0
              ? renderProviderActionGrid({
                  providers: socialProviders,
                  callbackUrl,
                  mode: "sign-in",
                })
              : renderStateCard({
                  eyebrow: "No providers",
                  title: "No social login providers are configured",
                  body: "Configure GitHub or Google credentials for Better Auth, then reload this page.",
                  tone: "muted",
                }),
            renderFlowHint({
              flowId: query.flowId,
              deviceCode: query.deviceCode,
            }),
          ].join(""),
          script: renderProviderActionScript({
            callbackUrl,
            autoProviderId,
            mode: "sign-in",
          }),
        });
      },
      {
        query: BetterAuthShellModel.authPageQuery,
      }
    )
    .get(
      "/auth/account",
      async ({ query, request }) => {
        const socialProviders = getSocialProviders({ runtime });
        const returnUrl = normalizeSafeReturnUrl({
          value: query.redirect,
          publicBaseUrl: config.publicBaseUrl,
        });
        if (!(runtime.enabled && runtime.auth)) {
          return renderHtmlPage({
            title: "Hack account unavailable",
            body: renderStateCard({
              eyebrow: "Auth unavailable",
              title: "Hack auth is not configured",
              body:
                runtime.reason ??
                "The auth broker is missing Better Auth configuration.",
              tone: "muted",
            }),
          });
        }

        const rawSession = await runtime.auth.api.getSession({
          headers: request.headers,
        });
        const resolvedSession = await resolveBetterAuthSession({
          runtime,
          request,
        });
        const browserSession = toBrowserSessionUser({ session: rawSession });
        const lifecycle = maybeCompleteSessionFlow({
          config,
          flowStore,
          browserSession,
          flowId: query.flowId,
          deviceCode: query.deviceCode,
          returnUrl,
        });
        return renderHtmlPage({
          title: "Hack account",
          body: renderAccountBody({
            session: resolvedSession.session,
            socialProviders,
            lifecycle,
            accountLinkingPolicy: getAccountLinkingPolicy({ runtime }),
            accountPageUrl: buildAccountPageUrl({
              publicBaseUrl: config.publicBaseUrl,
              flowId: query.flowId,
              deviceCode: query.deviceCode,
              returnUrl,
            }),
          }),
          script: resolvedSession.session
            ? renderProviderActionScript({
                callbackUrl: buildAccountPageUrl({
                  publicBaseUrl: config.publicBaseUrl,
                  flowId: query.flowId,
                  deviceCode: query.deviceCode,
                  returnUrl,
                }),
                autoProviderId: null,
                mode: "link",
              })
            : undefined,
        });
      },
      {
        query: BetterAuthShellModel.accountPageQuery,
      }
    );
}

function getSocialProviders(input: {
  readonly runtime: BetterAuthRuntime;
}): readonly BetterAuthSocialProvider[] {
  return input.runtime.socialProviders ?? [];
}

function getAccountLinkingPolicy(input: {
  readonly runtime: BetterAuthRuntime;
}): BetterAuthAccountLinkingPolicy {
  return (
    input.runtime.accountLinkingPolicy ?? {
      requireVerifiedEmail: true,
      allowDifferentEmails: false,
      trustedProviders: [],
    }
  );
}

function maybeCompleteSessionFlow(input: {
  readonly config: BrokerConfig;
  readonly flowStore: FlowStore;
  readonly browserSession: BrowserSessionUser | null;
  readonly flowId?: string;
  readonly deviceCode?: string;
  readonly returnUrl: string | null;
}): SessionFlowLifecycle {
  const flowId = normalizeText(input.flowId);
  const deviceCode = normalizeText(input.deviceCode);
  if (!(flowId && deviceCode)) {
    return { state: "none" };
  }

  const flow = input.flowStore.getById(flowId);
  if (!(flow && flow.provider === "session")) {
    return {
      state: "invalid",
      title: "Session not found",
      message: "This Hack auth session is missing or already expired.",
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }

  const statusResult = input.flowStore.getStatus({
    flowId,
    deviceCode,
    claimToken: false,
    requireInstallation: false,
  });
  if (!statusResult.ok) {
    return {
      state: "invalid",
      title: "Session unavailable",
      message: humanizeFlowError({ error: statusResult.error }),
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }

  if (statusResult.status.status === "claimed") {
    return {
      state: "claimed",
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }
  if (statusResult.status.status === "complete") {
    return {
      state: "ready",
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }
  if (statusResult.status.status !== "pending") {
    return {
      state: "invalid",
      title: "Session unavailable",
      message: humanizeFlowError({ error: statusResult.status.error }),
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }
  if (!input.browserSession) {
    return {
      state: "sign_in_required",
      flowId,
      deviceCode,
      returnUrl: input.returnUrl,
    };
  }

  const managementToken = issueBrokerManagementToken({
    userId: input.browserSession.id,
    organizationId: input.browserSession.organizationId,
    teamId: input.browserSession.teamId,
  });
  input.flowStore.markComplete({
    flowId,
    account: {
      accountId: input.browserSession.id,
      accountName: input.browserSession.name ?? undefined,
      accountEmail: input.browserSession.email ?? undefined,
      accountEmailVerified: input.browserSession.emailVerified,
      betterAuthUserId: input.browserSession.id,
    },
    managementToken: managementToken?.token,
    managementTokenExpiresAt: managementToken?.expiresAt,
  });
  return {
    state: "ready",
    flowId,
    deviceCode,
    returnUrl: input.returnUrl,
  };
}

function toBrowserSessionUser(input: {
  readonly session: unknown;
}): BrowserSessionUser | null {
  const record = readRecord(input.session);
  const user = readRecord(record?.user);
  if (!user) {
    return null;
  }
  const userId = normalizeText(user.id);
  if (!userId) {
    return null;
  }
  const sessionRecord = readRecord(record?.session);
  return {
    id: userId,
    email: normalizeText(user.email),
    emailVerified: user.emailVerified === true,
    name: normalizeText(user.name),
    organizationId:
      normalizeText(sessionRecord?.activeOrganizationId) ??
      normalizeText(record?.activeOrganizationId),
    teamId:
      normalizeText(sessionRecord?.activeTeamId) ??
      normalizeText(record?.activeTeamId),
  };
}

function renderAccountBody(input: {
  readonly session: Awaited<
    ReturnType<typeof resolveBetterAuthSession>
  >["session"];
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly lifecycle: SessionFlowLifecycle;
  readonly accountLinkingPolicy: BetterAuthAccountLinkingPolicy;
  readonly accountPageUrl: string;
}): string {
  const sessionSummary = input.session
    ? renderStateCard({
        eyebrow: "Signed in",
        title: escapeHtml(
          input.session.name ?? input.session.email ?? "Hack account"
        ),
        body: [
          input.session.email
            ? `<strong>Email:</strong> ${escapeHtml(input.session.email)}`
            : null,
          `<strong>User ID:</strong> ${escapeHtml(input.session.userId)}`,
          input.session.organizationId
            ? `<strong>Organization:</strong> ${escapeHtml(input.session.organizationId)}`
            : null,
          input.session.teamId
            ? `<strong>Team:</strong> ${escapeHtml(input.session.teamId)}`
            : null,
        ]
          .filter(Boolean)
          .join("<br />"),
        tone: "neutral",
      })
    : renderStateCard({
        eyebrow: "Not signed in",
        title: "Complete sign-in to finish setup",
        body: "Use the provider buttons below or return to the auth landing page to open a browser session first.",
        tone: "warning",
      });

  const lifecycleCard = renderLifecycleCard({
    lifecycle: input.lifecycle,
    accountPageUrl: input.accountPageUrl,
  });
  const linkingCard = input.session
    ? [
        renderStateCard({
          eyebrow: "Linked providers",
          title: "Link another provider",
          body: renderLinkingPolicy(input.accountLinkingPolicy),
          tone: "muted",
        }),
        renderProviderActionGrid({
          providers: input.socialProviders,
          callbackUrl: input.accountPageUrl,
          mode: "link",
        }),
      ].join("")
    : "";

  return [sessionSummary, lifecycleCard, linkingCard].join("");
}

function renderLifecycleCard(input: {
  readonly lifecycle: SessionFlowLifecycle;
  readonly accountPageUrl: string;
}): string {
  if (input.lifecycle.state === "none") {
    return renderStateCard({
      eyebrow: "Ready",
      title: "Hack session is active",
      body: "You can return to the app now, or link another provider from this account page.",
      tone: "neutral",
    });
  }
  if (input.lifecycle.state === "sign_in_required") {
    const retryUrl = buildAuthShellUrlFromAccountPageUrl({
      accountPageUrl: input.accountPageUrl,
      flowId: input.lifecycle.flowId,
      deviceCode: input.lifecycle.deviceCode,
      returnUrl: input.lifecycle.returnUrl,
    });
    return renderStateCard({
      eyebrow: "Pending",
      title: "Finish sign-in to complete this session flow",
      body: `Return to <a href="${escapeHtml(
        retryUrl
      )}">the auth landing page</a> and continue with a provider.`,
      tone: "warning",
    });
  }
  if (input.lifecycle.state === "ready") {
    return renderStateCard({
      eyebrow: "Ready",
      title: "Hack auth is ready to claim",
      body: renderCompletionBody({
        returnUrl: input.lifecycle.returnUrl,
      }),
      tone: "success",
    });
  }
  if (input.lifecycle.state === "claimed") {
    return renderStateCard({
      eyebrow: "Claimed",
      title: "This session flow was already claimed",
      body: renderCompletionBody({
        returnUrl: input.lifecycle.returnUrl,
      }),
      tone: "muted",
    });
  }
  return renderStateCard({
    eyebrow: "Unavailable",
    title: escapeHtml(input.lifecycle.title),
    body: escapeHtml(input.lifecycle.message),
    tone: "danger",
  });
}

function renderCompletionBody(input: {
  readonly returnUrl: string | null;
}): string {
  if (!input.returnUrl) {
    return "Return to Hack and finish the local setup flow.";
  }
  return `Return to Hack and finish the local setup flow. <a href="${escapeHtml(
    input.returnUrl
  )}">Open app</a>.`;
}

function renderProviderActionGrid(input: {
  readonly providers: readonly BetterAuthSocialProvider[];
  readonly callbackUrl: string;
  readonly mode: "sign-in" | "link";
}): string {
  return `<div class="providers">${input.providers
    .map(
      (provider) =>
        `<button class="provider-button" type="button" data-auth-mode="${input.mode}" data-auth-provider="${escapeHtml(
          provider.id
        )}" data-auth-callback-url="${escapeHtml(input.callbackUrl)}">${
          input.mode === "link" ? "Link" : "Continue with"
        } ${escapeHtml(provider.label)}</button>`
    )
    .join("")}</div>`;
}

function renderFlowHint(input: {
  readonly flowId?: string;
  readonly deviceCode?: string;
}): string {
  if (!(input.flowId && input.deviceCode)) {
    return "";
  }
  return renderStateCard({
    eyebrow: "Device flow",
    title: "This browser session is linked to a local client",
    body: `Flow: <code>${escapeHtml(input.flowId)}</code>`,
    tone: "muted",
  });
}

function renderProviderActionScript(input: {
  readonly callbackUrl: string;
  readonly autoProviderId: string | null;
  readonly mode: "sign-in" | "link";
}): string {
  return `
const authButtons = [...document.querySelectorAll("[data-auth-provider]")];
const authStatus = document.getElementById("auth-status");
const authEndpoints = {
  "sign-in": "/api/auth/sign-in/social",
  "link": "/api/auth/link-social",
};

async function runAuthAction(button) {
  const provider = button.getAttribute("data-auth-provider");
  const mode = button.getAttribute("data-auth-mode") || ${JSON.stringify(
    input.mode
  )};
  const callbackURL =
    button.getAttribute("data-auth-callback-url") || ${JSON.stringify(
      input.callbackUrl
    )};
  if (!provider) {
    return;
  }
  button.disabled = true;
  if (authStatus) {
    authStatus.textContent = mode === "link" ? "Linking provider..." : "Redirecting to provider...";
  }
  try {
    const response = await fetch(authEndpoints[mode] || authEndpoints["sign-in"], {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider,
        callbackURL,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        payload?.message ||
          payload?.error ||
          payload?.code ||
          "Auth request failed"
      );
    }
    const nextUrl =
      typeof payload?.url === "string" && payload.url.length > 0
        ? payload.url
        : callbackURL;
    window.location.assign(nextUrl);
  } catch (error) {
    if (authStatus) {
      authStatus.textContent =
        error instanceof Error ? error.message : String(error);
    }
    button.disabled = false;
  }
}

for (const button of authButtons) {
  button.addEventListener("click", () => void runAuthAction(button));
}

const autoProviderId = ${JSON.stringify(input.autoProviderId)};
if (autoProviderId) {
  const target = document.querySelector(
    '[data-auth-provider="' + CSS.escape(autoProviderId) + '"]'
  );
  if (target instanceof HTMLButtonElement) {
    window.requestAnimationFrame(() => {
      void runAuthAction(target);
    });
  }
}
`;
}

function renderLinkingPolicy(policy: BetterAuthAccountLinkingPolicy): string {
  const parts = [
    policy.requireVerifiedEmail
      ? "Verified provider email is required for implicit account linking."
      : "Implicit account linking can use unverified provider email.",
    policy.allowDifferentEmails
      ? "Different provider emails are allowed."
      : "Provider email must match the existing Hack account email.",
  ];
  if (policy.trustedProviders.length > 0) {
    parts.push(
      `Trusted providers: ${policy.trustedProviders
        .map((providerId) => escapeHtml(providerId))
        .join(", ")}.`
    );
  }
  return parts.join(" ");
}

function renderStateCard(input: {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly tone: "neutral" | "muted" | "warning" | "success" | "danger";
}): string {
  return `<section class="card card-${input.tone}">
  <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
  <h2>${input.title}</h2>
  <p>${input.body}</p>
</section>`;
}

function renderHtmlPage(input: {
  readonly title: string;
  readonly body: string;
  readonly script?: string;
}): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f3ef;
        --panel: rgba(255, 255, 255, 0.92);
        --text: #1e1d1a;
        --muted: #666155;
        --line: rgba(33, 28, 19, 0.14);
        --accent: #0f766e;
        --accent-strong: #115e59;
        --warning: #b45309;
        --danger: #b91c1c;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "SF Pro Display", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(15, 118, 110, 0.12), transparent 28rem),
          linear-gradient(180deg, #f8f6f1 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        width: min(42rem, calc(100vw - 2rem));
        margin: 0 auto;
        padding: 2rem 0 3rem;
      }

      h1 {
        font-size: clamp(2rem, 4vw, 2.8rem);
        line-height: 1;
        margin: 0 0 0.75rem;
      }

      p.lede {
        margin: 0 0 1.5rem;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.5;
      }

      .card {
        padding: 1.1rem 1.15rem;
        border-radius: 1rem;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: 0 18px 48px rgba(18, 18, 18, 0.07);
        margin-bottom: 0.9rem;
      }

      .card h2 {
        margin: 0;
        font-size: 1.05rem;
      }

      .card p {
        margin: 0.6rem 0 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .card-success { border-color: rgba(17, 94, 89, 0.22); }
      .card-warning { border-color: rgba(180, 83, 9, 0.22); }
      .card-danger { border-color: rgba(185, 28, 28, 0.22); }

      .eyebrow {
        margin: 0 0 0.45rem;
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .providers {
        display: grid;
        gap: 0.75rem;
        margin-bottom: 0.9rem;
      }

      .provider-button {
        appearance: none;
        width: 100%;
        border: 0;
        border-radius: 999px;
        padding: 0.95rem 1.15rem;
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: white;
        font-size: 0.98rem;
        font-weight: 700;
        letter-spacing: 0.01em;
        cursor: pointer;
        transition: transform 120ms ease, opacity 120ms ease;
      }

      .provider-button:hover { transform: translateY(-1px); }
      .provider-button:disabled { opacity: 0.62; cursor: progress; transform: none; }

      #auth-status {
        min-height: 1.25rem;
        margin: 0.65rem 0 0;
        color: var(--muted);
        font-size: 0.92rem;
      }

      code {
        padding: 0.12rem 0.35rem;
        border-radius: 0.35rem;
        background: rgba(30, 29, 26, 0.06);
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 0.86em;
      }

      a { color: var(--accent-strong); text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hack auth</h1>
      <p class="lede">First-party session setup for Hack CLI and Hack Desktop.</p>
      ${input.body}
      <p id="auth-status" aria-live="polite"></p>
    </main>
    ${input.script ? `<script>${input.script}</script>` : ""}
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    }
  );
}

function buildAuthShellUrl(input: {
  readonly publicBaseUrl: string;
  readonly flowId?: string;
  readonly deviceCode?: string;
  readonly providerId?: string;
  readonly returnUrl?: string;
}): string {
  const url = new URL("/auth", resolvePageBaseUrl(input.publicBaseUrl));
  if (input.flowId) {
    url.searchParams.set("flowId", input.flowId);
  }
  if (input.deviceCode) {
    url.searchParams.set("deviceCode", input.deviceCode);
  }
  if (input.providerId) {
    url.searchParams.set("provider", input.providerId);
  }
  if (input.returnUrl) {
    url.searchParams.set("redirect", input.returnUrl);
  }
  return url.toString();
}

function buildAuthShellUrlFromAccountPageUrl(input: {
  readonly accountPageUrl: string;
  readonly flowId: string;
  readonly deviceCode: string;
  readonly returnUrl: string | null;
}): string {
  const accountPageUrl = new URL(input.accountPageUrl);
  return buildAuthShellUrl({
    publicBaseUrl: accountPageUrl.origin,
    flowId: input.flowId,
    deviceCode: input.deviceCode,
    ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
  });
}

function buildAccountPageUrl(input: {
  readonly publicBaseUrl: string;
  readonly flowId?: string;
  readonly deviceCode?: string;
  readonly returnUrl?: string | null;
}): string {
  const url = new URL("/auth/account", resolvePageBaseUrl(input.publicBaseUrl));
  if (input.flowId) {
    url.searchParams.set("flowId", input.flowId);
  }
  if (input.deviceCode) {
    url.searchParams.set("deviceCode", input.deviceCode);
  }
  if (input.returnUrl) {
    url.searchParams.set("redirect", input.returnUrl);
  }
  return url.toString();
}

function normalizeProviderId(input: {
  readonly value?: string;
  readonly providers: readonly BetterAuthSocialProvider[];
}): string | null {
  const value = normalizeText(input.value);
  if (!value) {
    return null;
  }
  const match = input.providers.find((provider) => provider.id === value);
  return match?.id ?? null;
}

function normalizeSafeReturnUrl(input: {
  readonly value?: string;
  readonly publicBaseUrl: string;
}): string | null {
  const value = normalizeText(input.value);
  if (!value) {
    return null;
  }
  try {
    const candidate = new URL(value, input.publicBaseUrl);
    if (SAFE_RETURN_PROTOCOLS.has(candidate.protocol)) {
      return candidate.toString();
    }
    const baseOrigin = new URL(input.publicBaseUrl).origin;
    return candidate.origin === baseOrigin ? candidate.toString() : null;
  } catch {
    return null;
  }
}

function resolvePageBaseUrl(publicBaseUrl: string): string {
  return publicBaseUrl.endsWith("/") ? publicBaseUrl : `${publicBaseUrl}/`;
}

function humanizeFlowError(input: { readonly error?: string }): string {
  if (!input.error) {
    return "This auth session is no longer available.";
  }
  if (input.error === "invalid_device_code") {
    return "This auth session does not match the local client that started it.";
  }
  if (input.error === "flow_not_found") {
    return "This auth session was not found or has already expired.";
  }
  if (input.error === "oauth_flow_expired") {
    return "This auth session expired before it was completed.";
  }
  return input.error.replaceAll("_", " ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function makeToken(): string {
  return randomBytes(32).toString("base64url");
}
