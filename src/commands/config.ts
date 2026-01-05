import { resolve } from "node:path"

import { logger } from "../ui/logger.ts"
import { readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { isRecord } from "../lib/guards.ts"
import {
  findProjectContext,
  sanitizeProjectSlug
} from "../lib/project.ts"
import { resolveRegisteredProjectByName, upsertProjectRegistration } from "../lib/projects-registry.ts"
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts"
import { optPath, optProject } from "../cli/options.ts"
import {
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME
} from "../constants.ts"

import type { CliContext, CommandArgs, CommandHandlerFor } from "../cli/command.ts"
import type { ProjectContext } from "../lib/project.ts"

type ConfigReadResult =
  | { readonly ok: true; readonly path: string; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

const configSpec = defineCommand({
  name: "config",
  summary: "Read/write hack.config.json values",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const configGetOptions = [optPath, optProject] as const
const configGetPositionals = [{ name: "key", required: true }] as const

const configSetOptions = [optPath, optProject] as const
const configSetPositionals = [
  { name: "key", required: true },
  { name: "value", required: true }
] as const

type ConfigGetArgs = CommandArgs<typeof configGetOptions, typeof configGetPositionals>
type ConfigSetArgs = CommandArgs<typeof configSetOptions, typeof configSetPositionals>

const configGetSpec = defineCommand({
  name: "get",
  summary: "Read a value from hack.config.json",
  group: "Project",
  options: configGetOptions,
  positionals: configGetPositionals,
  subcommands: []
} as const)

const configSetSpec = defineCommand({
  name: "set",
  summary: "Update a value in hack.config.json",
  group: "Project",
  options: configSetOptions,
  positionals: configSetPositionals,
  subcommands: []
} as const)

const handleConfigGet: CommandHandlerFor<typeof configGetSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const key = (args.positionals.key ?? "").trim()
  if (key.length === 0) throw new CliUsageError("Missing required argument: key")

  const parsedKey = parseKeyPath({ raw: key })
  if (parsedKey.length === 0) throw new CliUsageError("Invalid config key.")

  const read = await readConfigObject({ project })
  if (!read.ok) {
    logger.error({ message: read.error })
    return 1
  }

  const value = getPathValue({ target: read.value, path: parsedKey })
  if (value === undefined) {
    logger.error({ message: `Key not found: ${key}` })
    return 1
  }

  if (typeof value === "string") {
    process.stdout.write(`${value}\n`)
    return 0
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return 0
}

const handleConfigSet: CommandHandlerFor<typeof configSetSpec> = async ({
  ctx,
  args
}): Promise<number> => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const key = (args.positionals.key ?? "").trim()
  if (key.length === 0) throw new CliUsageError("Missing required argument: key")
  const parsedKey = parseKeyPath({ raw: key })
  if (parsedKey.length === 0) throw new CliUsageError("Invalid config key.")

  const valueRaw = (args.positionals.value ?? "").trim()
  const value = parseValue({ raw: valueRaw })

  const read = await readConfigJsonForSet({ project })
  if (!read.ok) {
    logger.error({ message: read.error })
    return 1
  }

  const update = setPathValue({ target: read.value, path: parsedKey, value })
  if (update.error) {
    logger.error({ message: update.error })
    return 1
  }

  const nextText = `${JSON.stringify(read.value, null, 2)}\n`
  const result = await writeTextFileIfChanged(read.path, nextText)

  if (result.changed) {
    await touchProjectRegistration(project)
  }

  logger.success({
    message: result.changed ? `Updated ${read.path}` : "No changes needed."
  })
  return 0
}

export const configCommand = defineCommand({
  ...configSpec,
  subcommands: [withHandler(configGetSpec, handleConfigGet), withHandler(configSetSpec, handleConfigSet)]
} as const)

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

  const startDir = opts.pathOpt ? resolve(opts.ctx.cwd, opts.pathOpt) : opts.ctx.cwd
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

async function readConfigObject(opts: {
  readonly project: ProjectContext
}): Promise<ConfigReadResult> {
  const jsonPath = resolve(opts.project.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText !== null) {
    const parsed = parseJsonObject({ text: jsonText, path: jsonPath })
    return parsed.ok ? { ok: true, path: jsonPath, value: parsed.value } : parsed
  }

  const tomlPath = resolve(opts.project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
  const tomlText = await readTextFile(tomlPath)
  if (tomlText !== null) {
    let parsed: unknown
    try {
      parsed = Bun.TOML.parse(tomlText)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid TOML"
      return { ok: false, error: `Failed to parse ${tomlPath}: ${message}` }
    }
    if (!isRecord(parsed)) {
      return { ok: false, error: `Expected ${tomlPath} to be an object.` }
    }
    return { ok: true, path: tomlPath, value: parsed }
  }

  return {
    ok: false,
    error: `Missing ${PROJECT_CONFIG_FILENAME}. Run: hack init`
  }
}

async function readConfigJsonForSet(opts: {
  readonly project: ProjectContext
}): Promise<ConfigReadResult> {
  const jsonPath = resolve(opts.project.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText === null) {
    const tomlPath = resolve(opts.project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
    const tomlText = await readTextFile(tomlPath)
    if (tomlText !== null) {
      return {
        ok: false,
        error: `Legacy config found at ${tomlPath}. Convert to ${PROJECT_CONFIG_FILENAME} to use config set.`
      }
    }
    return { ok: false, error: `Missing ${PROJECT_CONFIG_FILENAME}. Run: hack init` }
  }

  const parsed = parseJsonObject({ text: jsonText, path: jsonPath })
  if (!parsed.ok) return parsed
  return { ok: true, path: jsonPath, value: parsed.value }
}

function parseJsonObject(opts: {
  readonly text: string
  readonly path: string
}): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(opts.text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return { ok: false, error: `Failed to parse ${opts.path}: ${message}` }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: `Expected ${opts.path} to be an object.` }
  }

  return { ok: true, value: parsed }
}

function parseKeyPath(opts: { readonly raw: string }): readonly string[] {
  const parts: string[] = []
  let buffer = ""
  let escape = false
  let inBracket = false
  let quote: "\"" | "'" | null = null

  const pushBuffer = () => {
    const trimmed = buffer.trim()
    if (trimmed.length > 0) parts.push(trimmed)
    buffer = ""
  }

  for (let i = 0; i < opts.raw.length; i += 1) {
    const ch = opts.raw[i] ?? ""
    if (inBracket) {
      if (escape) {
        buffer += ch
        escape = false
        continue
      }
      if (ch === "\\") {
        escape = true
        continue
      }
      if (quote) {
        if (ch === quote) {
          quote = null
          continue
        }
        buffer += ch
        continue
      }
      if (ch === "'" || ch === "\"") {
        quote = ch
        continue
      }
      if (ch === "]") {
        inBracket = false
        pushBuffer()
        continue
      }
      buffer += ch
      continue
    }

    if (escape) {
      buffer += ch
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === ".") {
      pushBuffer()
      continue
    }
    if (ch === "[") {
      if (buffer.trim().length > 0) {
        pushBuffer()
      } else {
        buffer = ""
      }
      inBracket = true
      continue
    }
    buffer += ch
  }

  if (escape) buffer += "\\"
  if (buffer.length > 0) pushBuffer()

  return parts
}

function getPathValue(opts: {
  readonly target: Record<string, unknown>
  readonly path: readonly string[]
}): unknown {
  let current: unknown = opts.target
  for (const key of opts.path) {
    if (!isRecord(current)) return undefined
    current = current[key]
    if (current === undefined) return undefined
  }
  return current
}

function setPathValue(opts: {
  readonly target: Record<string, unknown>
  readonly path: readonly string[]
  readonly value: unknown
}): { readonly error?: string } {
  let current: Record<string, unknown> = opts.target
  for (let i = 0; i < opts.path.length - 1; i += 1) {
    const key = opts.path[i] ?? ""
    const existing = current[key]
    if (existing === undefined) {
      const next: Record<string, unknown> = {}
      current[key] = next
      current = next
      continue
    }
    if (!isRecord(existing)) {
      return { error: `Cannot set ${opts.path.join(".")}: ${opts.path.slice(0, i + 1).join(".")} is not an object.` }
    }
    current = existing
  }

  const lastKey = opts.path[opts.path.length - 1] ?? ""
  current[lastKey] = opts.value
  return {}
}

function parseValue(opts: { readonly raw: string }): unknown {
  const trimmed = opts.raw.trim()
  if (trimmed.length === 0) return ""
  try {
    return JSON.parse(trimmed)
  } catch {
    return opts.raw
  }
}
