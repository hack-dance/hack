import { autoRegisterRuntimeHackProjects, filterRuntimeProjects, readRuntimeProjects } from "../lib/runtime-projects.ts"
import { buildProjectViews, serializeProjectView } from "../lib/project-views.ts"
import { readProjectsRegistry } from "../lib/projects-registry.ts"

import type { RuntimeProject } from "../lib/runtime-projects.ts"

export type RuntimeSnapshot = {
  readonly runtime: readonly RuntimeProject[]
  readonly updatedAtMs: number
}

export type ProjectsPayload = {
  readonly generated_at: string
  readonly filter: string | null
  readonly include_global: boolean
  readonly include_unregistered: boolean
  readonly projects: readonly Record<string, unknown>[]
}

export type PsItem = {
  readonly Service: string
  readonly Name: string
  readonly Status: string
  readonly Ports: string
}

export type PsPayload = {
  readonly project: string
  readonly branch: string | null
  readonly composeProject: string
  readonly items: readonly PsItem[]
}

export interface RuntimeCache {
  refresh(opts: { readonly reason: string }): Promise<void>
  getProjectsPayload(opts: {
    readonly filter: string | null
    readonly includeGlobal: boolean
    readonly includeUnregistered: boolean
  }): Promise<ProjectsPayload>
  getPsPayload(opts: {
    readonly composeProject: string
    readonly project: string
    readonly branch: string | null
  }): PsPayload
  getSnapshot(): RuntimeSnapshot | null
}

export function createRuntimeCache(opts: {
  readonly onRefresh?: (snapshot: RuntimeSnapshot) => void
}): RuntimeCache {
  let snapshot: RuntimeSnapshot | null = null
  let refreshTask: Promise<void> | null = null
  let pending = false

  const refresh = async ({ reason }: { readonly reason: string }): Promise<void> => {
    if (refreshTask) {
      pending = true
      await refreshTask
      return
    }

    refreshTask = (async () => {
      const runtime = await readRuntimeProjects({ includeGlobal: true })
      await autoRegisterRuntimeHackProjects({ runtime })
      snapshot = { runtime, updatedAtMs: Date.now() }
      opts.onRefresh?.(snapshot)
    })()

    await refreshTask
    refreshTask = null

    if (pending) {
      pending = false
      await refresh({ reason: `pending:${reason}` })
    }
  }

  const getProjectsPayload = async ({
    filter,
    includeGlobal,
    includeUnregistered
  }: {
    readonly filter: string | null
    readonly includeGlobal: boolean
    readonly includeUnregistered: boolean
  }): Promise<ProjectsPayload> => {
    if (!snapshot) {
      await refresh({ reason: "projects" })
    }
    const registry = await readProjectsRegistry()
    const runtime = filterRuntimeProjects({
      runtime: snapshot?.runtime ?? [],
      includeGlobal
    })
    const views = await buildProjectViews({
      registryProjects: registry.projects,
      runtime,
      filter,
      includeUnregistered
    })

    return {
      generated_at: new Date().toISOString(),
      filter,
      include_global: includeGlobal,
      include_unregistered: includeUnregistered,
      projects: views.map(serializeProjectView)
    }
  }

  const getPsPayload = ({
    composeProject,
    project,
    branch
  }: {
    readonly composeProject: string
    readonly project: string
    readonly branch: string | null
  }): PsPayload => {
    const runtime = snapshot?.runtime ?? []
    const match = runtime.find(p => p.project === composeProject)
    const items = match ? buildPsItems({ runtime: match }) : []
    return {
      project,
      branch,
      composeProject,
      items
    }
  }

  return {
    refresh,
    getProjectsPayload,
    getPsPayload,
    getSnapshot: () => snapshot
  }
}

function buildPsItems(opts: { readonly runtime: RuntimeProject }): PsItem[] {
  const out: PsItem[] = []
  for (const service of opts.runtime.services.values()) {
    for (const container of service.containers) {
      out.push({
        Service: service.service,
        Name: container.name,
        Status: container.status,
        Ports: container.ports
      })
    }
  }
  return out.sort((a, b) => {
    const serviceCmp = a.Service.localeCompare(b.Service)
    if (serviceCmp !== 0) return serviceCmp
    return a.Name.localeCompare(b.Name)
  })
}
