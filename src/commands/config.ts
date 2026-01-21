import { dirname, resolve } from "node:path"

import { logger } from "../ui/logger.ts"
import { ensureDir, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { isRecord } from "../lib/guards.ts"
import { resolveGlobalConfigPath } from "../lib/config-paths.ts"
import {
  findProjectContext,
  sanitizeProjectSlug
} from "../lib/project.ts"
import { resolveRegisteredProjectByName, upsertProjectRegistration } from "../lib/projects-registry.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { optPath, optProject } from "../cli/options.ts"
import {
  HACK_PROJECT_DIR_PRIMARY,
  GLOBAL_ONLY_EXTENSION_IDS,
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

const optGlobal = defineOption({
  name: "global",
  type: "boolean",
  long: "--global",
  description: "Read/write global ~/.hack/hack.config.json"
} as const)

const configGetOptions = [optPath, optProject, optGlobal] as const
const configGetPositionals = [{ name: "key", required: true }] as const

const configSetOptions = [optPath, optProject, optGlobal] as const
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
    projectOpt: args.options.project,
    globalOpt: args.options.global === true
  })

  const key = (args.positionals.key ?? "").trim()
  if (key.length === 0) throw new CliUsageError("Missing required argument: key")

  const parsedKey = parseKeyPath({ raw: key })
  if (parsedKey.length === 0) throw new CliUsageError("Invalid config key.")

  const read = await readConfigObject({ target: project })
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
    projectOpt: args.options.project,
    globalOpt: args.options.global === true
  })

  const key = (args.positionals.key ?? "").trim()
  if (key.length === 0) throw new CliUsageError("Missing required argument: key")
  const parsedKey = parseKeyPath({ raw: key })
  if (parsedKey.length === 0) throw new CliUsageError("Invalid config key.")

  const valueRaw = (args.positionals.value ?? "").trim()
  const value = parseValue({ raw: valueRaw })

  const globalOnlyKey = resolveGlobalOnlyKey({ path: parsedKey })
  if (globalOnlyKey && project.scope === "project") {
    logger.error({
      message: `Key ${globalOnlyKey} is global-only. Re-run with --global.`
    })
    logger.info({
      message: `Fix: hack config set --global '${key}' ${valueRaw}`
    })
    return 1
  }

  const read = await readConfigJsonForSet({ target: project })
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
  if (project.scope === "global") {
    await ensureDir(dirname(read.path))
  }
  const result = await writeTextFileIfChanged(read.path, nextText)

  if (result.changed && project.scope === "project") {
    await touchProjectRegistration(project.project)
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

type ConfigTarget =
  | { readonly scope: "global"; readonly path: string }
  | { readonly scope: "project"; readonly project: ProjectContext }

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext
  readonly pathOpt: string | undefined
  readonly projectOpt: string | undefined
  readonly globalOpt: boolean
}): Promise<ConfigTarget> {
  if (opts.globalOpt) {
    if (opts.pathOpt || opts.projectOpt) {
      throw new CliUsageError("Use --global without --path or --project.")
    }
    return { scope: "global", path: resolveGlobalConfigPath() }
  }

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
    return { scope: "project", project: fromRegistry }
  }

  const startDir = opts.pathOpt ? resolve(opts.ctx.cwd, opts.pathOpt) : opts.ctx.cwd
  const project = await requireProjectContext(startDir)
  await touchProjectRegistration(project)
  return { scope: "project", project }
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
  readonly target: ConfigTarget
}): Promise<ConfigReadResult> {
  if (opts.target.scope === "global") {
    const jsonText = await readTextFile(opts.target.path)
    if (jsonText === null) {
      return {
        ok: false,
        error: `Missing global config at ${opts.target.path}. Run: hack config set --global <key> <value>`
      }
    }
    const parsed = parseJsonObject({ text: jsonText, path: opts.target.path })
    return parsed.ok ? { ok: true, path: opts.target.path, value: parsed.value } : parsed
  }

  const jsonPath = resolve(opts.target.project.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText !== null) {
    const parsed = parseJsonObject({ text: jsonText, path: jsonPath })
    return parsed.ok ? { ok: true, path: jsonPath, value: parsed.value } : parsed
  }

  const tomlPath = resolve(opts.target.project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
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
  readonly target: ConfigTarget
}): Promise<ConfigReadResult> {
  if (opts.target.scope === "global") {
    const jsonText = await readTextFile(opts.target.path)
    if (jsonText === null) {
      return { ok: true, path: opts.target.path, value: {} }
    }
    const parsed = parseJsonObject({ text: jsonText, path: opts.target.path })
    if (!parsed.ok) return parsed
    return { ok: true, path: opts.target.path, value: parsed.value }
  }

  const jsonPath = resolve(opts.target.project.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText === null) {
    const tomlPath = resolve(opts.target.project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
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

function resolveGlobalOnlyKey(opts: { readonly path: readonly string[] }): string | null {
  if (opts.path[0] !== "controlPlane") return null
  const section = opts.path[1]
  if (section === "gateway") {
    const key = opts.path[2]
    if (key === "allowWrites" || key === "bind" || key === "port") {
      return `controlPlane.gateway.${key}`
    }
    return null
  }
  if (section === "extensions") {
    const extensionId = opts.path[2]
    if (!extensionId) return null
    const globalOnlyExtensions = new Set(GLOBAL_ONLY_EXTENSION_IDS)
    if (globalOnlyExtensions.has(extensionId as (typeof GLOBAL_ONLY_EXTENSION_IDS)[number])) {
      return `controlPlane.extensions["${extensionId}"]`
    }
  }
  return null
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
