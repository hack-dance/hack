import { GATEWAY_COMMANDS } from "./commands.ts"

import type { ExtensionDefinition } from "../types.ts"

export const GATEWAY_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.gateway",
    version: "0.1.0",
    scopes: ["global"],
    cliNamespace: "gateway",
    summary: "Remote access gateway"
  },
  commands: GATEWAY_COMMANDS
}
