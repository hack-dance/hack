import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import type { AccountShellContext } from "../src/lib/account-shell";

const authenticatedContext = {
  authenticated: true,
  accessControlMode: "better_auth_team_owned",
  user: {
    id: "user_123",
    email: "hack@example.com",
    name: "Hack User",
  },
  activeOrganization: {
    id: "org_123",
    name: "Hack Org",
  },
  activeTeam: {
    id: "team_123",
    name: "Infra",
  },
  shellPath: "/auth",
  accountPath: "/auth/account",
  requestedOrganizationKey: "hack-org",
  requestedTeamKey: "infra",
  selectedOrganizationVisible: true,
  selectedTeamVisible: true,
  organizations: [
    {
      id: "org_123",
      slug: "hack-org",
      name: "Hack Org",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  teams: [
    {
      id: "team_123",
      slug: "infra",
      name: "Infra",
      organizationId: "org_123",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedTeam: {
    id: "team_123",
    slug: "infra",
    name: "Infra",
    organizationId: "org_123",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedOrganization: {
    id: "org_123",
    slug: "hack-org",
    name: "Hack Org",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedOrganizationMemberships: [
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
      email: "person@example.com",
      target: "person@example.com",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedTeamMemberships: [
    {
      id: "membership_789",
      scope: "team",
      state: "active",
      organizationId: "org_123",
      teamId: "team_123",
      userId: "user_123",
      email: "hack@example.com",
      target: "user_123",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
    {
      id: "membership_790",
      scope: "team",
      state: "active",
      organizationId: "org_123",
      teamId: "team_123",
      userId: "user_456",
      email: "person@example.com",
      target: "user_456",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  incomingInvitations: [
    {
      id: "invite_123",
      scope: "organization",
      organizationId: "org_789",
      teamId: null,
      email: "invitee@example.com",
      status: "pending",
      teamTargets: [],
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
} as const satisfies AccountShellContext;

test("account shell renders the active user, org admin controls, and invite actions", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={authenticatedContext}
      feedback={{
        tone: "success",
        title: "Organization created",
        body: "Hack created the org and made you the initial active member.",
      }}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Signed in context");
  expect(markup).toContain("Hack User");
  expect(markup).toContain("hack@example.com");
  expect(markup).toContain("Hack Org");
  expect(markup).toContain("Infra");
  expect(markup).toContain("better_auth_team_owned");
  expect(markup).toContain("hack auth status --json");
  expect(markup).toContain("Visible organizations");
  expect(markup).toContain("Create organization");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Create team");
  expect(markup).toContain("Visible teams");
  expect(markup).toContain("Members keep their parent organization access");
  expect(markup).toContain("person@example.com");
  expect(markup).toContain("Pending recipient action");
  expect(markup).toContain("Accept invite");
  expect(markup).toContain("Organization created");
});

test("account shell fails closed with a sign-in path when no active context is available", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={{ authenticated: false }}
      returnToPath="/account"
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain('href="/auth?redirect=%2Faccount"');
  expect(markup).not.toContain("Hack User");
});
