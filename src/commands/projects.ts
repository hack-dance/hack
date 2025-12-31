import { resolve } from "node:path"
import { confirm, isCancel } from "@clack/prompts"
import { YAML } from "bun"

import { display } from "../ui/display.ts"
import { exec, run } from "../lib/shell.ts"
import {
  readProjectsRegistry,
  removeProjectsById,
  upsertProjectRegistration
} from "../lib/projects-registry.ts"
import { parseJsonLines } from "../lib/json-lines.ts"
import { getString, isRecord } from "../lib/guards.ts"
import { pathExists, readTextFile } from "../lib/fs.ts"
import {
  GLOBAL_HACK_DIR_NAME,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME
} from "../constants.ts"
import { optJson, optProject } from "../cli/options.ts"
import { defineCommand, defineOption, withHandler } from "../cli/command.ts"

import type { RegisteredProject } from "../lib/projects-registry.ts"
import type { CliContext, CommandArgs, CommandHandlerFor } from "../cli/command.ts"

const optDetails = defineOption({
  name: "details",
  type: "boolean",
  long: "--details",
  description: "Show per-project service tables"
} as const)

const optIncludeGlobal = defineOption({
  name: "includeGlobal",
  type: "boolean",
  long: "--include-global",
  description: "Include global infra projects under ~/.hack (e.g. logging stack)"
} as const)

const optAll = defineOption({
  name: "all",
  type: "boolean",
  long: "--all",
  description: "Include unregistered docker compose projects (best-effort)"
} as const)

const options = [optProject, optDetails, optIncludeGlobal, optAll, optJson] as const
const positionals = [] as const

type ProjectsArgs = CommandArgs<typeof options, typeof positionals>

const statusOptions = [optProject, optIncludeGlobal, optAll, optJson] as const

const statusSpec = defineCommand({
  name: "status",
  summary: "Show project status (shortcut for `hack projects --details`)",
  group: "Global",
  options: statusOptions,
  positionals,
  subcommands: [],
  expandInRootHelp: true
} as const)

const pruneOptions = [optIncludeGlobal] as const
const pruneSpec = defineCommand({
  name: "prune",
  summary: "Remove missing registry entries and stop orphaned containers",
  group: "Global",
  options: pruneOptions,
  positionals,
  subcommands: []
} as const)

const spec = defineCommand({
  name: "projects",
  summary: "Show all projects (registry + running docker compose)",
  group: "Global",
  options,
  positionals,
  subcommands: [pruneSpec],
  expandInRootHelp: true
} as const)

type RuntimeContainer = {
  readonly id: string
  readonly project: string
  readonly service: string
  readonly state: string
  readonly status: string
  readonly name: string
  readonly workingDir: string | null
}

type RuntimeService = {
  readonly service: string
  readonly containers: readonly RuntimeContainer[]
}

type RuntimeProject = {
  readonly project: string
  readonly workingDir: string | null
  readonly services: ReadonlyMap<string, RuntimeService>
}

type BranchRuntime = {
  readonly branch: string
  readonly runtime: RuntimeProject
}

type ProjectView = {
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

const handleProjects: CommandHandlerFor<typeof spec> = async ({ args }): Promise<number> => {
  const filter =
    typeof args.options.project === "string" ? sanitizeName(args.options.project) : null
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: args.options.details === true,
    json: args.options.json === true
  })
}

