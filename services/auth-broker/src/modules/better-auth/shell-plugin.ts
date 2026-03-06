import { randomBytes, randomUUID } from "node:crypto";

import { Elysia, t } from "elysia";

import type {
  BetterAuthAccountLinkingPolicy,
  BetterAuthRuntime,
  BetterAuthSocialProvider,
} from "../../better-auth.ts";
import { ensureBetterAuthRuntimeReady } from "../../better-auth.ts";
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
      try {
        await ensureBetterAuthRuntimeReady(runtime);
      } catch (error) {
        set.status = 503;
        return {
          ok: false,
          error: "better_auth_storage_unavailable",
          message: error instanceof Error ? error.message : String(error),
        } as const;
      }
      const rawSession = await runtime.auth.api.getSession({
        headers: request.headers,
      });
      const resolvedSession = await resolveBetterAuthSession({
        runtime,
        request,
      });
      const browserSession = toBrowserSessionUser({
        session: rawSession,
      });
      const activeOrganization = extractNamedEntity({
        session: rawSession,
        kind: "organization",
        fallbackId: resolvedSession.session?.organizationId ?? null,
      });
      const activeTeam = extractNamedEntity({
        session: rawSession,
        kind: "team",
        fallbackId: resolvedSession.session?.teamId ?? null,
      });
      return {
        ok: true,
        authenticated: Boolean(resolvedSession.session),
        accessControlMode: resolvedSession.accessControlMode,
        session: resolvedSession.session,
        user: browserSession
          ? {
              id: browserSession.id,
              email: browserSession.email,
              name: browserSession.name,
              emailVerified: browserSession.emailVerified,
            }
          : null,
        activeOrganization,
        activeTeam,
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
            heading: "Hack auth unavailable",
            subtitle: "Shared Hack sign-in is not available right now.",
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
        try {
          await ensureBetterAuthRuntimeReady(runtime);
        } catch (error) {
          return renderHtmlPage({
            title: "Hack auth unavailable",
            heading: "Hack auth unavailable",
            subtitle: "Shared Hack sign-in is not available right now.",
            body: renderLifecycleMessage({
              eyebrow: "Unavailable",
              title: "Auth storage is unavailable",
              body: escapeHtml(
                error instanceof Error ? error.message : String(error)
              ),
              tone: "danger",
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
        const authLanding = buildAuthLandingPresentation({
          socialProviders,
          preferredProviderId,
          callbackUrl,
          flowId: query.flowId,
          deviceCode: query.deviceCode,
        });
        return renderHtmlPage({
          title: "Hack auth",
          heading: authLanding.heading,
          subtitle: authLanding.subtitle,
          body: authLanding.body,
          script: renderProviderActionScript({
            callbackUrl,
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
            heading: "Hack account unavailable",
            subtitle: "This browser cannot finish the Hack session right now.",
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
        try {
          await ensureBetterAuthRuntimeReady(runtime);
        } catch (error) {
          return renderHtmlPage({
            title: "Hack account unavailable",
            heading: "Hack account unavailable",
            subtitle: "This browser cannot finish the Hack session right now.",
            body: renderLifecycleMessage({
              eyebrow: "Unavailable",
              title: "Auth storage is unavailable",
              body: escapeHtml(
                error instanceof Error ? error.message : String(error)
              ),
              tone: "danger",
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
          heading: resolvedSession.session ? "Hack account" : "Finish sign-in",
          subtitle: resolvedSession.session
            ? "This browser is now signed in to Hack."
            : "Complete sign-in to connect this browser to Hack.",
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
            ? [
                renderProviderActionScript({
                  callbackUrl: buildAccountPageUrl({
                    publicBaseUrl: config.publicBaseUrl,
                    flowId: query.flowId,
                    deviceCode: query.deviceCode,
                    returnUrl,
                  }),
                  mode: "link",
                }),
                renderLifecycleAutoReturnScript({
                  lifecycle,
                }),
              ]
                .filter(Boolean)
                .join("\n")
            : renderLifecycleAutoReturnScript({
                lifecycle,
              }) || undefined,
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

function extractNamedEntity(input: {
  readonly session: unknown;
  readonly kind: "organization" | "team";
  readonly fallbackId: string | null;
}): { readonly id: string; readonly name: string | null } | null {
  const record = readRecord(input.session);
  const sessionRecord = readRecord(record?.session);
  const topLevelKey =
    input.kind === "organization" ? "activeOrganization" : "activeTeam";
  const entityRecord =
    readRecord(sessionRecord?.[topLevelKey]) ??
    readRecord(record?.[topLevelKey]);
  const id =
    normalizeText(entityRecord?.id) ??
    normalizeText(
      sessionRecord?.[
        input.kind === "organization" ? "activeOrganizationId" : "activeTeamId"
      ]
    ) ??
    normalizeText(
      record?.[
        input.kind === "organization" ? "activeOrganizationId" : "activeTeamId"
      ]
    ) ??
    input.fallbackId;
  if (!id) {
    return null;
  }
  return {
    id,
    name: normalizeText(entityRecord?.name),
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
    ? renderAccountSummary({
        session: input.session,
        lifecycle: input.lifecycle,
      })
    : renderLifecycleMessage({
        eyebrow: "Not signed in",
        title: "Finish sign-in to continue",
        body: "Use a provider below to open your Hack session in this browser.",
        tone: "warning",
      });

  const lifecycleCard = renderLifecycleMessageForFlow({
    lifecycle: input.lifecycle,
    accountPageUrl: input.accountPageUrl,
  });
  const linkingCard =
    input.session && input.socialProviders.length > 0
      ? [
          `<section class="section">`,
          `<p class="section-label">Add another sign-in method</p>`,
          renderProviderActionGrid({
            providers: input.socialProviders,
            callbackUrl: input.accountPageUrl,
            mode: "link",
          }),
          `<details class="details"><summary>Linking details</summary><p>${renderLinkingPolicy(
            input.accountLinkingPolicy
          )}</p></details>`,
          "</section>",
        ].join("")
      : "";

  return [sessionSummary, lifecycleCard, linkingCard].filter(Boolean).join("");
}

function renderLifecycleMessageForFlow(input: {
  readonly lifecycle: SessionFlowLifecycle;
  readonly accountPageUrl: string;
}): string {
  if (input.lifecycle.state === "none") {
    return renderLifecycleMessage({
      eyebrow: "Session active",
      title: "You are signed in",
      body: "Return to Hack or link another sign-in method from this page.",
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
    return renderLifecycleMessage({
      eyebrow: "Pending",
      title: "Finish sign-in to complete this setup",
      body: `Return to <a href="${escapeHtml(
        retryUrl
      )}">the auth landing page</a> and continue with a provider.`,
      tone: "warning",
    });
  }
  if (input.lifecycle.state === "ready") {
    return renderLifecycleMessage({
      eyebrow: "Ready",
      title: "Hack is ready",
      body: renderCompletionBody({
        returnUrl: input.lifecycle.returnUrl,
      }),
      tone: "success",
    });
  }
  if (input.lifecycle.state === "claimed") {
    return renderLifecycleMessage({
      eyebrow: "Claimed",
      title: "Hack is already connected",
      body: renderCompletionBody({
        returnUrl: input.lifecycle.returnUrl,
      }),
      tone: "muted",
    });
  }
  return renderLifecycleMessage({
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
    return "You can return to Hack now.";
  }
  return `Return to Hack when you're ready. ${renderActionLink({
    href: input.returnUrl,
    label: "Open Hack",
  })}`;
}

function renderAccountSummary(input: {
  readonly session: NonNullable<
    Awaited<ReturnType<typeof resolveBetterAuthSession>>["session"]
  >;
  readonly lifecycle: SessionFlowLifecycle;
}): string {
  const identity = input.session.name ?? input.session.email ?? "Hack account";
  const avatarLabel = identity.slice(0, 1).toUpperCase();
  const meta = [
    input.session.organizationId
      ? renderMetaPill({
          label: "Org",
          value: input.session.organizationId,
        })
      : "",
    input.session.teamId
      ? renderMetaPill({
          label: "Team",
          value: input.session.teamId,
        })
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `<section class="summary">
    <div class="avatar" aria-hidden="true">${escapeHtml(avatarLabel)}</div>
    <div class="summary-copy">
      <p class="section-label">Hack account</p>
      <h2>${escapeHtml(identity)}</h2>
      ${
        input.session.email
          ? `<p class="summary-detail">${escapeHtml(input.session.email)}</p>`
          : ""
      }
      ${meta ? `<div class="meta-row">${meta}</div>` : ""}
      ${
        input.lifecycle.state === "ready" || input.lifecycle.state === "claimed"
          ? `<p class="summary-status">This browser is linked to your Hack account.</p>`
          : ""
      }
    </div>
  </section>`;
}

function renderMetaPill(input: {
  readonly label: string;
  readonly value: string;
}): string {
  return `<span class="meta-pill"><span>${escapeHtml(
    input.label
  )}</span>${escapeHtml(input.value)}</span>`;
}

function renderLifecycleMessage(input: {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly tone: "neutral" | "muted" | "warning" | "success" | "danger";
}): string {
  return `<section class="message message-${input.tone}">
    <p class="message-eyebrow">${escapeHtml(input.eyebrow)}</p>
    <h2>${input.title}</h2>
    <p>${input.body}</p>
  </section>`;
}

function renderLifecycleAutoReturnScript(input: {
  readonly lifecycle: SessionFlowLifecycle;
}): string {
  if (
    (input.lifecycle.state !== "ready" &&
      input.lifecycle.state !== "claimed") ||
    !shouldAutoReturnToDesktop({
      returnUrl: input.lifecycle.returnUrl,
    })
  ) {
    return "";
  }

  return `
window.requestAnimationFrame(() => {
  if (authStatus) {
    authStatus.textContent = "Returning to Hack…";
  }
  window.setTimeout(() => {
    window.location.assign(${JSON.stringify(input.lifecycle.returnUrl)});
  }, 180);
});
`;
}

function buildAuthLandingPresentation(input: {
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly preferredProviderId: string | null;
  readonly callbackUrl: string;
  readonly flowId?: string;
  readonly deviceCode?: string;
}): {
  readonly heading: string;
  readonly subtitle: string;
  readonly body: string;
} {
  const primaryProviderId =
    input.preferredProviderId ??
    (input.socialProviders.length === 1
      ? (input.socialProviders[0]?.id ?? null)
      : null);
  const primaryProvider = primaryProviderId
    ? (input.socialProviders.find(
        (provider) => provider.id === primaryProviderId
      ) ?? null)
    : null;
  const bodySections = [
    renderAuthLandingPrimarySection({
      socialProviders: input.socialProviders,
      primaryProvider,
      callbackUrl: input.callbackUrl,
      isDeviceLinked: Boolean(input.flowId && input.deviceCode),
    }),
    renderFlowHint({
      flowId: input.flowId,
      deviceCode: input.deviceCode,
    }),
  ].filter(Boolean);

  return {
    heading: "Sign in to Hack",
    subtitle:
      input.flowId && input.deviceCode
        ? "This request is linked to your Mac."
        : "Use your Hack account for shared remote features.",
    body: bodySections.join(""),
  };
}

function renderAuthLandingPrimarySection(input: {
  readonly socialProviders: readonly BetterAuthSocialProvider[];
  readonly primaryProvider: BetterAuthSocialProvider | null;
  readonly callbackUrl: string;
  readonly isDeviceLinked: boolean;
}): string {
  if (input.socialProviders.length === 0) {
    return renderStateCard({
      eyebrow: "No providers",
      title: "No sign-in providers are configured",
      body: "Configure GitHub or Google for Better Auth, then try again.",
      tone: "muted",
    });
  }
  if (input.primaryProvider) {
    return renderSingleProviderPanel({
      provider: input.primaryProvider,
      callbackUrl: input.callbackUrl,
      mode: "sign-in",
      isDeviceLinked: input.isDeviceLinked,
    });
  }
  return renderProviderActionGrid({
    providers: input.socialProviders,
    callbackUrl: input.callbackUrl,
    mode: "sign-in",
  });
}

function renderProviderActionGrid(input: {
  readonly providers: readonly BetterAuthSocialProvider[];
  readonly callbackUrl: string;
  readonly mode: "sign-in" | "link";
}): string {
  return `<div class="providers">${input.providers
    .map((provider) =>
      renderProviderActionButton({
        provider,
        callbackUrl: input.callbackUrl,
        mode: input.mode,
      })
    )
    .join("")}</div>`;
}

function renderSingleProviderPanel(input: {
  readonly provider: BetterAuthSocialProvider;
  readonly callbackUrl: string;
  readonly mode: "sign-in" | "link";
  readonly isDeviceLinked: boolean;
}): string {
  return `<section class="hero">
    <p class="hero-copy">${
      input.isDeviceLinked
        ? "Continue in the browser to finish setup in Hack Desktop."
        : "Continue in the browser to open your Hack account."
    }</p>
    ${renderProviderActionButton({
      provider: input.provider,
      callbackUrl: input.callbackUrl,
      mode: input.mode,
    })}
  </section>`;
}

function renderProviderActionButton(input: {
  readonly provider: BetterAuthSocialProvider;
  readonly callbackUrl: string;
  readonly mode: "sign-in" | "link";
}): string {
  return `<button class="provider-button ${
    input.mode === "link" ? "provider-button-secondary" : ""
  }" type="button" data-auth-mode="${input.mode}" data-auth-provider="${escapeHtml(
    input.provider.id
  )}" data-auth-provider-label="${escapeHtml(
    input.provider.label
  )}" data-auth-callback-url="${escapeHtml(input.callbackUrl)}">
      <span class="provider-mark" aria-hidden="true">${escapeHtml(
        input.provider.label.slice(0, 1)
      )}</span>
      <span>${
        input.mode === "link" ? "Link" : "Continue with"
      } ${escapeHtml(input.provider.label)}</span>
    </button>`;
}

function renderFlowHint(input: {
  readonly flowId?: string;
  readonly deviceCode?: string;
}): string {
  if (!(input.flowId && input.deviceCode)) {
    return "";
  }
  return `<details class="details">
    <summary>Details</summary>
    <p>Linked to this Mac.</p>
    <p>Flow <code>${escapeHtml(input.flowId)}</code></p>
  </details>`;
}

function renderProviderActionScript(input: {
  readonly callbackUrl: string;
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
  const providerLabel =
    button.getAttribute("data-auth-provider-label") || "provider";
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
  button.classList.add("is-loading");
  if (authStatus) {
    authStatus.textContent =
      mode === "link"
        ? "Linking " + providerLabel + "…"
        : "Opening " + providerLabel + "…";
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
    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {}
    if (!response.ok) {
      throw new Error(
        payload?.message ||
          payload?.error ||
          payload?.code ||
          (mode === "link"
            ? "Couldn't link this provider right now."
            : "Couldn't start sign-in right now.")
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
    button.classList.remove("is-loading");
  }
}

for (const button of authButtons) {
  button.addEventListener("click", () => void runAuthAction(button));
}
`;
}

function renderLinkingPolicy(policy: BetterAuthAccountLinkingPolicy): string {
  const parts = [
    policy.requireVerifiedEmail
      ? "Verified provider email is required for implicit linking."
      : "Unverified provider email can be used for implicit linking.",
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
  return `<section class="message message-${input.tone}">
  <p class="message-eyebrow">${escapeHtml(input.eyebrow)}</p>
  <h2>${input.title}</h2>
  <p>${input.body}</p>
</section>`;
}

function renderActionLink(input: {
  readonly href: string;
  readonly label: string;
}): string {
  return `<a class="action-link" href="${escapeHtml(input.href)}">${escapeHtml(
    input.label
  )}</a>`;
}

function renderHtmlPage(input: {
  readonly title: string;
  readonly heading?: string;
  readonly subtitle?: string;
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
        --bg: #f4f4f5;
        --panel: #ffffff;
        --text: #111827;
        --muted: #6b7280;
        --line: #e5e7eb;
        --accent: #0f172a;
        --accent-strong: #0f172a;
        --accent-soft: #f3f4f6;
        --warning: #b45309;
        --danger: #b91c1c;
        --success: #047857;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "SF Pro Display", "Helvetica Neue", sans-serif;
        background: var(--bg);
        color: var(--text);
        display: grid;
        place-items: center;
      }

      main {
        width: min(30rem, calc(100vw - 2rem));
        padding: 1.5rem 0;
      }

      .shell {
        padding: 1.5rem;
        border-radius: 1.25rem;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      }

      .brand {
        margin: 0 0 0.65rem;
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--muted);
      }

      h1 {
        font-size: clamp(2.1rem, 6vw, 2.45rem);
        line-height: 0.96;
        letter-spacing: -0.04em;
        margin: 0;
      }

      p.lede {
        margin: 0.6rem 0 0;
        color: var(--muted);
        font-size: 0.98rem;
        line-height: 1.45;
      }

      .stack {
        display: grid;
        gap: 1rem;
        margin-top: 1.35rem;
      }

      .summary,
      .section,
      .hero {
        background: transparent;
      }

      .summary {
        display: flex;
        gap: 0.95rem;
        align-items: flex-start;
        padding: 0 0 1rem;
        border-bottom: 1px solid var(--line);
      }

      .avatar {
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: var(--accent);
        color: white;
        font-weight: 700;
      }

      .summary-copy h2,
      .message h2 {
        margin: 0;
        font-size: 1.02rem;
        line-height: 1.2;
      }

      .summary-copy {
        display: grid;
        gap: 0.28rem;
      }

      .summary-detail {
        margin: 0;
        color: var(--muted);
        font-size: 0.95rem;
      }

      .summary-status {
        margin: 0.15rem 0 0;
        color: var(--muted);
        font-size: 0.9rem;
      }

      .section {
        display: grid;
        gap: 0.7rem;
        padding: 0;
      }

      .hero {
        display: grid;
        gap: 0.6rem;
      }

      .hero-copy {
        margin: 0;
        color: var(--muted);
        font-size: 0.96rem;
        line-height: 1.45;
      }

      .section-label {
        margin: 0;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .meta-row {
        display: flex;
        gap: 0.45rem;
        flex-wrap: wrap;
        margin-top: 0.25rem;
      }

      .meta-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.28rem 0.55rem;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.05);
        color: var(--text);
        font-size: 0.83rem;
      }

      .meta-pill span {
        color: var(--muted);
      }

      .message {
        padding: 0.95rem 1rem;
        border: 1px solid transparent;
        border-radius: 1rem;
      }

      .message p {
        margin: 0.45rem 0 0;
        color: var(--muted);
        line-height: 1.45;
      }

      .message-neutral { background: rgba(15, 23, 42, 0.04); }
      .message-muted { background: rgba(15, 23, 42, 0.03); }
      .message-success { border-color: rgba(4, 120, 87, 0.18); background: rgba(236, 253, 245, 0.88); }
      .message-warning { border-color: rgba(180, 83, 9, 0.18); background: rgba(255, 251, 235, 0.92); }
      .message-danger { border-color: rgba(185, 28, 28, 0.18); background: rgba(254, 242, 242, 0.92); }

      .message-eyebrow {
        margin: 0 0 0.3rem;
        color: var(--muted);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .providers {
        display: grid;
        gap: 0.65rem;
      }

      .provider-button {
        appearance: none;
        width: 100%;
        border: 1px solid var(--accent);
        border-radius: 0.95rem;
        padding: 0.88rem 0.95rem;
        background: var(--accent);
        color: white;
        font-size: 0.97rem;
        font-weight: 680;
        letter-spacing: 0.01em;
        cursor: pointer;
        transition: opacity 120ms ease, background 120ms ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.7rem;
      }

      .provider-button:hover { background: #1f2937; }
      .provider-button:disabled { opacity: 0.7; cursor: progress; }
      .provider-button.is-loading { opacity: 0.76; }

      .provider-button-secondary {
        background: #ffffff;
        color: var(--text);
        border-color: var(--line);
      }

      .provider-button-secondary:hover {
        background: #f9fafb;
      }

      .provider-mark {
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: rgba(255, 255, 255, 0.14);
        font-size: 0.78rem;
        font-weight: 700;
      }

      #auth-status {
        min-height: 1.25rem;
        margin: 0.55rem 0 0;
        color: var(--muted);
        font-size: 0.88rem;
      }

      code {
        padding: 0.12rem 0.35rem;
        border-radius: 0.35rem;
        background: rgba(30, 29, 26, 0.06);
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 0.86em;
      }

      .details {
        margin: 0;
        color: var(--muted);
      }

      .details summary {
        cursor: pointer;
        color: var(--muted);
        font-size: 0.88rem;
        list-style: none;
      }

      .details summary::-webkit-details-marker {
        display: none;
      }

      .details p {
        margin: 0.55rem 0 0;
        font-size: 0.9rem;
        line-height: 1.45;
      }

      .action-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 0.35rem;
        padding: 0.38rem 0.72rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #ffffff;
        font-size: 0.88rem;
        font-weight: 600;
      }

      a { color: var(--accent-strong); text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <main>
      <section class="shell">
        <p class="brand">Hack</p>
        <h1>${escapeHtml(input.heading ?? input.title)}</h1>
        ${
          input.subtitle
            ? `<p class="lede">${escapeHtml(input.subtitle)}</p>`
            : ""
        }
        <div class="stack">
          ${input.body}
        </div>
        <p id="auth-status" aria-live="polite"></p>
      </section>
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

function shouldAutoReturnToDesktop(input: {
  readonly returnUrl: string | null;
}): boolean {
  if (!input.returnUrl) {
    return false;
  }
  try {
    const candidate = new URL(input.returnUrl);
    return candidate.protocol === "hack:";
  } catch {
    return false;
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
