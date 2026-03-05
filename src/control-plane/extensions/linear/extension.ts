import type { ExtensionDefinition } from "../types.ts";
import { LINEAR_COMMANDS } from "./commands.ts";

export const LINEAR_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.linear",
    version: "0.1.0",
    scopes: ["global", "project"],
    cliNamespace: "linear",
    summary: "Linear OAuth and issue sync for hack tickets",
  },
  commands: LINEAR_COMMANDS,
};
