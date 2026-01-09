import { resolve } from "node:path"

import { logger } from "../ui/logger.ts"
import { defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { ensureDir, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { findProjectContext } from "../lib/project.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"

const optPath = defineOption({
  name: "path",
  type: "string",
  long: "--path",
  valueHint: "<path>",
  description: "Start directory (defaults to cwd)",
  defaultValue: null
} as const)

const internalOptions = [optPath] as const

type InternalArgs = CommandArgs<typeof internalOptions, readonly []>

const extraHostsSetSpec = defineCommand({
  name: "set",
  summary: "Set an internal extra_hosts entry",
  group: "Internal",
  options: internalOptions,
  positionals: [
    { name: "hostname", required: true },
    { name: "target", required: true }
  ],
  subcommands: []
} as const)

const extraHostsUnsetSpec = defineCommand({
  name: "unset",
  summary: "Remove an internal extra_hosts entry",
  group: "Internal",
  options: internalOptions,
  positionals: [{ name: "hostname", required: true }],
  subcommands: []
} as const)

const extraHostsListSpec = defineCommand({
  name: "list",
  summary: "List internal extra_hosts entries",
  group: "Internal",
  options: internalOptions,
  positionals: [],
  subcommands: []
} as const)

export const internalCommand = defineCommand({
  name: "internal",
  summary: "Manage hack-managed internal overrides",
  group: "Internal",
  expandInRootHelp: false,
  options: [],
  positionals: [],
  subcommands: [
    defineCommand({
      name: "extra-hosts",
      summary: "Manage internal Compose extra_hosts",
      group: "Internal",
      options: [],
      positionals: [],
      subcommands: [
        withHandler(extraHostsSetSpec, handleExtraHostsSet),
        withHandler(extraHostsUnsetSpec, handleExtraHostsUnset),
        withHandler(extraHostsListSpec, handleExtraHostsList)
      ]
    } as const)
  ]
} as const)

function resolveStartDir(ctx: CliContext, args: InternalArgs): string {
  const fromOpt = (args.options.path ?? "").trim()
  return fromOpt.length > 0 ? fromOpt : ctx.cwd
}

async function requireProject(startDir: string) {
  const project = await findProjectContext(startDir)
  if (!project) {
    throw new Error("No .hack/ (or legacy .dev/) found. Run: hack init")
  }
  return project
}

const INTERNAL_EXTRA_HOSTS_FILENAME = "extra-hosts.json" as const

function resolveExtraHostsPath(projectDir: string): string {
  return resolve(projectDir, ".internal", INTERNAL_EXTRA_HOSTS_FILENAME)
}

async function readInternalExtraHosts(path: string): Promise<Record<string, string>> {
  const text = await readTextFile(path)
  if (!text) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}

  const out: Record<string, string> = {}
  for (const [keyRaw, valueRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const key = keyRaw.trim()
    if (key.length === 0) continue
    if (typeof valueRaw !== "string") continue
    const value = valueRaw.trim()
    if (value.length === 0) continue
    out[key] = value
  }

  return out
}

async function writeInternalExtraHosts(path: string, map: Record<string, string>): Promise<void> {
  const text = `${JSON.stringify(map, null, 2)}\n`
  await writeTextFileIfChanged(path, text)
}

async function handleExtraHostsSet({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: CommandArgs<typeof internalOptions, readonly ["hostname", "target"]>
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args)
  const project = await requireProject(startDir)

  const hostname = (args.positionals.hostname ?? "").trim()
  const target = (args.positionals.target ?? "").trim()
  if (hostname.length === 0) throw new Error("hostname is required")
  if (target.length === 0) throw new Error("target is required")

  const dir = resolve(project.projectDir, ".internal")
  await ensureDir(dir)
  const path = resolveExtraHostsPath(project.projectDir)

  const existing = await readInternalExtraHosts(path)
  existing[hostname] = target
  await writeInternalExtraHosts(path, existing)

  logger.success({ message: `Set internal extra_hosts: ${hostname} -> ${target}` })
  logger.info({ message: `Next: run \`hack restart\` (or \`hack up\`) to apply.` })
  return 0
}

async function handleExtraHostsUnset({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: CommandArgs<typeof internalOptions, readonly ["hostname"]>
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args)
  const project = await requireProject(startDir)

  const hostname = (args.positionals.hostname ?? "").trim()
  if (hostname.length === 0) throw new Error("hostname is required")

  const path = resolveExtraHostsPath(project.projectDir)
  const existing = await readInternalExtraHosts(path)
  if (!(hostname in existing)) {
    logger.warn({ message: `No internal extra_hosts entry for ${hostname}` })
    return 1
  }

  delete existing[hostname]
  await ensureDir(resolve(project.projectDir, ".internal"))
  await writeInternalExtraHosts(path, existing)

  logger.success({ message: `Removed internal extra_hosts: ${hostname}` })
  logger.info({ message: `Next: run \`hack restart\` (or \`hack up\`) to apply.` })
  return 0
}

async function handleExtraHostsList({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: InternalArgs
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args)
  const project = await requireProject(startDir)

  const path = resolveExtraHostsPath(project.projectDir)
  const map = await readInternalExtraHosts(path)

  process.stdout.write(`${JSON.stringify(map, null, 2)}\n`)
  return 0
}
