import type { Metadata } from "next";

export const appMetadata: Metadata = {
  title: "Hack control plane",
  description: "A signed-in browser shell for the optional Hack control plane.",
};

export const shellTitle = "Hack account shell";

export const shellSummary =
  "A calm signed-in shell that keeps the browser, broker current-user APIs, org admin flows, and CLI auth status aligned on the same Hack identity and active org/team context.";

export const shellNavigationItems = [
  {
    href: "#account-context",
    label: "Account context",
    description: "The active user, org, and team that Hack resolved.",
  },
  {
    href: "#organizations",
    label: "Organizations",
    description: "Create orgs and manage caller-scoped shared access.",
  },
  {
    href: "#teams",
    label: "Teams",
    description: "Manage explicit parent-org team scope and memberships.",
  },
  {
    href: "#projects",
    label: "Projects",
    description: "Register shared projects and manage explicit project access.",
  },
  {
    href: "#github",
    label: "GitHub",
    description: "Inspect routed GitHub readiness and repair guidance.",
  },
  {
    href: "#linear",
    label: "Linear",
    description:
      "Compare Hack-owned Linear access, local usability, and repo binding.",
  },
  {
    href: "#invitations",
    label: "Invitations",
    description: "Accept or decline pending invites for this account.",
  },
  {
    href: "#foundations",
    label: "Foundations",
    description: "How the signed-in shell preserves parity and accessibility.",
  },
  {
    href: "#guardrails",
    label: "Guardrails",
    description: "What stays intentionally out of scope today.",
  },
] as const;

export const shellPrinciples = [
  {
    title: "Keyboard ready",
    description:
      "Semantic landmarks, a skip link, and logical tab order ship first.",
  },
  {
    title: "Reduced motion safe",
    description:
      "Subtle transitions collapse when the browser requests reduced motion.",
  },
  {
    title: "CLI first",
    description:
      "Critical local workflows remain available even when the web app is unavailable.",
  },
] as const;

export const shellHighlights = [
  {
    title: "Context parity",
    description:
      "The shell renders the same signed-in identity and active org/team context that the broker and CLI already resolve.",
  },
  {
    title: "Deep-link continuity",
    description:
      "Browser-owned sign-in can return to a trusted in-app destination instead of dropping the user on a dead-end handoff page.",
  },
  {
    title: "Visible focus treatment",
    description:
      "Links, cards, and skip navigation keep strong focus rings for keyboard-only use.",
  },
] as const;

export const shellGuardrails = [
  "CLI auth remains optional and authoritative even when the browser shell is unavailable.",
  "Browser-owned sign-in continues to flow through the shared broker-backed auth/session APIs.",
  "Reduced-motion support and visible focus are treated as product contracts, not cosmetic follow-ups.",
] as const;
