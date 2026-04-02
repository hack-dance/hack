import { afterEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { GET as signOutRoute } from "../src/app/api/auth/sign-out/route";
import { SidebarProvider } from "../src/components/ui/sidebar";
import {
  accountNavigationItems,
  resolveAccountPageDescription,
  resolveAccountPageTitle,
} from "../src/lib/account-navigation";
import type { AccountShellContext } from "../src/lib/account-shell";

const authenticatedAccount = {
  authenticated: true,
  accessControlMode: "better_auth_team_owned",
  user: {
    id: "user_123",
    email: "hack@example.com",
    name: "Hack User",
    image: "https://avatars.example.com/hack-user.png",
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
  requestedOrganizationKey: null,
  selectedOrganizationVisible: true,
  requestedTeamKey: null,
  selectedTeamVisible: true,
  requestedProjectKey: null,
  selectedProjectVisible: true,
  organizations: [
    {
      id: "org_123",
      slug: "hack",
      name: "Hack Org",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    },
  ],
  selectedOrganization: {
    id: "org_123",
    slug: "hack",
    name: "Hack Org",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  },
  selectedOrganizationMemberships: [],
  teams: [],
  selectedTeam: null,
  selectedTeamMemberships: [],
  incomingInvitations: [],
  projects: [],
  selectedProject: null,
  selectedProjectAccess: [],
} as const satisfies AccountShellContext;

afterEach(() => {
  mock.restore();
});

test("account navigation exposes the new primary workspace areas", () => {
  expect(accountNavigationItems.map((item) => item.title)).toEqual([
    "Projects",
    "Organizations",
    "Teams",
    "Integrations",
    "Secrets",
    "Tickets",
  ]);
  expect(resolveAccountPageTitle({ pathname: "/account/integrations" })).toBe(
    "Integrations"
  );
  expect(resolveAccountPageDescription({ pathname: "/account" })).toContain(
    "organization"
  );
});

test("sign-out route clears the shared browser session cookie", async () => {
  const response = await signOutRoute(
    new NextRequest(
      "https://hack-cli.hack.gy/api/auth/sign-out?redirect=%2Fauth"
    )
  );

  expect(response.headers.get("location")).toBe(
    "https://hack-cli.hack.gy/auth"
  );
  expect(response.headers.get("set-cookie")).toContain(
    "hack_web_broker_session="
  );
});

test("app sidebar renders the new navigation and org switcher trigger", async () => {
  mock.module("next/navigation", () => ({
    usePathname: () => "/account/projects",
    useSearchParams: () => new URLSearchParams("org=hack"),
  }));

  const { AppSidebar } = await import("../src/components/app-sidebar");
  const markup = renderToStaticMarkup(
    <SidebarProvider>
      <AppSidebar account={authenticatedAccount} />
    </SidebarProvider>
  );

  expect(markup).toContain("Projects");
  expect(markup).toContain("Organizations");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Integrations");
  expect(markup).toContain("Secrets");
  expect(markup).toContain("Tickets");
  expect(markup).toContain("Organization");
  expect(markup).toContain("Hack Org");
  expect(markup).toContain("group-data-[collapsible=icon]:size-8");
});

test("app navbar shows the signed-in user and subroute breadcrumb", async () => {
  mock.module("next/navigation", () => ({
    usePathname: () => "/account/integrations",
  }));

  const { AppNavbar } = await import("../src/components/app-navbar");
  const markup = renderToStaticMarkup(
    <SidebarProvider>
      <AppNavbar account={authenticatedAccount} />
    </SidebarProvider>
  );

  expect(markup).toContain("Account");
  expect(markup).toContain("Integrations");
  expect(markup).toContain("Open user menu for Hack User");
  expect(markup).not.toContain("Shared repos and current project access.");
});
