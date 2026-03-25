import { expect, test } from "bun:test";

import {
  buildAccountControlPlanePath,
  loadAccountControlPlaneData,
  resolveAccountControlPlaneFeedback,
} from "../src/lib/account-control-plane";

test("account control plane data loads visible org detail and incoming invitations", async () => {
  const calls: Array<{
    readonly url: string;
    readonly authorization: string | null;
  }> = [];

  const data = await loadAccountControlPlaneData({
    authBrokerProxyBaseUrl: "https://auth.hack-cli.hack",
    token: "session-token",
    selectedOrganizationKey: "hack",
    fetchImplementation: (input, init) => {
      const url = resolveFetchUrl(input);
      calls.push({
        url,
        authorization: readAuthorizationHeader(init),
      });
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs") {
        return Response.json({
          ok: true,
          organizations: [
            {
              id: "org_123",
              slug: "hack",
              name: "Hack Org",
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
            {
              id: "org_456",
              slug: "ops",
              name: "Ops",
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/invitations") {
        return Response.json({
          ok: true,
          invitations: [
            {
              id: "invite_123",
              scope: "organization",
              email: "member@example.com",
              status: "pending",
              organizationId: "org_789",
              teamId: null,
              teamTargets: [],
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs/hack") {
        return Response.json({
          ok: true,
          organization: {
            id: "org_123",
            slug: "hack",
            name: "Hack Org",
            createdAt: "2026-03-25T00:00:00.000Z",
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs/hack/members") {
        return Response.json({
          ok: true,
          memberships: [
            {
              id: "membership_123",
              scope: "organization",
              state: "active",
              organizationId: "org_123",
              teamId: null,
              userId: "user_123",
              email: "hack@example.com",
              target: "user_123",
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
            {
              id: "membership_456",
              scope: "organization",
              state: "pending",
              organizationId: "org_123",
              teamId: null,
              userId: null,
              email: "member@example.com",
              target: "member@example.com",
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  });

  expect(
    calls.map(({ authorization, url }) => ({
      authorization,
      url,
    }))
  ).toEqual([
    {
      authorization: "Bearer session-token",
      url: "https://auth.hack-cli.hack/v1/auth/orgs",
    },
    {
      authorization: "Bearer session-token",
      url: "https://auth.hack-cli.hack/v1/auth/invitations",
    },
    {
      authorization: "Bearer session-token",
      url: "https://auth.hack-cli.hack/v1/auth/orgs/hack",
    },
    {
      authorization: "Bearer session-token",
      url: "https://auth.hack-cli.hack/v1/auth/orgs/hack/members",
    },
  ]);
  expect(data.organizations.map((organization) => organization.slug)).toEqual([
    "hack",
    "ops",
  ]);
  expect(data.selectedOrganizationVisible).toBe(true);
  expect(data.selectedOrganization?.slug).toBe("hack");
  expect(data.selectedOrganizationMemberships).toHaveLength(2);
  expect(data.incomingInvitations[0]?.id).toBe("invite_123");
});

test("account control plane data fails closed when the requested org is not visible", async () => {
  const calls: string[] = [];

  const data = await loadAccountControlPlaneData({
    authBrokerProxyBaseUrl: "https://auth.hack-cli.hack",
    token: "session-token",
    selectedOrganizationKey: "secret-org",
    fetchImplementation: (input) => {
      const url = resolveFetchUrl(input);
      calls.push(url);
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs") {
        return Response.json({
          ok: true,
          organizations: [
            {
              id: "org_123",
              slug: "hack",
              name: "Hack Org",
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/invitations") {
        return Response.json({
          ok: true,
          invitations: [],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  });

  expect(calls).toEqual([
    "https://auth.hack-cli.hack/v1/auth/orgs",
    "https://auth.hack-cli.hack/v1/auth/invitations",
  ]);
  expect(data.selectedOrganizationVisible).toBe(false);
  expect(data.selectedOrganization).toBeNull();
  expect(data.selectedOrganizationMemberships).toEqual([]);
});

test("account control plane feedback resolves success and scoped visibility messages", () => {
  expect(
    resolveAccountControlPlaneFeedback({
      notice: "org_created",
    })
  ).toMatchObject({
    tone: "success",
    title: "Organization created",
  });

  expect(
    resolveAccountControlPlaneFeedback({
      requestedOrganizationKey: "secret-org",
      selectedOrganizationVisible: false,
    })
  ).toMatchObject({
    tone: "info",
    title: "Organization not visible",
  });
});

test("account control plane paths stay internal while preserving org selection", () => {
  expect(
    buildAccountControlPlanePath({
      redirectTo: "/account?notice=old",
      notice: "org_created",
      org: "hack",
    })
  ).toBe("/account?org=hack&notice=org_created");

  expect(
    buildAccountControlPlanePath({
      redirectTo: "https://example.com/steal",
      error: "auth_required",
    })
  ).toBe("/account?error=auth_required");
});

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