const handlePrune: CommandHandlerFor<typeof pruneSpec> = async ({ args }): Promise<number> => {
  const includeGlobal = args.options.includeGlobal === true
  const registry = await readProjectsRegistry()
  const missing = await findMissingRegistryEntries(registry.projects)
  const runtime = await readRuntimeProjects({ includeGlobal })
  const orphaned = await findOrphanRuntimeProjects(runtime)
  const orphanedContainerCount = orphaned.reduce(
    (sum, entry) => sum + entry.containerIds.length,
    0
  )

  if (missing.length === 0 && orphaned.length === 0) {
    await display.panel({
      title: "Prune",
      tone: "info",
      lines: ["No missing registry entries or orphaned containers found."]
    })
    return 0
  }

  await display.section("Prune candidates")

  if (missing.length > 0) {
    await display.section("Registry entries")
    await display.table({
      columns: ["Project", "Project Dir", "Reason"],
      rows: missing.map(entry => [entry.project.name, entry.project.projectDir, entry.reason])
    })
  }

  if (orphaned.length > 0) {
    await display.section("Orphaned containers")
    await display.table({
      columns: ["Compose Project", "Working Dir", "Reason", "Containers"],
      rows: orphaned.map(entry => [
        entry.project,
        entry.workingDir ?? "",
        entry.reason,
        entry.containerIds.length
      ])
    })
  }

  const ok = await confirm({
    message: `Remove ${missing.length} registry entr${missing.length === 1 ? "y" : "ies"} and stop ${orphanedContainerCount} container${orphanedContainerCount === 1 ? "" : "s"} from ${orphaned.length} orphaned project${orphaned.length === 1 ? "" : "s"}?`,
    initialValue: false
  })
  if (isCancel(ok)) throw new Error("Canceled")
  if (!ok) return 0

  if (missing.length > 0) {
    await removeProjectsById({
      ids: missing.map(entry => entry.project.id)
    })
  }

  if (orphaned.length > 0) {
    const ids = orphaned.flatMap(entry => entry.containerIds)
    await removeContainerIds(ids)
  }

  await display.panel({
    title: "Prune complete",
    tone: "success",
    lines: [
      `Registry entries removed: ${missing.length}`,
      `Orphaned containers removed: ${orphanedContainerCount}`
    ]
  })
  return 0
}

export const projectsCommand = withHandler(
  {
    ...spec,
    subcommands: [withHandler(pruneSpec, handlePrune)]
  },
  handleProjects
)

const handleStatus: CommandHandlerFor<typeof statusSpec> = async ({ args }): Promise<number> => {
  const filter =
    typeof args.options.project === "string" ? sanitizeName(args.options.project) : null
  return await runProjects({
    filter,
    includeGlobal: args.options.includeGlobal === true,
    includeUnregistered: args.options.all === true,
    details: true,
    json: args.options.json === true
  })
}

export const statusCommand = withHandler(statusSpec, handleStatus)

