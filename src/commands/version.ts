import { defineCommand, withHandler } from "../cli/command.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"

type VersionArgs = CommandArgs<readonly [], readonly []>

const versionSpec = defineCommand({
  name: "version",
  summary: "Print version",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: []
} as const)

async function handleVersion({
  ctx
}: {
  readonly ctx: CliContext
  readonly args: VersionArgs
}): Promise<number> {
  console.log(`${ctx.cli.name} v${ctx.cli.version}`)
  return 0
}

export const versionCommand = withHandler(versionSpec, handleVersion)
