import { expect, test } from "bun:test";

import {
  buildAccountControlPlanePath,
  loadAccountControlPlaneData,
  resolveAccountControlPlaneFeedback,
} from "../src/lib/account-control-plane";

test("account control plane data loads visible projects and selected access grants", async () => {
  const calls: Array<{
    readonly url: string;
    readonly authorization: string | null;
  }> = [];

  const data = await loadAccountControlPlaneData({
    authBrokerProxyBaseUrl: "https://auth.hack-cli.hack",
    token: "session-token",
    selectedProjectKey: "hack-cli",
    fetchImplementation: (input, init) => {
      const url = resolveFetchUrl(input);
      calls.push({
        url,
        authorization: readAuthorizationHeader(init),
      });
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs") {
        return Response.json({
          ok: true,
          organizations: [],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/invitations") {
        return Response.json({
          ok: true,
          invitations: [],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/projects") {
        return Response.json({
          ok: true,
          projects: [
            {
              id: "project_123",
              slug: "hack-cli",
              name: "Hack CLI",
              currentAccessRole: "owner",
              ownership: {
                mode: "shared",
                ownerType: "organization",
                ownerId: "org_123",
                ownerSlug: "hack",
                ownerName: "Hack Org",
                managedBy: "broker",
              },
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      if (
        url === "https://auth.hack-cli.hack/v1/auth/projects/hack-cli/access"
      ) {
        return Response.json({
          ok: true,
          access: [
            {
              id: "grant_123",
              scope: "team",
              role: "viewer",
              subjectId: "team_123",
              subjectSlug: "cli",
              subjectName: "CLI",
              organizationId: "org_123",
              teamId: "team_123",
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
      url: "https://auth.hack-cli.hack/v1/auth/projects",
    },
    {
      authorization: "Bearer session-token",
      url: "https://auth.hack-cli.hack/v1/auth/projects/hack-cli/access",
    },
  ]);
  expect(data.projects.map((project) => project.slug)).toEqual(["hack-cli"]);
  expect(data.selectedProjectVisible).toBe(true);
  expect(data.selectedProject?.slug).toBe("hack-cli");
  expect(data.selectedProjectAccess[0]).toMatchObject({
    id: "grant_123",
    scope: "team",
    role: "viewer",
    subjectSlug: "cli",
  });
});

test("account control plane data fails closed when the requested project is not visible", async () => {
  const calls: string[] = [];

  const data = await loadAccountControlPlaneData({
    authBrokerProxyBaseUrl: "https://auth.hack-cli.hack",
    token: "session-token",
    selectedProjectKey: "secret-project",
    fetchImplementation: (input) => {
      const url = resolveFetchUrl(input);
      calls.push(url);
      if (url === "https://auth.hack-cli.hack/v1/auth/orgs") {
        return Response.json({
          ok: true,
          organizations: [],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/invitations") {
        return Response.json({
          ok: true,
          invitations: [],
        });
      }
      if (url === "https://auth.hack-cli.hack/v1/auth/projects") {
        return Response.json({
          ok: true,
          projects: [
            {
              id: "project_123",
              slug: "hack-cli",
              name: "Hack CLI",
              currentAccessRole: "owner",
              ownership: {
                mode: "local",
                ownerType: "user",
                ownerId: null,
                ownerSlug: null,
                ownerName: null,
                managedBy: "local",
              },
              createdAt: "2026-03-25T00:00:00.000Z",
              updatedAt: "2026-03-25T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  });

  expect(calls).toEqual([
    "https://auth.hack-cli.hack/v1/auth/orgs",
    "https://auth.hack-cli.hack/v1/auth/invitations",
    "https://auth.hack-cli.hack/v1/auth/projects",
  ]);
  expect(data.selectedProjectVisible).toBe(false);
  expect(data.selectedProject).toBeNull();
  expect(data.selectedProjectAccess).toEqual([]);
});

test("project control plane feedback resolves project notices and hidden-project guidance", () => {
  expect(
    resolveAccountControlPlaneFeedback({
      notice: "project_registered",
    })
  ).toMatchObject({
    tone: "success",
    title: "Project registered",
  });

  expect(
    resolveAccountControlPlaneFeedback({
      error: "project_registration_conflict",
    })
  ).toMatchObject({
    tone: "danger",
    title: "Project ownership conflict",
  });

  expect(
    resolveAccountControlPlaneFeedback({
      error: "project_scope_forbidden",
    })
  ).toMatchObject({
    tone: "danger",
    title: "Active scope required",
  });

  expect(
    resolveAccountControlPlaneFeedback({
      requestedProjectKey: "secret-project",
      selectedProjectVisible: false,
    })
  ).toMatchObject({
    tone: "info",
    title: "Project not visible",
  });
});

test("project control plane paths stay internal while preserving project selection", () => {
  expect(
    buildAccountControlPlanePath({
      redirectTo: "/account?notice=old",
      org: "hack",
      team: "cli",
      project: "hack-cli",
      notice: "project_registered",
    })
  ).toBe(
    "/account?org=hack&team=cli&project=hack-cli&notice=project_registered"
  );

  expect(
    buildAccountControlPlanePath({
      redirectTo: "https://example.com/steal",
      project: "hack-cli",
      error: "project_registration_conflict",
    })
  ).toBe("/account?project=hack-cli&error=project_registration_conflict");
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
