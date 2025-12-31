import { resolve } from "node:path"

import { display } from "../ui/display.ts"
import { logger } from "../ui/logger.ts"
import { openUrl } from "../lib/os.ts"
import { readBranchesFile, writeBranchesFile } from "../lib/branches.ts"
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
  readProjectDevHost,
  resolveProjectOauthTld,
  sanitizeBranchSlug,
  sanitizeProjectSlug
} from "../lib/project.ts"
import { resolveRegisteredProjectByName, upsertProjectRegistration } from "../lib/projects-registry.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { optPath, optProject } from "../cli/options.ts"
import { DEFAULT_PROJECT_TLD, HACK_PROJECT_DIR_PRIMARY } from "../constants.ts"

import type { CliContext, CommandArgs, CommandHandlerFor } from "../cli/command.ts"
import type { ProjectContext } from "../lib/project.ts"

const optNote = defineOption({
  name: "note",
  type: "string",
  long: "--note",
  valueHint: "<text>",
  description: "Optional note for the branch entry"
} as const)

const branchAddOptions = [optPath, optProject, optNote] as const
const branchAddPositionals = [{ name: "name", required: true }] as const
const branchListOptions = [optPath, optProject] as const
const branchRemoveOptions = [optPath, optProject] as const
const branchRemovePositionals = [{ name: "name", required: true }] as const
const branchOpenOptions = [optPath, optProject] as const
const branchOpenPositionals = [{ name: "name", required: true }] as const

type BranchAddArgs = CommandArgs<typeof branchAddOptions, typeof branchAddPositionals>
type BranchListArgs = CommandArgs<typeof branchListOptions, readonly []>
type BranchRemoveArgs = CommandArgs<typeof branchRemoveOptions, typeof branchRemovePositionals>
type BranchOpenArgs = CommandArgs<typeof branchOpenOptions, typeof branchOpenPositionals>

const branchSpec = defineCommand({
  name: "branch",
  summary: "Manage branch aliases for a project",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const branchAddSpec = defineCommand({
  name: "add",
  summary: "Register a branch alias for this project",
  group: "Project",
  options: branchAddOptions,
  positionals: branchAddPositionals,
  subcommands: []
} as const)

const branchListSpec = defineCommand({
  name: "list",
  summary: "List registered branch aliases for this project",
  group: "Project",
  options: branchListOptions,
  positionals: [],
  subcommands: []
} as const)

const branchRemoveSpec = defineCommand({
  name: "remove",
  summary: "Remove a branch alias for this project",
  group: "Project",
  options: branchRemoveOptions,
  positionals: branchRemovePositionals,
  subcommands: []
} as const)

const branchOpenSpec = defineCommand({
  name: "open",
  summary: "Open the branch host in a browser",
  group: "Project",
  options: branchOpenOptions,
  positionals: branchOpenPositionals,
  subcommands: []
} as const)


const handleBranchAdd: CommandHandlerFor<typeof branchAddSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const nameRaw = (args.positionals.name ?? "").trim()
  if (nameRaw.length === 0) throw new CliUsageError("Missing required argument: name")

  const slug = resolveBranchSlug(nameRaw)
  if (!slug) throw new CliUsageError("Invalid branch name")

  const noteRaw = (args.options.note ?? "").trim()
  const note = noteRaw.length > 0 ? noteRaw : undefined

  const nowIso = new Date().toISOString()
  const read = await readBranchesFile({ projectDir: project.projectDir })
  if (read.parseError) {
    logger.error({
      message: `Failed to parse ${read.path}: ${read.parseError}`
    })
    return 1
  }

  const file = { ...read.file }
  const existingIndex = file.branches.findIndex(entry => entry.slug === slug)

  if (existingIndex >= 0) {
    const existing = file.branches[existingIndex]
    if (!existing) {
      file.branches = [
        ...file.branches,
        {
          name: nameRaw,
          slug,
          ...(note ? { note } : {}),
          created_at: nowIso,
          last_used_at: nowIso
        }
      ]
      await writeBranchesFile({ path: read.path, file })
      logger.success({ message: `Added branch "${slug}"` })
      return 0
    }
    const updated = {
      ...existing,
      name: nameRaw,
      slug,
      ...(note ? { note } : {}),
      created_at: existing.created_at ?? nowIso,
      last_used_at: nowIso
    }
    file.branches = [...file.branches]
    file.branches[existingIndex] = updated
  } else {
    file.branches = [
      ...file.branches,
      {
        name: nameRaw,
        slug,
        ...(note ? { note } : {}),
        created_at: nowIso,
        last_used_at: nowIso
      }
    ]
  }

  await writeBranchesFile({ path: read.path, file })
  logger.success({
    message: existingIndex >= 0 ? `Updated branch "${slug}"` : `Added branch "${slug}"`
  })
  return 0
}

const handleBranchList: CommandHandlerFor<typeof branchListSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const read = await readBranchesFile({ projectDir: project.projectDir })
  if (read.parseError) {
    logger.error({
      message: `Failed to parse ${read.path}: ${read.parseError}`
    })
    return 1
  }

  if (read.file.branches.length === 0) {
    await display.panel({
      title: "Branches",
      tone: "info",
      lines: ["No branches registered for this project."]
    })
    return 0
  }

  const rows = [...read.file.branches]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(entry => [
      entry.name,
      entry.slug,
      entry.note ?? "",
      entry.created_at ?? "",
      entry.last_used_at ?? ""
    ])

  await display.section("Branches")
  await display.table({
    columns: ["Name", "Slug", "Note", "Created", "Last used"],
    rows
  })

  return 0
}

