import type { Metadata } from "next";

export const appMetadata: Metadata = {
  title: "Hack control plane",
  description:
    "An accessible browser shell for the optional Hack control plane.",
};

export const shellTitle = "Accessible control-plane shell";

export const shellSummary =
  "A calm browser-visible frame that keeps Hack's CLI-first workflow intact while future auth, admin, and integration slices land behind the same routed host.";

export const shellNavigationItems = [
  {
    href: "#overview",
    label: "Overview",
    description: "What the shell owns right now.",
  },
  {
    href: "#foundations",
    label: "Foundations",
    description: "Accessible patterns ready for later slices.",
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
    title: "Routed local host",
    description:
      "The shell lives on the Hack-managed host so later browser flows can reuse the same stable entrypoint.",
  },
  {
    title: "Neutral shared frame",
    description:
      "The layout leaves room for future auth, admin, and integration slices without claiming those flows today.",
  },
  {
    title: "Visible focus treatment",
    description:
      "Links, cards, and skip navigation keep strong focus rings for keyboard-only use.",
  },
] as const;

export const shellGuardrails = [
  "Browser-owned auth entrypoints remain quarantined for the dedicated auth handoff feature.",
  "Shared admin and integration flows stay broker-backed and CLI-accessible until their slices land.",
  "Reduced-motion support is treated as a contract, not a cosmetic follow-up.",
] as const;
