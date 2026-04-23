import { createRemovedSurfaceCommand } from "./removed-surface.ts";

export const orgCommand = createRemovedSurfaceCommand({
  name: "org",
  summary: "Removed: hosted organization management is no longer part of Hack",
  reason:
    "Hack v3 dropped centralized org and membership administration with the broker-backed control plane.",
  replacement:
    "Keep project ownership local and use native git collaboration plus repo-local tickets instead.",
});