const handleBranchRemove: CommandHandlerFor<typeof branchRemoveSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const nameRaw = (args.positionals.name ?? "").trim()
  if (nameRaw.length === 0) throw new CliUsageError("Missing required argument: name")
  const slug = resolveBranchSlug(nameRaw)
  if (!slug) throw new CliUsageError("Invalid branch name")

  const read = await readBranchesFile({ projectDir: project.projectDir })
  if (read.parseError) {
    logger.error({
      message: `Failed to parse ${read.path}: ${read.parseError}`
    })
    return 1
  }

  const next = read.file.branches.filter(
    entry => entry.slug !== slug && entry.name.toLowerCase() !== nameRaw.toLowerCase()
  )

  if (next.length === read.file.branches.length) {
    logger.warn({ message: `No branch matched "${nameRaw}".` })
    return 0
  }

  await writeBranchesFile({ path: read.path, file: { ...read.file, branches: next } })
  logger.success({ message: `Removed branch "${slug}".` })
  return 0
}

const handleBranchOpen: CommandHandlerFor<typeof branchOpenSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const nameRaw = (args.positionals.name ?? "").trim()
  if (nameRaw.length === 0) throw new CliUsageError("Missing required argument: name")
  const branch = resolveBranchSlug(nameRaw)
  if (!branch) throw new CliUsageError("Invalid branch name")

  const derivedHost = `${defaultProjectSlugFromPath(project.projectRoot)}.${DEFAULT_PROJECT_TLD}`
  const devHost = (await readProjectDevHost(project)) ?? derivedHost
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const aliasHost = resolveBranchAliasHost({ devHost, cfg })
  const baseHosts = [devHost, aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  )

  const resolvedHost = applyBranchToHost({ host: devHost, branch, baseHosts })
  const url = `https://${resolvedHost}`

  logger.step({ message: `Opening ${url}` })
  return await openUrl(url)
}

export const branchCommand = defineCommand({
  ...branchSpec,
  subcommands: [
    withHandler(branchAddSpec, handleBranchAdd),
    withHandler(branchListSpec, handleBranchList),
    withHandler(branchRemoveSpec, handleBranchRemove),
    withHandler(branchOpenSpec, handleBranchOpen)
  ]
} as const)

function resolveStartDir(ctx: CliContext, pathOpt: string | undefined): string {
  return pathOpt ? resolve(ctx.cwd, pathOpt) : ctx.cwd
}

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext
  readonly pathOpt: string | undefined
  readonly projectOpt: string | undefined
}): Promise<ProjectContext> {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).")
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt)
    if (name.length === 0) throw new CliUsageError("Invalid --project value.")
    const fromRegistry = await resolveRegisteredProjectByName({ name })
    if (!fromRegistry) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      )
    }
    await touchProjectRegistration(fromRegistry)
    return fromRegistry
  }

  const startDir = resolveStartDir(opts.ctx, opts.pathOpt)
  const project = await requireProjectContext(startDir)
  await touchProjectRegistration(project)
  return project
}

async function requireProjectContext(startDir: string): Promise<ProjectContext> {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    throw new Error(`No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`)
  }
  return ctx
}

async function touchProjectRegistration(project: ProjectContext): Promise<void> {
  const outcome = await upsertProjectRegistration({ project })
  if (outcome.status === "conflict") {
    logger.warn({
      message: [
        `Project name conflict: "${outcome.conflictName}" is already registered at ${outcome.existing.repoRoot}`,
        `Incoming project dir: ${outcome.incoming.projectDir}`,
        "Tip: rename one project (hack.config.json name) to keep names unique."
      ].join("\n")
    })
  }
}

function resolveBranchSlug(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim()
  if (trimmed.length === 0) return null
  const slug = sanitizeBranchSlug(trimmed)
  return slug.length > 0 ? slug : "branch"
}

function resolveBranchAliasHost(opts: {
  readonly devHost: string
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>
}): string | null {
  const tld = resolveProjectOauthTld(opts.cfg.oauth)
  return tld ? `${opts.devHost}.${tld}` : null
}

function applyBranchToHost(opts: {
  readonly host: string
  readonly branch: string
  readonly baseHosts: readonly string[]
}): string {
  for (const baseHost of opts.baseHosts) {
    const rewritten = rewriteHostForBranch({
      host: opts.host,
      branch: opts.branch,
      baseHost
    })
    if (rewritten.changed) return rewritten.host
  }
  return opts.host
}

function rewriteHostForBranch(opts: {
  readonly host: string
  readonly branch: string
  readonly baseHost: string
}): { readonly host: string; readonly changed: boolean } {
  if (opts.host === opts.baseHost) {
    const next = `${opts.branch}.${opts.baseHost}`
    return { host: next, changed: next !== opts.host }
  }

  const suffix = `.${opts.baseHost}`
  if (!opts.host.endsWith(suffix)) return { host: opts.host, changed: false }

  const prefix = opts.host.slice(0, opts.host.length - suffix.length)
  if (prefix === opts.branch || prefix.endsWith(`.${opts.branch}`)) {
    return { host: opts.host, changed: false }
  }

  return { host: `${prefix}.${opts.branch}.${opts.baseHost}`, changed: true }
}
