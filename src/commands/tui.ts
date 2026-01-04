import { resolve } from "node:path"

import { optPath, optProject } from "../cli/options.ts"
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts"
import { resolveRegisteredProjectByName, upsertProjectRegistration } from "../lib/projects-registry.ts"
import { findProjectContext, sanitizeProjectSlug } from "../lib/project.ts"
import { runHackTui } from "../tui/hack-tui.ts"
import { logger } from "../ui/logger.ts"

import type { ProjectContext } from "../lib/project.ts"
import type { CliContext, CommandArgs } from "../cli/command.ts"

const options = [optPath, optProject] as const

const tuiSpec = defineCommand({
  name: "tui",
  summary: "Open the project TUI (services + logs)",
  group: "Project",
  options,
  positionals: [],
  subcommands: []
} as const)

export const tuiCommand = withHandler(tuiSpec, handleTui)

type TuiArgs = CommandArgs<typeof options, readonly []>

async function handleTui({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: TuiArgs
}): Promise<number> {
  if (!process.stdout.isTTY) {
    logger.error({ message: "TUI requires a TTY. Run this from an interactive terminal." })
    return 1
  }

  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  return await runHackTui({ project })
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

  const startDir = opts.pathOpt ? resolve(opts.ctx.cwd, opts.pathOpt) : opts.ctx.cwd
  const project = await requireProjectContext(startDir)
  await touchProjectRegistration(project)
  return project
}

async function requireProjectContext(startDir: string): Promise<ProjectContext> {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    throw new Error("No .hack/ (or legacy .dev/) found. Run: hack init")
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
