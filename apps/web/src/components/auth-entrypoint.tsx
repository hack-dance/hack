"use client";

import type {
  BetterAuthProviderMetadata,
  BetterAuthSocialProvider,
} from "@hack/auth-contract";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  normalizeAppReturnUrl,
  resolveInitialAuthFlowKind,
  shouldAutoNavigateToReturnUrl,
} from "../lib/auth-handoff";

type AuthEntrypointProps = {
  readonly mode: "sign-in" | "account";
  /** When `mode` is `sign-in`, chooses marketing copy (OAuth creates new users on first GitHub login). */
  readonly variant?: "sign-in" | "sign-up";
  readonly providers: readonly BetterAuthSocialProvider[];
  readonly appBaseUrl: string;
  readonly authBrokerBaseUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly betterAuthSource: "broker" | "fail_closed";
  readonly betterAuthEnabled: boolean;
  readonly flowId?: string;
  readonly deviceCode?: string;
  readonly redirect?: string;
  readonly browserSessionAuthenticated?: boolean;
};

type ActionState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly providerId: string }
  | { readonly kind: "error"; readonly message: string };

type FlowState =
  | { readonly kind: "idle" }
  | { readonly kind: "polling" }
  | { readonly kind: "ready" }
  | { readonly kind: "claimed" }
  | { readonly kind: "error"; readonly message: string };

type FlowStatusPayload = {
  readonly ok?: boolean;
  readonly status?: {
    readonly status?: string;
    readonly error?: string;
  };
  readonly error?: string;
  readonly message?: string;
};

type SocialStartPayload = {
  readonly url?: string;
  readonly error?: string;
  readonly message?: string;
};

