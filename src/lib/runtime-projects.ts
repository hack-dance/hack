import { resolve } from "node:path"

import { exec } from "./shell.ts"
import { parseJsonLines } from "./json-lines.ts"
import { getString, isRecord } from "./guards.ts"
import { pathExists } from "./fs.ts"
import { upsertProjectRegistration } from "./projects-registry.ts"
import {
  GLOBAL_HACK_DIR_NAME,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME
} from "../constants.ts"


export type RuntimeContainer = {
  readonly id: string
  readonly project: string
  readonly service: string
  readonly state: string
  readonly status: string
  readonly name: string
  readonly ports: string
  readonly workingDir: string | null
}

export type RuntimeService = {
  readonly service: string
  readonly containers: readonly RuntimeContainer[]
}

export type RuntimeProject = {
  readonly project: string
  readonly workingDir: string | null
  readonly services: ReadonlyMap<string, RuntimeService>
  readonly isGlobal: boolean
}

export function countRunningServices(runtime: RuntimeProject | null): number {
  if (!runtime) return 0
  let count = 0
  for (const svc of runtime.services.values()) {
    const running = svc.containers.some(c => c.state === "running")
    if (running) count += 1
  }
  return count
}

export function filterRuntimeProjects(opts: {
  readonly runtime: readonly RuntimeProject[]
  readonly includeGlobal: boolean
}): readonly RuntimeProject[] {
  if (opts.includeGlobal) return opts.runtime
  return opts.runtime.filter(project => !project.isGlobal)
}

export async function readRuntimeProjects(opts: {
  readonly includeGlobal: boolean
}): Promise<readonly RuntimeProject[]> {
  const res = await exec(
    ["docker", "ps", "-a", "--filter", "label=com.docker.compose.project", "--format", "json"],
    { stdin: "ignore" }
  )
  if (res.exitCode !== 0) {
    return []
  }

  const baseRows = parseJsonLines(res.stdout)
  const ids = baseRows
    .map(row => getString(row, "ID") ?? getString(row, "Id") ?? "")
    .filter(id => id.length > 0)
  const labelsById = await readContainerLabels({ ids })

  const home = process.env.HOME ?? ""
  const globalRoot = home ? resolve(home, GLOBAL_HACK_DIR_NAME) : ""

  const containers: RuntimeContainer[] = []
  for (const row of baseRows) {
    const id = getString(row, "ID") ?? getString(row, "Id") ?? ""
    const state = getString(row, "State") ?? ""
    const status = getString(row, "Status") ?? ""
    const name = getString(row, "Names") ?? ""
    const ports = getString(row, "Ports") ?? ""
    const labelsRaw = getString(row, "Labels")
    const labels =
      (id.length > 0 ? labelsById.get(id) : undefined) ??
      (labelsRaw ? parseLabelString({ raw: labelsRaw }) : {})
    const project = labels["com.docker.compose.project"] ?? null
    const service = labels["com.docker.compose.service"] ?? null
    const oneoff = (labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true"
    if (!project || !service || oneoff) continue

    const workingDir = labels["com.docker.compose.project.working_dir"] ?? null
    const isGlobal = globalRoot.length > 0 && workingDir ? workingDir.startsWith(globalRoot) : false
    if (isGlobal && !opts.includeGlobal) continue

    containers.push({ id, project, service, state, status, name, ports, workingDir })
  }

  const byProject = new Map<
    string,
    { workingDir: string | null; byService: Map<string, RuntimeContainer[]>; isGlobal: boolean }
  >()
  for (const c of containers) {
    const workingDir = c.workingDir
    const isGlobal = globalRoot.length > 0 && workingDir ? workingDir.startsWith(globalRoot) : false
    const p = byProject.get(c.project) ?? {
      workingDir,
      byService: new Map(),
      isGlobal
    }
    const arr = p.byService.get(c.service) ?? []
    p.byService.set(c.service, [...arr, c])
    byProject.set(c.project, p)
  }

  const out: RuntimeProject[] = []
  for (const [project, value] of byProject.entries()) {
    const services = new Map<string, RuntimeService>()
    for (const [service, containersByService] of value.byService.entries()) {
      services.set(service, { service, containers: containersByService })
    }
    out.push({
      project,
      workingDir: value.workingDir,
      services,
      isGlobal: value.isGlobal
    })
  }

  return out.sort((a, b) => a.project.localeCompare(b.project))
}

export async function autoRegisterRuntimeHackProjects(opts: {
  readonly runtime: readonly RuntimeProject[]
}): Promise<void> {
  for (const p of opts.runtime) {
    const wd = p.workingDir ?? ""
    const dirName =
      wd.endsWith("/.hack") ? ".hack"
      : wd.endsWith("/.dev") ? ".dev"
      : null
    if (!dirName) continue

    const projectDir = wd
    const repoRoot = resolve(projectDir, "..")
    const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME)
    if (!(await pathExists(composeFile))) continue

    await upsertProjectRegistration({
      project: {
        projectRoot: repoRoot,
        projectDirName: dirName,
        projectDir,
        composeFile,
        envFile: resolve(projectDir, PROJECT_ENV_FILENAME),
        configFile: resolve(projectDir, PROJECT_CONFIG_FILENAME)
      }
    })
  }
}

export function serializeRuntimeProject(runtime: RuntimeProject): Record<string, unknown> {
  return {
    project: runtime.project,
    working_dir: runtime.workingDir ?? null,
    services: [...runtime.services.values()].map(service => ({
      service: service.service,
      containers: service.containers.map(container => ({
        id: container.id,
        state: container.state,
        status: container.status,
        name: container.name,
        ports: container.ports,
        working_dir: container.workingDir ?? null
      }))
    }))
  }
}

export async function readContainerLabels(opts: {
  readonly ids: readonly string[]
}): Promise<Map<string, Record<string, string>>> {
  if (opts.ids.length === 0) return new Map()

  const res = await exec(
    ["docker", "inspect", "--format", "{{.Id}}|{{json .Config.Labels}}", ...opts.ids],
    { stdin: "ignore" }
  )
  if (res.exitCode !== 0) return new Map()

  const out = new Map<string, Record<string, string>>()
  for (const line of res.stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const idx = trimmed.indexOf("|")
    if (idx <= 0) continue
    const id = trimmed.slice(0, idx).trim()
    const json = trimmed.slice(idx + 1).trim()
    const labels = parseLabelsJson({ raw: json })
    if (id.length > 0) {
      out.set(id, labels)
      if (id.length >= 12) out.set(id.slice(0, 12), labels)
    }
  }

  return out
}

function parseLabelsJson(opts: { readonly raw: string }): Record<string, string> {
  if (!opts.raw || opts.raw === "null") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(opts.raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}

  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function parseLabelString(opts: { readonly raw: string }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of opts.raw.split(",")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key.length === 0) continue
    out[key] = value
  }
  return out
}
