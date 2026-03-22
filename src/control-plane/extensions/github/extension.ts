import type { ExtensionDefinition } from "../types.ts";
import { GITHUB_COMMANDS } from "./commands.ts";

export const GITHUB_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.github",
    version: "0.1.0",
    scopes: ["global", "project"],
    cliNamespace: "github",
    summary: "Optional GitHub capability for PR automation and private repo bootstrap",
  },
  commands: GITHUB_COMMANDS,
};
