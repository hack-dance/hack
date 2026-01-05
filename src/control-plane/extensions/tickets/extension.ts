import type { ExtensionDefinition } from "../types.ts"

export const TICKETS_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.tickets",
    version: "0.1.0",
    scopes: ["project"],
    cliNamespace: "tickets",
    summary: "Git-backed tickets and runs"
  },
  commands: []
}
