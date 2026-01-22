import type { ProjectContext } from "../../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
} from "../../lib/project.ts";
import { upsertProjectRegistration } from "../../lib/projects-registry.ts";
import type { Logger } from "../../ui/logger.ts";
import { logger as baseLogger } from "../../ui/logger.ts";
import { readControlPlaneConfig } from "../sdk/config.ts";
import { BUILTIN_EXTENSIONS } from "./builtins.ts";
import { ExtensionManager } from "./manager.ts";
import type { ExtensionCommandContext } from "./types.ts";

export type ExtensionManagerLoadResult = {
  readonly manager: ExtensionManager;
  readonly context: ExtensionCommandContext;
  readonly configError?: string;
  readonly warnings: readonly string[];
};

/**
 * Load the extension manager for CLI usage and resolve project context.
 *
 * @param opts.cwd - Current working directory for project discovery.
 * @param opts.logger - Optional logger override.
 * @returns Extension manager plus resolved command context.
 */
export async function loadExtensionManagerForCli(opts: {
  readonly cwd: string;
  readonly logger?: Logger;
}): Promise<ExtensionManagerLoadResult> {
  const logger = opts.logger ?? baseLogger;
  const project = await findProjectContext(opts.cwd);
  const configResult = await readControlPlaneConfig({
    projectDir: project?.projectDir,
  });
  const identity = await resolveProjectIdentity({ project });

  const manager = new ExtensionManager({
    config: configResult.config,
    logger,
  });

  for (const ext of BUILTIN_EXTENSIONS) {
    manager.registerExtension({ extension: ext });
  }

  const warnings = manager.getWarnings();

  return {
    manager,
    context: {
      cwd: opts.cwd,
      logger,
      project: project ?? undefined,
      projectId: identity.projectId ?? undefined,
      projectName: identity.projectName ?? undefined,
      controlPlaneConfig: configResult.config,
    },
    configError: configResult.parseError,
    warnings,
  };
}

async function resolveProjectIdentity(opts: {
  readonly project: ProjectContext | null;
}): Promise<{ readonly projectId?: string; readonly projectName?: string }> {
  if (!opts.project) {
    return {};
  }

  const cfg = await readProjectConfig(opts.project);
  const defaultName = defaultProjectSlugFromPath(opts.project.projectRoot);
  const projectName = (cfg.name ?? "").trim() || defaultName;

  const outcome = await upsertProjectRegistration({ project: opts.project });
  if (outcome.status === "conflict") {
    return { projectName };
  }

  return { projectId: outcome.project.id, projectName: outcome.project.name };
}
