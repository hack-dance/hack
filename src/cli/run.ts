import { cancel } from "@clack/prompts"

import { CLI_SPEC } from "./spec.ts"
import { printHelpForPath } from "./help.ts"
import {
  CliUsageError,
  collectAllowedOptionNames,
  collectUnionOptionNames,
  hasHandler,
  parseCliArgv,
  parseOptionsForCommand,
  parsePositionalsForCommand,
  resolveCommand
} from "./command.ts"
import { logger } from "../ui/logger.ts"

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const cli = CLI_SPEC
    const allowUnknownOptions = isExtensionDispatch({ argv })
    const parsed = parseCliArgv(cli, argv, { allowUnknownOptions })

    const helpFlag = parsed.values["help"] === true
    const versionFlag = parsed.values["version"] === true

    if (versionFlag) {
      process.stdout.write(`${cli.name} v${cli.version}\n`)
      return 0
    }

    const resolved = resolveCommand(cli, parsed.positionals)

    if (helpFlag) {
      await printHelpForPath(cli, parsed.positionals)
      return 0
    }

    if (!resolved.command) {
      // No command matched; show root help.
      await printHelpForPath(cli, [])
      return parsed.positionals.length === 0 ? 1 : 1
    }

    const isExtensionDispatcher = resolved.command?.name === "x"
    if (!isExtensionDispatcher) {
      // Unknown options (not registered anywhere in the CLI)
      const unionOptNames = collectUnionOptionNames(cli)
      const unknownOptions = Object.keys(parsed.values).filter(k => !unionOptNames.has(k))
      if (unknownOptions.length > 0) {
        throw new CliUsageError(
          `Unknown option(s): ${unknownOptions.map(o => `--${o}`).join(", ")}`
        )
      }

      // Disallowed options for the resolved command
      const allowedForCommand = collectAllowedOptionNames(cli, resolved.command)
      const disallowed = Object.keys(parsed.values).filter(k => !allowedForCommand.has(k))
      if (disallowed.length > 0) {
        throw new CliUsageError(
          `Option(s) not valid for "${resolved.command.name}": ${disallowed.map(o => `--${o}`).join(", ")}`
        )
      }
    }

    // If the resolved command has no handler, it acts as a namespace.
    if (!hasHandler(resolved.command)) {
      const pathTokens = resolved.path.map(c => c.name)
      await printHelpForPath(cli, pathTokens)
      return 1
    }

    const opts = parseOptionsForCommand(resolved.command.options, parsed.values)
    const pos = parsePositionalsForCommand(
      resolved.command.positionals,
      resolved.remainingPositionals
    )

    return await resolved.command.handler({
      ctx: { cwd: process.cwd(), cli },
      args: {
        options: opts,
        positionals: pos,
        raw: { argv, positionals: resolved.remainingPositionals }
      }
    })
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      logger.error({ message: error.message })
      await printHelpForPath(CLI_SPEC, [])
      return 1
    }

    const message = error instanceof Error ? error.message : "Unknown error"
    cancel(message)
    if (error instanceof Error && error.stack) {
      logger.error({ message: error.stack })
    }
    return 1
  }
}

function isExtensionDispatch(opts: { readonly argv: readonly string[] }): boolean {
  for (const token of opts.argv) {
    if (token === "--") continue
    if (token.startsWith("-")) continue
    return token === "x"
  }
  return false
}
