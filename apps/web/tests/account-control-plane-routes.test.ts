import { afterEach, expect, test } from "bun:test";
import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import type { NextRequest } from "next/server";

import { POST as acceptInvitation } from "../src/app/api/control-plane/invitations/[inviteId]/accept/route";
import { POST as declineInvitation } from "../src/app/api/control-plane/invitations/[inviteId]/decline/route";
import { POST as inviteOrgMember } from "../src/app/api/control-plane/orgs/[org]/members/invite/route";
import { POST as removeOrgMember } from "../src/app/api/control-plane/orgs/[org]/members/remove/route";
import { POST as createOrganization } from "../src/app/api/control-plane/orgs/route";
import { POST as inviteTeamMember } from "../src/app/api/control-plane/teams/[team]/members/invite/route";
import { POST as removeTeamMember } from "../src/app/api/control-plane/teams/[team]/members/remove/route";
import { POST as createTeam } from "../src/app/api/control-plane/teams/route";

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

test("create organization route forwards the broker mutation and redirects to the selected org", async () => {
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
      organization: {
        slug: "hack",
      },
    });
  });

  const formData = new FormData();
  formData.set("slug", "hack");
  formData.set("name", "Hack");
  formData.set("redirectTo", "/account");

  const response = await createOrganization(
    new Request("https://hack-cli.hack/api/control-plane/orgs", {
      method: "POST",
      headers: {
        cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
      },
      body: formData,
    }) as NextRequest
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=hack&notice=org_created"
  );
  expect(String(authorization)).toBe("Bearer session-token");
  expect(body).toEqual({
    slug: "hack",
    name: "Hack",
  });
});

test("create organization route redirects to sign-in when the browser session cookie is missing", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  const formData = new FormData();
  formData.set("slug", "hack");
  formData.set("redirectTo", "/account?org=hack");

  const response = await createOrganization(
    new Request("https://hack-cli.hack/api/control-plane/orgs", {
      method: "POST",
      body: formData,
    }) as NextRequest
  );

  expect(response.headers.get("location")).toBe(
    "/auth?redirect=%2Faccount%3Forg%3Dhack"
  );
});

test("invite org member route keeps org scope and redirect context", async () => {
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
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack");

  const response = await inviteOrgMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/orgs/hack/members/invite",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ org: "hack" }) }
  );

  expect(requestUrl).toBe(
    "https://auth.hack-cli.hack/v1/auth/orgs/hack/members/invite"
  );
  expect(body).toEqual({
    target: "person@example.com",
  });
  expect(response.headers.get("location")).toBe(
    "/account?org=hack&notice=org_member_invited"
  );
});

test("remove org member route revokes pending invites and keeps org scope", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  let requestUrl = "";
  let body: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  setMockFetch((input, init) => {
    requestUrl = resolveFetchUrl(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = readAuthorizationHeader(init);
    return Response.json({
      ok: true,
      membership: {
        state: "removed",
        target: "person@example.com",
      },
    });
  });

  const formData = new FormData();
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack");

  const response = await removeOrgMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/orgs/hack/members/remove",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ org: "hack" }) }
  );

  expect(requestUrl).toBe(
    "https://auth.hack-cli.hack/v1/auth/orgs/hack/members/remove"
  );
  expect(String(authorization)).toBe("Bearer session-token");
  expect(body).toEqual({
    target: "person@example.com",
  });
  expect(response.headers.get("location")).toBe(
    "/account?org=hack&notice=org_member_removed"
  );
});

test("remove org member route reports broker failures through the account shell", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  setMockFetch(() =>
    Response.json(
      {
        ok: false,
      },
      { status: 409 }
    )
  );

  const formData = new FormData();
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack");

  const response = await removeOrgMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/orgs/hack/members/remove",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ org: "hack" }) }
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=hack&error=org_member_remove_failed"
  );
});

