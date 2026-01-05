import { resolve } from "node:path"

import { YAML } from "bun"

import { pathExists, readTextFile } from "./fs.ts"
import { isRecord } from "./guards.ts"
import {
  countRunningServices,
  type RuntimeProject,
  serializeRuntimeProject
} from "./runtime-projects.ts"
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts"

import type { RegisteredProject } from "./projects-registry.ts"

export type BranchRuntime = {
  readonly branch: string
  readonly runtime: RuntimeProject
}

export type ProjectView = {
  readonly projectId?: string
  readonly name: string
  readonly devHost: string | null
  readonly repoRoot: string | null
  readonly projectDir: string | null
  readonly definedServices: readonly string[] | null
  readonly runtime: RuntimeProject | null
  readonly branchRuntime: readonly BranchRuntime[]
  readonly kind: "registered" | "unregistered"
  readonly status: "running" | "stopped" | "missing" | "unregistered"
}

export async function buildProjectViews(opts: {
  readonly registryProjects: readonly RegisteredProject[]
  readonly runtime: readonly RuntimeProject[]
  readonly filter: string | null
  readonly includeUnregistered: boolean
}): Promise<ProjectView[]> {
  const byName = new Map(opts.registryProjects.map(p => [p.name, p] as const))
  const runtimeByName = new Map(opts.runtime.map(p => [p.project, p] as const))

  const names = new Set<string>()
  for (const p of opts.registryProjects) names.add(p.name)
  if (opts.includeUnregistered) {
    for (const p of opts.runtime) names.add(p.project)
  }

  const out: ProjectView[] = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (opts.filter && name !== opts.filter) continue

    const reg = byName.get(name) ?? null
    const runtime = runtimeByName.get(name) ?? null

    if (reg) {
      const projectDirOk = await pathExists(reg.projectDir)
      const composeFile = resolve(reg.projectDir, PROJECT_COMPOSE_FILENAME)
      const definedServices = projectDirOk ? await readComposeServices({ composeFile }) : null
      const running = countRunningServices(runtime)
      const status: ProjectView["status"] =
        !projectDirOk ? "missing"
        : running > 0 ? "running"
        : "stopped"
      const branchRuntime = collectBranchRuntime({
        baseName: name,
        runtimeProjects: opts.runtime
      })

      out.push({
        projectId: reg.id,
        name,
        devHost: reg.devHost ?? null,
        repoRoot: reg.repoRoot,
        projectDir: reg.projectDir,
        definedServices,
        runtime,
        branchRuntime,
        kind: "registered",
        status
      })
      continue
    }

    if (opts.includeUnregistered) {
      out.push({
        name,
        devHost: null,
        repoRoot: null,
        projectDir: null,
        definedServices: null,
        runtime,
        branchRuntime: [],
        kind: "unregistered",
        status: "unregistered"
      })
    }
  }

  return out
}

export function serializeProjectView(view: ProjectView): Record<string, unknown> {
  return {
    project_id: view.projectId ?? null,
    name: view.name,
    dev_host: view.devHost ?? null,
    repo_root: view.repoRoot ?? null,
    project_dir: view.projectDir ?? null,
    defined_services: view.definedServices ?? null,
    runtime: view.runtime ? serializeRuntimeProject(view.runtime) : null,
    branch_runtime: view.branchRuntime.map(entry => ({
      branch: entry.branch,
      runtime: serializeRuntimeProject(entry.runtime)
    })),
    kind: view.kind,
    status: view.status
  }
}

function collectBranchRuntime(opts: {
  readonly baseName: string
  readonly runtimeProjects: readonly RuntimeProject[]
}): readonly BranchRuntime[] {
  const prefix = `${opts.baseName}--`
  const out: BranchRuntime[] = []
  for (const runtime of opts.runtimeProjects) {
    if (!runtime.project.startsWith(prefix)) continue
    const branch = runtime.project.slice(prefix.length)
    if (branch.length === 0) continue
    out.push({ branch, runtime })
  }
  return out
}

async function readComposeServices(opts: {
  readonly composeFile: string
}): Promise<readonly string[] | null> {
  const text = await readTextFile(opts.composeFile)
  if (!text) return null

  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const servicesRaw = parsed["services"]
  if (!isRecord(servicesRaw)) return []

  return Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b))
}
