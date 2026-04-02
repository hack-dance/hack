import { afterEach, expect, test } from "bun:test";
import type { BetterAuthProviderMetadata } from "@hack/auth-contract";
import type { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";

import { POST as startSocialSignIn } from "../src/app/api/auth/social/route";
import AuthAccountPage from "../src/app/auth/account/page";
import AuthPage from "../src/app/auth/page";
import { AuthEntrypoint } from "../src/components/auth-entrypoint";

const originalEnv = {
  NEXT_PUBLIC_HACK_WEB_APP_BASE_URL:
    process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL,
  NEXT_PUBLIC_HACK_AUTH_BROKER_URL:
    process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL,
  HACK_AUTH_BROKER_INTERNAL_URL: process.env.HACK_AUTH_BROKER_INTERNAL_URL,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL =
    originalEnv.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL;
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL =
    originalEnv.NEXT_PUBLIC_HACK_AUTH_BROKER_URL;
  process.env.HACK_AUTH_BROKER_INTERNAL_URL =
    originalEnv.HACK_AUTH_BROKER_INTERNAL_URL;
  process.env.GITHUB_CLIENT_ID = originalEnv.GITHUB_CLIENT_ID;
  process.env.GITHUB_CLIENT_SECRET = originalEnv.GITHUB_CLIENT_SECRET;
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    originalEnv.BETTER_AUTH_TRUSTED_ORIGINS;
  globalThis.fetch = originalFetch;
});

test("sign-in route renders the shared provider contract and linked handoff copy", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.GITHUB_CLIENT_ID = "test-github-client";
  process.env.GITHUB_CLIENT_SECRET = "test-github-secret";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    "https://hack-cli.hack,https://hack-cli.hack.gy";
  setMockFetch(() =>
    Response.json({
      providers: [createBetterAuthProviderMetadata({ enabled: true })],
    })
  );

  const markup = renderToStaticMarkup(
    await AuthPage({
      searchParams: Promise.resolve({
        deviceCode: "device-123",
        flowId: "flow-123",
        redirect: "hack://auth/complete",
      }),
    })
  );

  expect(markup).toContain("Sign in to Hack");
  expect(markup).toContain("Linked browser handoff");
  expect(markup).toContain("Continue with GitHub");
  expect(markup).toContain(
    'href="/auth/account?flowId=flow-123&amp;deviceCode=device-123&amp;redirect=hack%3A%2F%2Fauth%2Fcomplete"'
  );
});

test("account route renders browser handoff status in apps/web", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.GITHUB_CLIENT_ID = "test-github-client";
  process.env.GITHUB_CLIENT_SECRET = "test-github-secret";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    "https://hack-cli.hack,https://hack-cli.hack.gy";
  setMockFetch(() =>
    Response.json({
      providers: [createBetterAuthProviderMetadata({ enabled: true })],
    })
  );

  const markup = renderToStaticMarkup(
    await AuthAccountPage({
      searchParams: Promise.resolve({
        deviceCode: "device-123",
        flowId: "flow-123",
        redirect: "hack://auth/complete",
      }),
    })
  );

  expect(markup).toContain("Finish your Hack browser handoff");
  expect(markup).toContain("Waiting for the broker session");
  expect(markup).toContain("Continue with GitHub");
  expect(markup).toContain("Auth broker");
  expect(markup).toContain(
    'href="/auth?flowId=flow-123&amp;deviceCode=device-123&amp;redirect=hack%3A%2F%2Fauth%2Fcomplete"'
  );
});

test("account entrypoint renders a ready return state for browser-owned redirects once the web session exists", () => {
  const markup = renderToStaticMarkup(
    <AuthEntrypoint
      appBaseUrl="https://hack-cli.hack"
      authBrokerBaseUrl="https://auth.hack-cli.hack"
      betterAuthEnabled
      betterAuthSource="broker"
      browserSessionAuthenticated
      mode="account"
      providers={[{ id: "github", label: "GitHub" }]}
      redirect="/account?org=hack"
      trustedOrigins={["https://hack-cli.hack"]}
    />
  );

  expect(markup).toContain("Browser handoff confirmed");
  expect(markup).toContain("Returning to Hack…");
  expect(markup).toContain(
    'href="/auth?redirect=https%3A%2F%2Fhack-cli.hack%2Faccount%3Forg%3Dhack"'
  );
});

test("sign-in route treats broker metadata as authoritative when Better Auth is disabled", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.GITHUB_CLIENT_ID = "stale-github-client";
  process.env.GITHUB_CLIENT_SECRET = "stale-github-secret";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    "https://hack-cli.hack,https://hack-cli-preview.vercel.app";
  setMockFetch(() =>
    Response.json({
      providers: [createBetterAuthProviderMetadata({ enabled: false })],
    })
  );

  const markup = renderToStaticMarkup(
    await AuthPage({
      searchParams: Promise.resolve({}),
    })
  );

  expect(markup).toContain("Better Auth is not active");
  expect(markup).not.toContain("Continue with GitHub");
});

test("social start rejects providers that the broker disabled", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";
  setMockFetch((input) => {
    const url = resolveFetchUrl(input);
    if (url === "https://auth.hack-cli.hack/v1/auth/providers") {
      return Response.json({
        providers: [createBetterAuthProviderMetadata({ enabled: false })],
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  const response = await startSocialSignIn(
    new Request("https://hack-cli.hack/api/auth/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
      }),
    }) as NextRequest
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: "provider_unavailable",
  });
});

test("social start strips redirects that are no longer trusted by broker metadata", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    "https://hack-cli.hack,https://hack-cli-preview.vercel.app";

  let signInPayload:
    | {
        readonly provider?: string;
        readonly callbackURL?: string;
      }
    | undefined;
  setMockFetch((input, init) => {
    const url = resolveFetchUrl(input);
    if (url === "https://auth.hack-cli.hack/v1/auth/providers") {
      return Response.json({
        providers: [createBetterAuthProviderMetadata({ enabled: true })],
      });
    }
    if (url === "https://auth.hack-cli.hack/api/auth/sign-in/social") {
      signInPayload = JSON.parse(String(init?.body)) as typeof signInPayload;
      return Response.json({
        url: signInPayload?.callbackURL,
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  const response = await startSocialSignIn(
    new Request("https://hack-cli.hack/api/auth/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "github",
        redirect: "https://hack-cli-preview.vercel.app/account",
      }),
    }) as NextRequest
  );

  expect(response.status).toBe(200);
  expect(signInPayload).toEqual({
    provider: "github",
    callbackURL:
      "https://auth.hack-cli.hack/auth/account?bridge=1&redirect=https%3A%2F%2Fhack-cli.hack%2Fauth%2Faccount",
  });
});

function createBetterAuthProviderMetadata(input: {
  readonly enabled: boolean;
}): BetterAuthProviderMetadata {
  return {
    id: "better-auth",
    enabled: input.enabled,
    mode: "session",
    basePath: "/api/auth",
    shellPath: "/auth",
    accountPath: "/auth/account",
    sessionStartPath: "/v1/auth/session/start",
    mePath: "/v1/auth/me",
    socialProviders: [{ id: "github", label: "GitHub" }],
    accountLinkingPolicy: {
      requireVerifiedEmail: true,
      allowDifferentEmails: false,
      trustedProviders: [],
    },
    trustedOrigins: ["https://hack-cli.hack"],
  };
}

function resolveFetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function setMockFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Response | Promise<Response>
) {
  globalThis.fetch = ((input, init) =>
    Promise.resolve(handler(input, init))) as typeof globalThis.fetch;
}