async function runProjects(opts: {
  readonly filter: string | null
  readonly includeGlobal: boolean
  readonly includeUnregistered: boolean
  readonly details: boolean
  readonly json: boolean
}): Promise<number> {
  const runtime = await readRuntimeProjects({
    includeGlobal: opts.includeGlobal
  })

  await autoRegisterRuntimeHackProjects(runtime)
  const registry = await readProjectsRegistry()

  const views = await buildViews({
    registryProjects: registry.projects,
    runtime,
    filter: opts.filter,
    includeUnregistered: opts.includeUnregistered
  })
  if (opts.json) {
    const payload = {
      generated_at: new Date().toISOString(),
      filter: opts.filter,
      include_global: opts.includeGlobal,
      include_unregistered: opts.includeUnregistered,
      projects: views.map(serializeProjectView)
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }

  if (views.length === 0) {
    await display.panel({
      title: "Projects",
      tone: "warn",
      lines: [opts.filter ? `No projects matched: ${opts.filter}` : "No projects found."]
    })
    return 0
  }

  await display.section("Projects")
  await display.table({
    columns: ["Name", "Status", "Services", "Dev Host", "Repo Root"],
    rows: views.map(p => {
      const definedCount = p.definedServices ? p.definedServices.length : null
      const runningCount = countRunningServices(p.runtime)
      const servicesCell =
        definedCount === null ? `${runningCount}/—` : `${runningCount}/${definedCount}`
      return [p.name, p.status, servicesCell, p.devHost ?? "", p.repoRoot ?? ""]
    })
  })

  if (opts.details) {
    for (const p of views) {
      await renderProjectDetails(p)
    }
  }

  return 0
}

async function renderProjectDetails(p: ProjectView): Promise<void> {
  await display.section(p.name)

  const meta: Array<readonly [string, string]> = []
  meta.push(["Status", p.status])
  if (p.devHost) meta.push(["Dev host", p.devHost])
  if (p.repoRoot) meta.push(["Repo root", p.repoRoot])
  if (p.projectDir) meta.push(["Project dir", p.projectDir])
  await display.kv({ entries: meta })

  const defined = new Set(p.definedServices ?? [])
  const runtimeServices = p.runtime?.services ?? new Map<string, RuntimeService>()
  const all = new Set<string>([...defined, ...runtimeServices.keys()])
  const names = [...all].sort((a, b) => a.localeCompare(b))

  const rows = names.map(svc => {
    const runtime = runtimeServices.get(svc) ?? null
    const containers = runtime?.containers ?? []
    const running = containers.filter(c => c.state === "running").length
    const total = containers.length
    const state = summarizeServiceState({ running, total })
    const definedCell = defined.has(svc) ? "yes" : ""
    const statusCell = containers[0]?.status ?? state
    return [svc, definedCell, `${running}/${total}`, state, statusCell] as const
  })

  await display.table({
    columns: ["Service", "Defined", "Running", "State", "Status"],
    rows
  })

  if (p.branchRuntime.length > 0) {
    const branchRows = p.branchRuntime
      .slice()
      .sort((a, b) => a.branch.localeCompare(b.branch))
      .map(entry => {
        const running = countRunningServices(entry.runtime)
        const total = entry.runtime.services.size
        const state = summarizeServiceState({ running, total })
        return [
          entry.branch,
          state,
          `${running}/${total}`,
          entry.runtime.workingDir ?? ""
        ] as const
      })

    await display.section("Branch instances")
    await display.table({
      columns: ["Branch", "State", "Services", "Working Dir"],
      rows: branchRows
    })
  }
}

function summarizeServiceState(opts: { readonly running: number; readonly total: number }): string {
  if (opts.total === 0) return "not running"
  if (opts.running === opts.total) return "running"
  if (opts.running === 0) return "stopped"
  return "mixed"
}

function countRunningServices(runtime: RuntimeProject | null): number {
  if (!runtime) return 0
  let count = 0
  for (const svc of runtime.services.values()) {
    const running = svc.containers.some(c => c.state === "running")
    if (running) count += 1
  }
  return count
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

async function buildViews(opts: {
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
      const definedServices = projectDirOk ? await readComposeServices(await composeFile) : null
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

    // running but not registered
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

async function readComposeServices(composeFile: string): Promise<readonly string[] | null> {
  const text = await readTextFile(composeFile)
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

async function readRuntimeProjects(opts: {
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
  const labelsById = await readContainerLabels(ids)

  const home = process.env.HOME ?? ""
  const globalRoot = home ? resolve(home, GLOBAL_HACK_DIR_NAME) : ""

  const containers: RuntimeContainer[] = []
  for (const row of baseRows) {
    const id = getString(row, "ID") ?? getString(row, "Id") ?? ""
    const state = getString(row, "State") ?? ""
    const status = getString(row, "Status") ?? ""
    const name = getString(row, "Names") ?? ""
    const labelsRaw = getString(row, "Labels")
    const labels =
      (id.length > 0 ? labelsById.get(id) : undefined) ??
      (labelsRaw ? parseLabelString(labelsRaw) : {})
    const project = labels["com.docker.compose.project"] ?? null
    const service = labels["com.docker.compose.service"] ?? null
    const oneoff = (labels["com.docker.compose.oneoff"] ?? "").toLowerCase() === "true"
    if (!project || !service || oneoff) continue

    const workingDir = labels["com.docker.compose.project.working_dir"] ?? null
    const isGlobal = globalRoot.length > 0 && workingDir ? workingDir.startsWith(globalRoot) : false
    if (isGlobal && !opts.includeGlobal) continue

    containers.push({ id, project, service, state, status, name, workingDir })
  }

  const byProject = new Map<
    string,
    { workingDir: string | null; byService: Map<string, RuntimeContainer[]> }
  >()
  for (const c of containers) {
    const p = byProject.get(c.project) ?? {
      workingDir: c.workingDir,
      byService: new Map()
    }
    const arr = p.byService.get(c.service) ?? []
    p.byService.set(c.service, [...arr, c])
    byProject.set(c.project, p)
  }

  const out: RuntimeProject[] = []
  for (const [project, value] of byProject.entries()) {
    const services = new Map<string, RuntimeService>()
    for (const [service, containers] of value.byService.entries()) {
      services.set(service, { service, containers })
    }
    out.push({ project, workingDir: value.workingDir, services })
  }

  return out.sort((a, b) => a.project.localeCompare(b.project))
}

async function readContainerLabels(
  ids: readonly string[]
): Promise<Map<string, Record<string, string>>> {
  if (ids.length === 0) return new Map()

  const res = await exec(
    ["docker", "inspect", "--format", "{{.Id}}|{{json .Config.Labels}}", ...ids],
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
    const labels = parseLabelsJson(json)
    if (id.length > 0) {
      out.set(id, labels)
      if (id.length >= 12) out.set(id.slice(0, 12), labels)
    }
  }

  return out
}

function parseLabelsJson(raw: string): Record<string, string> {
  if (!raw || raw === "null") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
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

function parseLabelString(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key.length === 0) continue
    out[key] = value
  }
  return out
}

function sanitizeName(value: string): string {
  return value.trim().toLowerCase()
}

async function autoRegisterRuntimeHackProjects(runtime: readonly RuntimeProject[]): Promise<void> {
  for (const p of runtime) {
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

function serializeProjectView(view: ProjectView): Record<string, unknown> {
  return {
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

function serializeRuntimeProject(runtime: RuntimeProject): Record<string, unknown> {
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
        working_dir: container.workingDir ?? null
      }))
    }))
  }
}

type MissingRegistryEntry = {
  readonly project: RegisteredProject
  readonly reason: string
}

type OrphanedRuntimeProject = {
  readonly project: string
  readonly workingDir: string | null
  readonly reason: string
  readonly containerIds: readonly string[]
}

async function findMissingRegistryEntries(
  projects: readonly RegisteredProject[]
): Promise<MissingRegistryEntry[]> {
  const out: MissingRegistryEntry[] = []
  for (const project of projects) {
    if (!(await pathExists(project.projectDir))) {
      out.push({ project, reason: "missing project dir" })
      continue
    }
    const composeFile = resolve(project.projectDir, PROJECT_COMPOSE_FILENAME)
    if (!(await pathExists(composeFile))) {
      out.push({ project, reason: "missing compose file" })
    }
  }
  return out
}

async function findOrphanRuntimeProjects(
  runtime: readonly RuntimeProject[]
): Promise<OrphanedRuntimeProject[]> {
  const out: OrphanedRuntimeProject[] = []
  for (const project of runtime) {
    const workingDir = project.workingDir
    if (!workingDir) continue
    if (!(await pathExists(workingDir))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing working dir",
        containerIds: collectContainerIds(project)
      })
      continue
    }
    const composeFile = resolve(workingDir, PROJECT_COMPOSE_FILENAME)
    if (!(await pathExists(composeFile))) {
      out.push({
        project: project.project,
        workingDir,
        reason: "missing compose file",
        containerIds: collectContainerIds(project)
      })
    }
  }
  return out
}

function collectContainerIds(project: RuntimeProject): readonly string[] {
  const out: string[] = []
  for (const service of project.services.values()) {
    for (const container of service.containers) {
      if (container.id.length > 0) out.push(container.id)
    }
  }
  return out
}

async function removeContainerIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const unique = [...new Set(ids)]
  const chunks = chunkArray(unique, 50)
  for (const chunk of chunks) {
    const code = await run(["docker", "rm", "-f", ...chunk], { stdin: "ignore" })
    if (code !== 0) break
  }
}

function chunkArray<T>(input: readonly T[], size: number): T[][] {
  if (size <= 0) return [Array.from(input)]
  const out: T[][] = []
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size))
  }
  return out
}
