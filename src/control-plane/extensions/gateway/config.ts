import { resolve } from "node:path";
import { PROJECT_CONFIG_FILENAME } from "../../../constants.ts";
import { readTextFile } from "../../../lib/fs.ts";
import { isRecord } from "../../../lib/guards.ts";
import type { RegisteredProject } from "../../../lib/projects-registry.ts";
import { readProjectsRegistry } from "../../../lib/projects-registry.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";
import { readControlPlaneConfig } from "../../sdk/config.ts";

export type GatewayProject = {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectDir: string;
};

export type GatewayConfigResolution = {
  readonly config: ControlPlaneConfig["gateway"];
  readonly enabledProjects: readonly GatewayProject[];
  readonly warnings: readonly string[];
};

/**
 * Resolve gateway config from global settings and project opt-in flags.
 *
 * @returns Gateway config and enabled project metadata.
 */
export async function resolveGatewayConfig(): Promise<GatewayConfigResolution> {
  const registry = await readProjectsRegistry();
  const projects = [...registry.projects].sort((a, b) => {
    const aTs = resolveProjectTimestamp({ project: a });
    const bTs = resolveProjectTimestamp({ project: b });
    return bTs - aTs;
  });

  const warnings: string[] = [];
  const globalResult = await readControlPlaneConfig({});
  const globalGateway = globalResult.config.gateway;
  if (globalResult.parseError) {
    warnings.push(
      `Global controlPlane config error: ${globalResult.parseError}`
    );
  }

  const enabledProjects: GatewayProject[] = [];
  for (const project of projects) {
    const projectInfo = await readProjectGatewayConfig({ project });
    if (projectInfo.parseError) {
      warnings.push(
        `Gateway config parse error for ${project.name}: ${projectInfo.parseError}`
      );
    }
    for (const warning of projectInfo.warnings) {
      warnings.push(warning);
    }
    if (!projectInfo.enabled) {
      continue;
    }
    enabledProjects.push({
      projectId: project.id,
      projectName: project.name,
      projectDir: project.projectDir,
    });
  }

  return {
    config: { ...globalGateway, enabled: enabledProjects.length > 0 },
    enabledProjects,
    warnings,
  };
}

type ProjectGatewayRead = {
  readonly enabled: boolean;
  readonly warnings: readonly string[];
  readonly parseError?: string;
};

async function readProjectGatewayConfig(opts: {
  readonly project: RegisteredProject;
}): Promise<ProjectGatewayRead> {
  const path = resolve(opts.project.projectDir, PROJECT_CONFIG_FILENAME);
  const text = await readTextFile(path);
  if (!text) {
    return { enabled: false, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return { enabled: false, warnings: [], parseError: message };
  }

  if (!isRecord(parsed)) {
    return { enabled: false, warnings: [] };
  }

  const controlPlane = parsed.controlPlane;
  if (!isRecord(controlPlane)) {
    return { enabled: false, warnings: [] };
  }

  const gateway = controlPlane.gateway;
  if (!isRecord(gateway)) {
    return { enabled: false, warnings: [] };
  }

  const enabled = gateway.enabled === true;
  const warnings: string[] = [];
  if ("allowWrites" in gateway) {
    warnings.push(
      `Project ${opts.project.name} sets controlPlane.gateway.allowWrites in ${path}. This is global-only and will be ignored.`
    );
  }
  if ("bind" in gateway) {
    warnings.push(
      `Project ${opts.project.name} sets controlPlane.gateway.bind in ${path}. This is global-only and will be ignored.`
    );
  }
  if ("port" in gateway) {
    warnings.push(
      `Project ${opts.project.name} sets controlPlane.gateway.port in ${path}. This is global-only and will be ignored.`
    );
  }

  return { enabled, warnings };
}

function resolveProjectTimestamp(opts: {
  readonly project: RegisteredProject;
}): number {
  const raw = opts.project.lastSeenAt ?? opts.project.createdAt;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
