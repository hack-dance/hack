import { readProjectsRegistry } from "../../../lib/projects-registry.ts"
import { readControlPlaneConfig } from "../../sdk/config.ts"

import type { RegisteredProject } from "../../../lib/projects-registry.ts"
import type { ControlPlaneConfig } from "../../sdk/config.ts"

export type GatewayConfigSource = {
  readonly projectId: string
  readonly projectName: string
  readonly projectDir: string
}

export type GatewayConfigResolution = {
  readonly config: ControlPlaneConfig["gateway"]
  readonly source?: GatewayConfigSource
  readonly warnings: readonly string[]
}

/**
 * Resolve gateway config by scanning registered projects for an enabled gateway.
 *
 * @returns Gateway config and optional source project metadata.
 */
export async function resolveGatewayConfig(): Promise<GatewayConfigResolution> {
  const registry = await readProjectsRegistry()
  const projects = [...registry.projects].sort((a, b) => {
    const aTs = resolveProjectTimestamp({ project: a })
    const bTs = resolveProjectTimestamp({ project: b })
    return bTs - aTs
  })

  const warnings: string[] = []
  const fallback = (await readControlPlaneConfig({})).config.gateway

  for (const project of projects) {
    const configResult = await readControlPlaneConfig({ projectDir: project.projectDir })
    if (configResult.parseError) {
      warnings.push(
        `Gateway config parse error for ${project.name}: ${configResult.parseError}`
      )
    }

    const gatewayEnabled = configResult.config.gateway.enabled === true
    if (gatewayEnabled) {
      return {
        config: configResult.config.gateway,
        source: {
          projectId: project.id,
          projectName: project.name,
          projectDir: project.projectDir
        },
        warnings
      }
    }
  }

  return { config: fallback, warnings }
}

function resolveProjectTimestamp(opts: { readonly project: RegisteredProject }): number {
  const raw = opts.project.lastSeenAt ?? opts.project.createdAt
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}
