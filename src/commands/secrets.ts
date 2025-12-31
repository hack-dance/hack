import { confirm, isCancel, password, text } from "@clack/prompts"

import { secrets } from "bun"

import { logger } from "../ui/logger.ts"
import { defineCommand, defineOption, withHandler } from "../cli/command.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"

const DEFAULT_SECRETS_SERVICE = "hack-cli" as const

const optService = defineOption({
  name: "service",
  type: "string",
  long: "--service",
  valueHint: "<service>",
  description: "Override Bun.secrets service name",
  defaultValue: DEFAULT_SECRETS_SERVICE
} as const)

const secretsOptions = [optService] as const
const secretsPositionals = [{ name: "name", required: false }] as const

type SecretsArgs = CommandArgs<typeof secretsOptions, typeof secretsPositionals>

const setSpec = defineCommand({
  name: "set",
  summary: "Store a secret",
  group: "Secrets",
  options: secretsOptions,
  positionals: secretsPositionals,
  subcommands: []
} as const)

const getSpec = defineCommand({
  name: "get",
  summary: "Print a secret (exit 1 if missing)",
  group: "Secrets",
  options: secretsOptions,
  positionals: secretsPositionals,
  subcommands: []
} as const)

const deleteSpec = defineCommand({
  name: "delete",
  summary: "Delete a stored secret",
  group: "Secrets",
  options: secretsOptions,
  positionals: secretsPositionals,
  subcommands: []
} as const)

export const secretsCommand = defineCommand({
  name: "secrets",
  summary: "Manage secrets in OS keychain (Bun.secrets)",
  group: "Secrets",
  expandInRootHelp: true,
  options: secretsOptions,
  positionals: [],
  subcommands: [
    withHandler(setSpec, handleSecretsSet),
    withHandler(getSpec, handleSecretsGet),
    withHandler(deleteSpec, handleSecretsDelete)
  ]
} as const)

function resolveService(args: SecretsArgs): string {
  return args.options.service ?? DEFAULT_SECRETS_SERVICE
}

async function resolveName(positionals: readonly string[]): Promise<string> {
  const fromPos = (positionals[0] ?? "").trim()
  if (fromPos.length > 0) return fromPos

  const name = await text({
    message: "Secret name:",
    validate: value => {
      const v = value?.trim()
      if (!v) return "Required"
      return undefined
    }
  })
  if (isCancel(name)) throw new Error("Canceled")
  return name.trim()
}

async function handleSecretsSet({
  args
}: {
  readonly ctx: CliContext
  readonly args: SecretsArgs
}): Promise<number> {
  const service = resolveService(args)
  const name = await resolveName([args.positionals.name].filter(v => typeof v === "string"))

  const value = await password({
    message: `Value for "${name}" (${service}):`,
    validate: v => (!v || v.length === 0 ? "Required" : undefined)
  })
  if (isCancel(value)) return 1

  await secrets.set({ service, name, value })
  logger.success({
    message: `Stored secret "${name}" under service "${service}"`
  })
  return 0
}

async function handleSecretsGet({
  args
}: {
  readonly ctx: CliContext
  readonly args: SecretsArgs
}): Promise<number> {
  const service = resolveService(args)
  const name = await resolveName([args.positionals.name].filter(v => typeof v === "string"))

  const value = await secrets.get({ service, name })
  if (value === null) {
    logger.warn({ message: `No secret found for "${name}" (${service})` })
    return 1
  }

  // Print raw to stdout for piping (avoid extra formatting)
  process.stdout.write(`${value}\n`)
  return 0
}

async function handleSecretsDelete({
  args
}: {
  readonly ctx: CliContext
  readonly args: SecretsArgs
}): Promise<number> {
  const service = resolveService(args)
  const name = await resolveName([args.positionals.name].filter(v => typeof v === "string"))

  const ok = await confirm({
    message: `Delete secret "${name}" (${service})?`,
    initialValue: false
  })
  if (isCancel(ok)) return 1
  if (!ok) return 0

  const deleted = await secrets.delete({ service, name })
  if (!deleted) {
    logger.warn({
      message: `No secret found to delete for "${name}" (${service})`
    })
    return 1
  }

  logger.success({ message: `Deleted secret "${name}" (${service})` })
  return 0
}
