import type { ExtensionDefinition } from "../types.ts";
import { CLOUDFLARE_COMMANDS } from "./commands.ts";

export const CLOUDFLARE_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.cloudflare",
    version: "0.1.0",
    scopes: ["global"],
    cliNamespace: "cloudflare",
    summary: "Cloudflare tunnel helper for gateway exposure",
  },
  commands: CLOUDFLARE_COMMANDS,
};