test("create team route forwards the broker mutation with explicit org scope", async () => {
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
      team: {
        slug: "cli",
      },
    });
  });

  const formData = new FormData();
  formData.set("org", "hack");
  formData.set("slug", "cli");
  formData.set("name", "CLI");
  formData.set("redirectTo", "/account?org=hack");

  const response = await createTeam(
    new Request("https://hack-cli.hack/api/control-plane/teams", {
      method: "POST",
      headers: {
        cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
      },
      body: formData,
    }) as NextRequest
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&notice=team_created"
  );
  expect(String(authorization)).toBe("Bearer session-token");
  expect(body).toEqual({
    org: "hack",
    slug: "cli",
    name: "CLI",
  });
});

test("invite team member route keeps explicit org and team scope", async () => {
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
  formData.set("org", "hack");
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack&team=cli");

  const response = await inviteTeamMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/teams/cli/members/invite",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ team: "cli" }) }
  );

  expect(requestUrl).toBe(
    "https://auth.hack-cli.hack/v1/auth/teams/cli/members/invite"
  );
  expect(body).toEqual({
    org: "hack",
    target: "person@example.com",
  });
  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&notice=team_member_invited"
  );
});

test("invite team member route reports parent-org membership requirements through the account shell", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  setMockFetch(() =>
    Response.json(
      {
        ok: false,
        error: "team_member_requires_active_org_membership",
      },
      { status: 409 }
    )
  );

  const formData = new FormData();
  formData.set("org", "hack");
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack&team=cli");

  const response = await inviteTeamMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/teams/cli/members/invite",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ team: "cli" }) }
  );

  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&error=team_member_requires_active_org_membership"
  );
});

test("remove team member route preserves explicit org and team selection", async () => {
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
  formData.set("org", "hack");
  formData.set("target", "person@example.com");
  formData.set("redirectTo", "/account?org=hack&team=cli");

  const response = await removeTeamMember(
    new Request(
      "https://hack-cli.hack/api/control-plane/teams/cli/members/remove",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: formData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ team: "cli" }) }
  );

  expect(requestUrl).toBe(
    "https://auth.hack-cli.hack/v1/auth/teams/cli/members/remove"
  );
  expect(body).toEqual({
    org: "hack",
    target: "person@example.com",
  });
  expect(response.headers.get("location")).toBe(
    "/account?org=hack&team=cli&notice=team_member_removed"
  );
});

test("invitation routes forward recipient actions back to the broker", async () => {
  process.env.NEXT_PUBLIC_HACK_WEB_APP_BASE_URL = "https://hack-cli.hack";
  process.env.NEXT_PUBLIC_HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_AUTH_BROKER_INTERNAL_URL = "https://auth.hack-cli.hack";

  const requests: string[] = [];
  setMockFetch((input) => {
    requests.push(resolveFetchUrl(input));
    return Response.json({ ok: true });
  });

  const acceptFormData = new FormData();
  acceptFormData.set("redirectTo", "/account");
  const acceptResponse = await acceptInvitation(
    new Request(
      "https://hack-cli.hack/api/control-plane/invitations/invite_123/accept",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: acceptFormData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ inviteId: "invite_123" }) }
  );

  const declineFormData = new FormData();
  declineFormData.set("redirectTo", "/account");
  const declineResponse = await declineInvitation(
    new Request(
      "https://hack-cli.hack/api/control-plane/invitations/invite_123/decline",
      {
        method: "POST",
        headers: {
          cookie: `${HACK_WEB_BROKER_SESSION_COOKIE_NAME}=session-token`,
        },
        body: declineFormData,
      }
    ) as NextRequest,
    { params: Promise.resolve({ inviteId: "invite_123" }) }
  );

  expect(requests).toEqual([
    "https://auth.hack-cli.hack/v1/auth/invitations/invite_123/accept",
    "https://auth.hack-cli.hack/v1/auth/invitations/invite_123/decline",
  ]);
  expect(acceptResponse.headers.get("location")).toBe(
    "/account?notice=invite_accepted"
  );
  expect(declineResponse.headers.get("location")).toBe(
    "/account?notice=invite_declined"
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
