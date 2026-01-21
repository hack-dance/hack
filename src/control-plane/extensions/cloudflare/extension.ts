import { CLOUDFLARE_COMMANDS } from "./commands.ts"

import type { ExtensionDefinition } from "../types.ts"

export const CLOUDFLARE_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.cloudflare",
    version: "0.1.0",
    scopes: ["global"],
    cliNamespace: "cloudflare",
    summary: "Cloudflare tunnel helper for gateway exposure"
  },
  commands: CLOUDFLARE_COMMANDS
}
