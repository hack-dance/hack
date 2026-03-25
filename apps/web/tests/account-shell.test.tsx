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
} as const satisfies AccountShellContext;

test("account shell renders the active user and org/team context", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={authenticatedContext}
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
});

test("account shell fails closed with a sign-in path when no active context is available", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell
      account={{ authenticated: false }}
      signInHref="/auth?redirect=%2Faccount"
    />
  );

  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain('href="/auth?redirect=%2Faccount"');
  expect(markup).not.toContain("Hack User");
});
