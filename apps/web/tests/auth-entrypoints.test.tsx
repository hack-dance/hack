import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import AuthAccountPage from "../app/auth/account/page";
import AuthPage from "../app/auth/page";

const originalEnv = {
  NEXT_PUBLIC_HACK_WEB_APP_BASE_URL:
    process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL,
  NEXT_PUBLIC_HACK_AUTH_BROKER_URL:
    process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
};

afterEach(() => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL =
    originalEnv.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL;
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL =
    originalEnv.NEXT_PUBLIC_HACK_AUTH_BROKER_URL;
  process.env.GITHUB_CLIENT_ID = originalEnv.GITHUB_CLIENT_ID;
  process.env.GITHUB_CLIENT_SECRET = originalEnv.GITHUB_CLIENT_SECRET;
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    originalEnv.BETTER_AUTH_TRUSTED_ORIGINS;
});

test("sign-in route renders the shared provider contract and linked handoff copy", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.GITHUB_CLIENT_ID = "test-github-client";
  process.env.GITHUB_CLIENT_SECRET = "test-github-secret";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS =
    "https://hack-cli.hack,https://hack-cli.hack.gy";

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
  expect(markup).toContain("Open the broker backend");
  expect(markup).toContain(
    'href="/auth?flowId=flow-123&amp;deviceCode=device-123&amp;redirect=hack%3A%2F%2Fauth%2Fcomplete"'
  );
});
