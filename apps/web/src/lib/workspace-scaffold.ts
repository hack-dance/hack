import type { Metadata } from "next";

export const appMetadata: Metadata = {
  title: "Hack control plane",
  description:
    "Minimal workspace scaffold for the optional Hack control plane.",
};

export const scaffoldTitle = "Workspace scaffold";

export const scaffoldSummary =
  "CLI-first workflows stay available while the optional web control plane lands in focused slices.";

export const scaffoldMilestones = [
  {
    title: "Workspace package",
    description:
      "Bun and Turbo now discover apps/web as a first-class workspace package.",
  },
  {
    title: "Local runtime wiring",
    description:
      "Hack-managed routing and health checks will land in the next runtime-owned slice.",
  },
  {
    title: "Browser auth handoff",
    description:
      "Browser-owned sign-in and account routes stay quarantined until their dedicated feature.",
  },
] as const;
