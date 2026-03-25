import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import {
  appMetadata,
  shellNavigationItems,
  shellPrinciples,
} from "../src/lib/control-plane-shell";

const githubManagement = {
  extensionEnabled: true,
  selectedProfile: "default",
  selectedSource: "implicit_default",
  defaultProfile: "default",
  selectedMissing: false,
  mode: "token",
  authRef: "github.app.default",
  service: "hack-github-auth",
  tokenEnvFallback: "HACK_GITHUB_APP_TOKEN",
  apiBaseUrl: "https://api.github.com",
  tokenResolved: false,
  profiles: [],
  readiness: {
    ready: false,
    state: "needs_attention",
    summary: "GitHub needs repair before this repo can rely on it.",
    detail: "Missing GitHub token for the selected profile.",
    issues: ["missing_token"],
    installation: {
      required: false,
      state: "not_required",
    },
    repairGuidance: [
      {
        issue: "missing_token",
        title: "Restore usable GitHub auth",
        action: "Run hack x github connect --profile default.",
      },
    ],
  },
  statusCommand: "./dist/hack x github status --json",
} as const;

test("control plane shell metadata describes the accessible foundation", () => {
  expect(appMetadata.title).toBe("Hack control plane");
  expect(appMetadata.description).toContain("signed-in browser shell");
  expect(shellNavigationItems.map(({ href }) => href)).toEqual([
    "#account-context",
    "#organizations",
    "#teams",
    "#projects",
    "#github",
    "#invitations",
    "#foundations",
    "#guardrails",
  ]);
  expect(shellPrinciples.map(({ title }) => title)).toEqual([
    "Keyboard ready",
    "Reduced motion safe",
    "CLI first",
  ]);
});

test("control plane shell renders landmarks and keyboard navigation affordances", () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell githubManagement={githubManagement} returnToPath="/" />
  );

  expect(markup).toContain("Skip to main content");
  expect(markup).toContain('href="#main-content"');
  expect(markup).toContain('aria-label="Control plane sections"');
  expect(markup).toContain('id="main-content"');
  expect(markup).toContain("<aside");
  expect(markup).toContain("Keyboard ready");
  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain("Organizations");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Projects");
  expect(markup).toContain("GitHub");
  expect(markup).toContain("Invitations");
});

test("control plane shell keeps visible focus and reduced-motion contracts explicit", async () => {
  const markup = renderToStaticMarkup(
    <ControlPlaneShell githubManagement={githubManagement} returnToPath="/" />
  );
  const globalCss = await Bun.file(
    new URL("../app/globals.css", import.meta.url)
  ).text();

  expect(markup).toContain("focus-visible:outline");
  expect(markup).toContain("motion-reduce:transition-none");
  expect(globalCss).toContain("prefers-reduced-motion: reduce");
  expect(globalCss).toContain("scroll-behavior: auto");
});

test("root route keeps the shared shell wired to the home page", async () => {
  const pageSource = await Bun.file(
    new URL("../app/page.tsx", import.meta.url)
  ).text();

  expect(pageSource).toContain("AccountShellPage");
});
