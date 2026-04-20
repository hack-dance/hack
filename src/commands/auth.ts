import { createRemovedSurfaceCommand } from "./removed-surface.ts";

export const authCommand = createRemovedSurfaceCommand({
  name: "auth",
  summary:
    "Removed: Hack account sign-in no longer ships with the local-first CLI",
  reason:
    "Hack no longer ships a centralized auth broker or hosted account surface.",
  replacement:
    "Local workflows no longer require Hack account sign-in. Use local project ownership, tickets, env, and sessions directly.",
});
