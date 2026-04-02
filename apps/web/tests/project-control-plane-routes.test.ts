import { afterEach, expect, test } from "bun:test";
import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import type { NextRequest } from "next/server";

import { POST as grantProjectAccess } from "../src/app/api/control-plane/projects/[project]/access/grant/route";
import { POST as revokeProjectAccess } from "../src/app/api/control-plane/projects/[project]/access/revoke/route";
import { POST as registerProject } from "../src/app/api/control-plane/projects/route";

const originalFetch = globalThis.fetch;
const originalEnv = {
  NEXT_PUBLIC_HACK_WEB_APP_BASE_URL:
    process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL,
  NEXT_PUBLIC_HACK_AUTH_BROKER_URL:
    process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL,
  HACK_AUTH_BROKER_INTERNAL_URL: process.env.HACK_AUTH_BROKER_INTERNAL_URL,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL =
    originalEnv.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL;
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL =
    originalEnv.NEXT_PUBLIC_HACK_AUTH_BROKER_URL;
  process.env.HACK_AUTH_BROKER_INTERNAL_URL =
    originalEnv.HACK_AUTH_BROKER_INTERNAL_URL;
});

test("register project route forwards shared ownership payload and redirects to the selected project", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  let body: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  setMockFetch((_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = readAuthorizationHeader(init);
    return Response.json({
      ok: true,
      status: "created",
      project: {
        slug: "hack-cli",
      },
    });
  });

  const formData = new FormData();
  formData.set("slug", "hack-cli");
  formData.set("name", "Hack CLI");
  formData.set("mode", "team");
  formData.set("org", "hack");
  formData.set("team", "cli");
  formData.set("redirectTo", "/account?org=hack&team=cli");

  const response = await registerProject(
    new Request("https://hack-cli.hack/api/control-plane/projects", {
      method: "POST",
      headers: {
        cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
      },
      body: formData,
    }) as NextRequest
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&project=hack-cli&notice=project_registered"
  );
  expect(String(authorization)).toBe("Bearer session-token");
  expect(body).toEqual({
    slug: "hack-cli",
    name: "Hack CLI",
    mode: "team",
    org: "hack",
    team: "cli",
  });
});

test("grant project access route preserves project and scope context", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  let requestUrl = "";
  let body: Record<string, unknown> | undefined;
  setMockFetch((input, init) => {
    requestUrl = resolveFetchUrl(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  });

  const formData = new FormData();
  formData.set("scope", "organization");
  formData.set("role", "viewer");
  formData.set("org", "hack");
  formData.set("redirectTo", "/account?org=hack&team=cli&project=hack-cli");

  const response = await grantProjectAccess(
    new Request(
      "https://hack-cli.hack/api/control-plane/projects/hack-cli/access/grant",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ project: "hack-cli" }) }
  );

  expect(requestUrl).toBe(
    "https://auth.hack-cli.hack/v1/auth/projects/hack-cli/access/grant"
  );
  expect(body).toEqual({
    scope: "organization",
    role: "viewer",
    org: "hack",
  });
  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&project=hack-cli&notice=project_access_granted"
  );
});

test("revoke project access route reports broker failures through the account shell", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  setMockFetch(() =>
    Response.json(
      {
        ok: false,
        error: "project_access_revoke_failed",
      },
      { status: 409 }
    )
  );

  const formData = new FormData();
  formData.set("grantId", "grant_123");
  formData.set("redirectTo", "/account?project=hack-cli");

  const response = await revokeProjectAccess(
    new Request(
      "https://hack-cli.hack/api/control-plane/projects/hack-cli/access/revoke",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ project: "hack-cli" }) }
  );

  expect(response.headers.get("location")).toBe(
    "/account?project=hack-cli&error=project_access_revoke_failed"
  );
});

test("register project route preserves scoped selection when the broker rejects the active org or team context", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  setMockFetch(() =>
    Response.json(
      {
        ok: false,
        error: "project_scope_forbidden",
      },
      { status: 403 }
    )
  );

  const formData = new FormData();
  formData.set("slug", "ops-console");
  formData.set("name", "Ops Console");
  formData.set("mode", "organization");
  formData.set("org", "ops");
  formData.set("redirectTo", "/account?org=hack&team=cli");

  const response = await registerProject(
    new Request("https://hack-cli.hack/api/control-plane/projects", {
      method: "POST",
      headers: {
        cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
      },
      body: formData,
    }) as NextRequest
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=ops&team=cli&project=ops-console&error=project_scope_forbidden"
  );
});

function setMockFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Response | Promise<Response>
) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      handler(input, init)
    )) as unknown as typeof globalThis.fetch;
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

function readAuthorizationHeader(init?: RequestInit): string | null {
  if (init?.headers instanceof Headers) {
    return init.headers.get("authorization");
  }
  if (init?.headers && "authorization" in init.headers) {
    return String(init.headers.authorization);
  }
  return null;
}
