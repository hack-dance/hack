import { createRemovedSurfaceCommand } from "./removed-surface.ts";

export const teamCommand = createRemovedSurfaceCommand({
  name: "team",
  summary: "Removed: hosted team management is no longer part of Hack",
  reason:
    "Hack v3 removed broker-backed team and membership lifecycle management.",
  replacement:
    "Use repo-local ownership plus native collaboration tools outside Hack.",
});
