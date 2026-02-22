import type { ExtensionDefinition } from "../types.ts";
import { GITHUB_COMMANDS } from "./commands.ts";

export const GITHUB_EXTENSION: ExtensionDefinition = {
  manifest: {
    id: "dance.hack.github",
    version: "0.1.0",
    scopes: ["global", "project"],
    cliNamespace: "github",
    summary: "GitHub App SCM integration for dispatch and PR automation",
  },
  commands: GITHUB_COMMANDS,
};
