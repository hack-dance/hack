import { resolve } from "node:path"

import { isCancel, select } from "@clack/prompts"

import { buildInitAssistantReport, renderInitAssistantPrompt } from "../agents/init-assistant.ts"
import { renderAgentInitPatterns } from "../agents/init-patterns.ts"
import { renderAgentPrimer } from "../agents/primer.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { optPath } from "../cli/options.ts"
import { findProjectContext, findRepoRootForInit } from "../lib/project.ts"
import { openUrl } from "../lib/os.ts"
import { findExecutableInPath, run } from "../lib/shell.ts"
import { logger } from "../ui/logger.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"

type PrimeArgs = CommandArgs<readonly [], readonly []>
type PatternsArgs = CommandArgs<readonly [], readonly []>

const optClient = defineOption({
  name: "client",
  type: "string",
  long: "--client",
  short: "-c",
  valueHint: "<cursor|claude|codex|print>",
  description: "Open init prompt in an agent client (or print)"
} as const)

const initOptions = [optPath, optClient] as const

type InitArgs = CommandArgs<typeof initOptions, readonly []>

const primeSpec = defineCommand({
  name: "prime",
  summary: "Print agent primer text",
  group: "Agents",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const patternsSpec = defineCommand({
  name: "patterns",
  summary: "Print agent init patterns guide",
  group: "Agents",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const initSpec = defineCommand({
  name: "init",
  summary: "Print agent init prompt",
  group: "Agents",
  options: initOptions,
  positionals: [],
  subcommands: []
} as const)

export const agentCommand = defineCommand({
  name: "agent",
  summary: "Agent utilities",
  group: "Agents",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(primeSpec, handleAgentPrime),
    withHandler(patternsSpec, handleAgentPatterns),
    withHandler(initSpec, handleAgentInit)
  ]
} as const)

async function handleAgentPrime({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: PrimeArgs
}): Promise<number> {
  process.stdout.write(renderAgentPrimer())
  return 0
}

async function handleAgentPatterns({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: PatternsArgs
}): Promise<number> {
  process.stdout.write(renderAgentInitPatterns())
  return 0
}

async function handleAgentInit({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: InitArgs
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args.options.path)
  const repoRoot = await findRepoRootForInit(startDir)
  const report = await buildInitAssistantReport({ repoRoot })
  const prompt = renderInitAssistantPrompt({ report })

  const selection = await resolveInitClient({
    clientRaw: args.options.client,
    repoRoot
  })

  if (selection === "cancel") return 1

  if (!selection || selection === "print") {
    process.stdout.write(prompt)
    return 0
  }

  if (selection === "cursor") {
    return await openCursorPrompt({ prompt })
  }

  return await runCliPrompt({
    command: selection,
    prompt
  })
}

function resolveStartDir(ctx: CliContext, pathOpt: string | undefined): string {
  return pathOpt ? resolve(ctx.cwd, pathOpt) : ctx.cwd
}

type AgentInitClient = "cursor" | "claude" | "codex" | "print"
type AgentInitSelection = AgentInitClient | "cancel" | null

async function resolveInitClient(opts: {
  readonly clientRaw: string | undefined
  readonly repoRoot: string
}): Promise<AgentInitSelection> {
  const normalized = opts.clientRaw?.trim().toLowerCase()
  if (normalized) {
    if (isAgentInitClient({ value: normalized })) {
      return normalized as AgentInitClient
    }
    throw new CliUsageError(
      `Invalid --client "${opts.clientRaw}". Use cursor, claude, codex, or print.`
    )
  }

  if (!(process.stdin.isTTY && process.stdout.isTTY)) return null

  const choices = await buildClientOptions({ repoRoot: opts.repoRoot })
  const selection = await select({
    message: "Open hack init prompt in:",
    options: choices
  })
  if (isCancel(selection)) return "cancel"
  return selection
}

function isAgentInitClient(opts: { readonly value: string }): boolean {
  return (
    opts.value === "cursor" ||
    opts.value === "claude" ||
    opts.value === "codex" ||
    opts.value === "print"
  )
}

async function buildClientOptions(opts: {
  readonly repoRoot: string
}): Promise<Array<{ value: AgentInitClient; label: string; hint?: string }>> {
  const claudeAvailable = await findExecutableInPath("claude")
  const codexAvailable = await findExecutableInPath("codex")
  const hasProject = (await findProjectContext(opts.repoRoot)) !== null

  return [
    {
      value: "cursor",
      label: "Cursor (open deep link)"
    },
    {
      value: "claude",
      label: "Claude CLI",
      hint: claudeAvailable ? "opens a terminal session" : "CLI not found"
    },
    {
      value: "codex",
      label: "Codex CLI",
      hint: codexAvailable ? "opens a terminal session" : "CLI not found"
    },
    {
      value: "print",
      label: "Print prompt",
      hint: hasProject ? "useful for copy/paste" : "repo context may be incomplete"
    }
  ]
}

async function openCursorPrompt(opts: { readonly prompt: string }): Promise<number> {
  const deeplink = buildCursorDeepLink({ prompt: opts.prompt })
  const exitCode = await openUrl(deeplink)

  if (exitCode !== 0) {
    logger.warn({
      message: "Failed to open Cursor. Printing deep link + prompt instead."
    })
    process.stdout.write(`${deeplink}\n\n${opts.prompt}`)
    return exitCode
  }

  process.stdout.write(`${deeplink}\n`)
  return 0
}

async function runCliPrompt(opts: {
  readonly command: "claude" | "codex"
  readonly prompt: string
}): Promise<number> {
  const resolved = await findExecutableInPath(opts.command)
  if (!resolved) {
    logger.warn({
      message: `${opts.command} CLI not found on PATH. Printing prompt instead.`
    })
    process.stdout.write(opts.prompt)
    return 1
  }

  return await run([opts.command, opts.prompt], { stdin: "inherit" })
}

function buildCursorDeepLink(opts: { readonly prompt: string }): string {
  const baseUrl = "cursor://anysphere.cursor-deeplink/prompt"
  const url = new URL(baseUrl)
  url.searchParams.set("text", opts.prompt)
  return url.toString()
}
