import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import ControlPlaneShell from "../src/components/control-plane-shell";
import {
  appMetadata,
  shellNavigationItems,
  shellPrinciples,
} from "../src/lib/control-plane-shell";

test("control plane shell metadata describes the accessible foundation", () => {
  expect(appMetadata.title).toBe("Hack control plane");
  expect(appMetadata.description).toContain("signed-in browser shell");
  expect(shellNavigationItems.map(({ href }) => href)).toEqual([
    "#account-context",
    "#organizations",
    "#teams",
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
  const markup = renderToStaticMarkup(<ControlPlaneShell returnToPath="/" />);

  expect(markup).toContain("Skip to main content");
  expect(markup).toContain('href="#main-content"');
  expect(markup).toContain('aria-label="Control plane sections"');
  expect(markup).toContain('id="main-content"');
  expect(markup).toContain("<aside");
  expect(markup).toContain("Keyboard ready");
  expect(markup).toContain("Sign in to load your Hack account context");
  expect(markup).toContain("Organizations");
  expect(markup).toContain("Teams");
  expect(markup).toContain("Invitations");
});

test("control plane shell keeps visible focus and reduced-motion contracts explicit", async () => {
  const markup = renderToStaticMarkup(<ControlPlaneShell returnToPath="/" />);
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
