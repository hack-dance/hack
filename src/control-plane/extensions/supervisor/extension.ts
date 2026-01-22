import type { ExtensionDefinition } from "../types.ts";
import { SUPERVISOR_COMMANDS } from "./commands.ts";

export const SUPERVISOR_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.supervisor",
    version: "0.1.0",
    scopes: ["global"],
    cliNamespace: "supervisor",
    summary: "Local job runtime and streaming",
  },
  commands: SUPERVISOR_COMMANDS,
};
