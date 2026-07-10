import type { ExtensionDefinition } from "../types.ts";
import { TICKETS_COMMANDS } from "./commands.ts";

export const TICKETS_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.tickets",
    version: "0.1.0",
    scopes: ["project"],
    cliNamespace: "tickets",
    summary: "Deprecated git-backed Tickets compatibility surface",
  },
  commands: TICKETS_COMMANDS,
};
