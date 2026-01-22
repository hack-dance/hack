import type { ExtensionDefinition } from "../types.ts";
import { TAILSCALE_COMMANDS } from "./commands.ts";

export const TAILSCALE_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.tailscale",
    version: "0.1.0",
    scopes: ["global"],
    cliNamespace: "tailscale",
    summary: "Tailscale helper for gateway exposure",
  },
  commands: TAILSCALE_COMMANDS,
};