export function AuthEntrypoint({
  mode,
  variant = "sign-in",
  providers,
  appBaseUrl,
  authBrokerBaseUrl,
  trustedOrigins,
  betterAuthSource,
  betterAuthEnabled,
  flowId,
  deviceCode,
  redirect,
  browserSessionAuthenticated = false,
}: AuthEntrypointProps) {
  const [resolvedProviders, setResolvedProviders] = useState(providers);
  const [resolvedTrustedOrigins, setResolvedTrustedOrigins] =
    useState(trustedOrigins);
  const normalizedRedirect = useMemo(
    () =>
      normalizeAppReturnUrl({
        value: redirect,
        appBaseUrl,
        trustedOrigins: resolvedTrustedOrigins,
      }),
    [appBaseUrl, redirect, resolvedTrustedOrigins]
  );
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });
  const [flowState, setFlowState] = useState<FlowState>(
    (() => {
      const initialFlowKind = resolveInitialAuthFlowKind({
        mode,
        flowId,
        deviceCode,
        redirect: normalizedRedirect,
        browserSessionAuthenticated,
      });
      if (initialFlowKind === "polling") {
        return { kind: "polling" };
      }
      if (initialFlowKind === "ready") {
        return { kind: "ready" };
      }
      return { kind: "idle" };
    })()
  );

  useEffect(() => {
    let active = true;

    const loadProviders = async () => {
      try {
        const response = await fetch("/api/auth/providers", {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as {
          readonly providers?: readonly BetterAuthProviderMetadata[];
        };
        const betterAuthProvider = payload.providers?.find(
          (provider) => provider.id === "better-auth"
        );
        if (!(active && betterAuthProvider)) {
          return;
        }
        setResolvedProviders(
          betterAuthProvider.enabled ? betterAuthProvider.socialProviders : []
        );
        setResolvedTrustedOrigins(betterAuthProvider.trustedOrigins);
      } catch {
        // Keep the boot-time provider contract when the broker metadata endpoint is unavailable.
      }
    };

    void loadProviders();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!(mode === "account" && flowId && deviceCode)) {
      return;
    }
    let active = true;
    let nextPollHandle: number | undefined;

    const poll = async () => {
      try {
        const response = await fetch(
          buildFlowStatusUrl({
            deviceCode,
            flowId,
          }),
          {
            cache: "no-store",
          }
        );
        const payload = (await response.json()) as FlowStatusPayload;
        if (!active) {
          return;
        }
        const nextState = resolvePolledFlowState({
          payload,
          responseOk: response.ok,
        });
        if (nextState.kind === "polling") {
          setFlowState({ kind: "polling" });
          nextPollHandle = window.setTimeout(() => {
            void poll();
          }, 1000);
          return;
        }
        setFlowState(nextState);
      } catch (error) {
        if (!active) {
          return;
        }
        setFlowState(
          createFlowErrorState({
            fallbackMessage: "Hack could not confirm this browser handoff.",
            message: error instanceof Error ? error.message : undefined,
          })
        );
      }
    };

    void poll();

    return () => {
      active = false;
      if (typeof nextPollHandle === "number") {
        window.clearTimeout(nextPollHandle);
      }
    };
  }, [deviceCode, flowId, mode]);

  useEffect(() => {
    if (
      !(
        (flowState.kind === "ready" || flowState.kind === "claimed") &&
        normalizedRedirect &&
        shouldAutoNavigateToReturnUrl({ value: normalizedRedirect })
      )
    ) {
      return;
    }
    const handle = window.setTimeout(() => {
      window.location.assign(normalizedRedirect);
    }, 180);
    return () => {
      window.clearTimeout(handle);
    };
  }, [flowState.kind, normalizedRedirect]);

  const hasFlowContext = Boolean(flowId && deviceCode);
  const summary = resolveSummary({
    mode,
    variant: mode === "sign-in" ? variant : "sign-in",
    hasFlowContext,
    authBrokerBaseUrl,
  });
  const flowStatus = resolveFlowStatus({
    flowState,
    normalizedRedirect,
  });
  const signInHref = buildAuthPageHref({
    page: "sign-in",
    flowId,
    deviceCode,
    redirect: normalizedRedirect,
  });
  const signUpHref = buildAuthPageHref({
    page: "sign-up",
    flowId,
    deviceCode,
    redirect: normalizedRedirect,
  });
  const accountHref = buildAuthPageHref({
    page: "account",
    flowId,
    deviceCode,
    redirect: normalizedRedirect,
  });

  const handleProviderClick = async (providerId: string) => {
    setActionState({ kind: "loading", providerId });
    try {
      const response = await fetch("/api/auth/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: providerId,
          ...(flowId ? { flowId } : {}),
          ...(deviceCode ? { deviceCode } : {}),
          ...(normalizedRedirect ? { redirect: normalizedRedirect } : {}),
        }),
      });
      const payload = (await response.json()) as SocialStartPayload;
      if (
        !(
          response.ok &&
          typeof payload.url === "string" &&
          payload.url.length > 0
        )
      ) {
        throw new Error(
          payload.message ??
            payload.error ??
            "Hack could not start the selected sign-in provider."
        );
      }
      window.location.assign(payload.url);
    } catch (error) {
      setActionState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Hack could not start the selected sign-in provider.",
      });
    }
  };

  const providerGate = resolveProviderGate({
    betterAuthSource,
    betterAuthEnabled,
    providerCount: resolvedProviders.length,
  });

  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-10">
      <Card className="w-full max-w-md border-border/80 shadow-sm" size="sm">
        <CardHeader className="border-border border-b pb-4">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
            Hack
          </p>
          <CardTitle className="font-semibold text-2xl tracking-tight">
            {summary.title}
          </CardTitle>
          <CardDescription className="text-pretty text-base leading-relaxed">
            {summary.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-6">
          {hasFlowContext ? (
            <section className={authPanelClassName("info")}>
              <h2 className="font-semibold text-foreground text-sm">
                Linked browser handoff
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                This tab is linked to a Hack client flow. Complete sign-in here
                so the broker can finish the session for your CLI or deep link.
              </p>
            </section>
          ) : null}

          {mode === "account" ? (
            <section className={authPanelClassName(flowStatus.tone)}>
              <h2 className="font-semibold text-foreground text-sm">
                {flowStatus.title}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {flowStatus.body}
              </p>
              {flowStatus.href ? (
                <Button asChild className="mt-1 w-fit" variant="outline">
                  <a href={flowStatus.href}>{flowStatus.label}</a>
                </Button>
              ) : null}
            </section>
          ) : null}

          {providerGate ? (
            <section className={authPanelClassName("muted")}>
              <h2 className="font-semibold text-foreground text-sm">
                {providerGate.title}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {providerGate.body}
              </p>
            </section>
          ) : (
            <section className={authPanelClassName("neutral")}>
              <h2 className="font-semibold text-foreground text-sm">
                {mode === "account"
                  ? "Continue with a provider"
                  : "Continue with GitHub"}
              </h2>
              <div className="grid gap-2">
                {resolvedProviders.map((provider) => {
                  const loading =
                    actionState.kind === "loading" &&
                    actionState.providerId === provider.id;
                  let buttonLabel = `Continue with ${provider.label}`;
                  if (loading) {
                    buttonLabel = `Opening ${provider.label}…`;
                  } else if (variant === "sign-up") {
                    buttonLabel = `Sign up with ${provider.label}`;
                  }
                  return (
                    <Button
                      className="w-full"
                      disabled={actionState.kind === "loading"}
                      key={provider.id}
                      onClick={() => void handleProviderClick(provider.id)}
                      type="button"
                    >
                      {buttonLabel}
                    </Button>
                  );
                })}
              </div>
            </section>
          )}

          <p
            aria-live="polite"
            className="min-h-6 text-muted-foreground text-sm"
          >
            {actionState.kind === "error"
              ? actionState.message
              : flowStatus.statusText}
          </p>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3 border-border border-t pt-6">
          <nav
            aria-label="Hack auth navigation"
            className="flex flex-wrap gap-2"
          >
            {mode === "sign-in" && variant === "sign-in" ? (
              <Button asChild size="sm" variant="outline">
                <a href={signUpHref}>Create an account</a>
              </Button>
            ) : null}
            {mode === "sign-in" && variant === "sign-up" ? (
              <Button asChild size="sm" variant="outline">
                <a href={signInHref}>Sign in instead</a>
              </Button>
            ) : null}
            {mode === "sign-in" ? (
              <Button asChild size="sm" variant="outline">
                <a href={accountHref}>Browser handoff status</a>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <a href={signInHref}>Start another sign-in</a>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <a href={authBrokerBaseUrl} rel="noopener noreferrer">
                Auth broker
              </a>
            </Button>
            {normalizedRedirect &&
            !shouldAutoNavigateToReturnUrl({ value: normalizedRedirect }) ? (
              <Button asChild size="sm" variant="outline">
                <a href={normalizedRedirect}>Return to app</a>
              </Button>
            ) : null}
          </nav>
        </CardFooter>
      </Card>
    </main>
  );
}

function resolveProviderGate(input: {
  readonly betterAuthSource: "broker" | "fail_closed";
  readonly betterAuthEnabled: boolean;
  readonly providerCount: number;
}): { readonly title: string; readonly body: string } | null {
  if (input.betterAuthSource === "fail_closed") {
    return {
      title: "Cannot reach the auth broker",
      body: "Start your stack with Hack (for example `hack up`), then open this site using your Hack dev hostname (for example https://hack-cli.hack), not raw localhost, so the app can reach the broker.",
    };
  }
  if (!input.betterAuthEnabled) {
    return {
      title: "Better Auth is not active",
      body: "The broker is reachable but Better Auth is off. Ensure DATABASE_URL and BETTER_AUTH_SECRET are set for the auth-broker service, then restart it.",
    };
  }
  if (input.providerCount === 0) {
    return {
      title: "No OAuth providers",
      body: "GitHub client credentials are not configured on the broker. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (or BETTER_AUTH_GITHUB_*), redeploy the broker, and add your callback URL to the GitHub OAuth app.",
    };
  }
  return null;
}

function authPanelClassName(
  tone: "neutral" | "info" | "success" | "danger" | "muted"
): string {
  return cn(
    "grid gap-2 rounded-xl border p-4",
    tone === "neutral" && "border-border bg-muted/40",
    tone === "info" &&
      "border-sky-500/30 bg-sky-500/10 dark:border-sky-400/25 dark:bg-sky-400/10",
    tone === "success" &&
      "border-emerald-500/35 bg-emerald-500/10 dark:border-emerald-400/30 dark:bg-emerald-400/10",
    tone === "danger" && "border-destructive/40 bg-destructive/10",
    tone === "muted" && "border-border bg-muted/25"
  );
}

function resolveSummary(input: {
  readonly mode: "sign-in" | "account";
  readonly variant: "sign-in" | "sign-up";
  readonly hasFlowContext: boolean;
  readonly authBrokerBaseUrl: string;
}): { readonly title: string; readonly body: string } {
  if (input.mode === "account") {
    return {
      title: "Finish your Hack browser handoff",
      body: input.hasFlowContext
        ? "Hack will poll the broker-backed session flow here while the browser completes sign-in."
        : `Use this route to resume broker-backed auth handoff or continue account management via ${input.authBrokerBaseUrl}.`,
    };
  }
  if (input.variant === "sign-up") {
    return {
      title: "Create your Hack account",
      body: input.hasFlowContext
        ? "This sign-up is linked to a Hack client flow. Continue with GitHub to finish provisioning."
        : "Use GitHub to create your account. If you already use Hack, sign in instead.",
    };
  }
  return {
    title: "Sign in to Hack",
    body: input.hasFlowContext
      ? "This sign-in request came from Hack. Continue with GitHub to finish the CLI and browser handoff."
      : "Sign in with GitHub. Sessions are issued by the Hack auth broker.",
  };
}

function buildAuthPageHref(input: {
  readonly page: "sign-in" | "sign-up" | "account";
  readonly flowId?: string;
  readonly deviceCode?: string;
  readonly redirect: string | null;
}): string {
  const path = input.page === "account" ? "/auth/account" : "/auth";
  const searchParams = new URLSearchParams();
  if (input.flowId) {
    searchParams.set("flowId", input.flowId);
  }
  if (input.deviceCode) {
    searchParams.set("deviceCode", input.deviceCode);
  }
  if (input.redirect) {
    searchParams.set("redirect", input.redirect);
  }
  if (input.page === "sign-up") {
    searchParams.set("variant", "sign-up");
  }
  const query = searchParams.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

function buildFlowStatusUrl(input: {
  readonly deviceCode: string;
  readonly flowId: string;
}): string {
  return `/api/auth/flows/${encodeURIComponent(input.flowId)}?deviceCode=${encodeURIComponent(input.deviceCode)}`;
}

function resolvePolledFlowState(input: {
  readonly payload: FlowStatusPayload;
  readonly responseOk: boolean;
}): FlowState {
  if (!input.responseOk || input.payload.ok !== true) {
    return createFlowErrorState({
      fallbackMessage: "Hack could not confirm this browser handoff.",
      message: input.payload.message ?? input.payload.error,
    });
  }

  switch (input.payload.status?.status) {
    case "complete":
      return { kind: "ready" };
    case "claimed":
      return { kind: "claimed" };
    case "error":
      return createFlowErrorState({
        fallbackMessage:
          "Hack reported an unrecoverable browser handoff error.",
        message: input.payload.status.error,
      });
    default:
      return { kind: "polling" };
  }
}

function createFlowErrorState(input: {
  readonly fallbackMessage: string;
  readonly message?: string;
}): FlowState {
  return {
    kind: "error",
    message: input.message ?? input.fallbackMessage,
  };
}

function resolveFlowStatus(input: {
  readonly flowState: FlowState;
  readonly normalizedRedirect: string | null;
}): {
  readonly title: string;
  readonly body: string;
  readonly tone: "neutral" | "info" | "success" | "danger" | "muted";
  readonly statusText: string;
  readonly href?: string;
  readonly label?: string;
} {
  if (input.flowState.kind === "polling") {
    return {
      title: "Waiting for the broker session",
      body: "Complete sign-in in the provider window. This page will update as soon as the broker marks the flow ready.",
      tone: "info",
      statusText: "Waiting for the broker-backed handoff to complete…",
    };
  }
  if (input.flowState.kind === "ready" || input.flowState.kind === "claimed") {
    return {
      title: "Browser handoff confirmed",
      body: input.normalizedRedirect
        ? "The broker established the session. Return to Hack when you are ready."
        : "The broker established the session. You can close this tab when you are done.",
      tone: "success",
      statusText:
        input.normalizedRedirect &&
        shouldAutoNavigateToReturnUrl({ value: input.normalizedRedirect })
          ? "Returning to Hack…"
          : "Broker-backed session confirmed.",
      ...(input.normalizedRedirect
        ? {
            href: input.normalizedRedirect,
            label: "Return to Hack",
          }
        : {}),
    };
  }
  if (input.flowState.kind === "error") {
    return {
      title: "Browser handoff needs attention",
      body: input.flowState.message,
      tone: "danger",
      statusText: input.flowState.message,
    };
  }
  return {
    title: "No linked handoff is active",
    body: "Use the sign-in route to start a browser session, or open a broker-managed account flow and then return here.",
    tone: "muted",
    statusText: "",
  };
}
