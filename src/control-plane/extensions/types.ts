import type { ProjectContext } from "../../lib/project.ts";
import type { Logger } from "../../ui/logger.ts";
import type { ControlPlaneConfig } from "../sdk/config.ts";

export type ExtensionScope = "global" | "project";

export type ExtensionManifest = {
  readonly id: string;
  readonly version: string;
  readonly scopes: readonly ExtensionScope[];
  readonly cliNamespace: string;
  readonly summary?: string;
};

export type ExtensionCommandContext = {
  readonly cwd: string;
  readonly logger: Logger;
  readonly project?: ProjectContext;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly controlPlaneConfig: ControlPlaneConfig;
};

export type ExtensionCommand = {
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly scope: ExtensionScope;
  readonly handler: (input: {
    readonly ctx: ExtensionCommandContext;
    readonly args: readonly string[];
  }) => Promise<number>;
};

export type ExtensionDefinition = {
  readonly manifest: ExtensionManifest;
  readonly commands: readonly ExtensionCommand[];
};

export type ResolvedExtension = {
  readonly manifest: ExtensionManifest;
  readonly commands: readonly ExtensionCommand[];
  readonly namespace: string;
  readonly enabled: boolean;
};

export type ExtensionCommandInfo = {
  readonly name: string;
  readonly summary: string;
  readonly commandId: string;
};
