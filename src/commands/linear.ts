import { createRemovedSurfaceCommand } from "./removed-surface.ts";

export const linearCommand = createRemovedSurfaceCommand({
  name: "linear",
  summary: "Removed: Linear integration is no longer part of Hack v3",
  reason:
    "Hack v3 removed hosted planning and sync integrations to stay self-contained and local-first.",
  replacement:
    "Use repo-local tickets for optional in-repo tracking and keep Linear outside Hack.",
});
