import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { loadExtensionManagerForCli } from "../control-plane/extensions/cli.ts";
import {
  buildEnableInstructions,
  maybeEnableExtension,
} from "../control-plane/extensions/enable.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

/**
 * Top-level tickets command that delegates to the tickets extension.
 * Provides convenient access to `hack x tickets` functionality.
 */
const ticketsSpec = defineCommand({
  name: "tickets",
  summary: "Git-backed ticket management",
  description: [
    "Usage:",
    "  hack tickets list",
    '  hack tickets create --title "..."',
    "  hack tickets show <ticket-id>",
    "  hack tickets status <ticket-id> <open|in_progress|blocked|done>",
    '  hack tickets update <ticket-id> [--title "..."] [--body "..."]',
    "  hack tickets sync",
    "  hack tickets setup",
    "  hack tickets tui",
    "",
    "Alias for `hack x tickets <command>`. Requires extension enabled.",
  ].join("\n"),
  group: "Project",
  options: [],
  positionals: [{ name: "args", required: false, multiple: true }],
  subcommands: [],
} as const);

type TicketsArgs = CommandArgs<readonly [], readonly []>;

export const ticketsCommand = withHandler(ticketsSpec, handleTickets);

async function handleTickets({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: TicketsArgs;
}): Promise<number> {
  // Parse command early to check if it's setup (which bypasses enable check)
  const invocation = parseTicketsInvocation({ argv: args.raw.argv });
  const isSetupCommand = invocation.command === "setup";

  const loaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });

  if (loaded.configError) {
    logger.warn({
      message: `Control plane config error: ${loaded.configError}`,
    });
  }
  for (const warning of loaded.warnings) {
    logger.warn({ message: warning });
  }

  const extension = loaded.manager.getExtensionByNamespace({
    namespace: "tickets",
  });
  if (!extension) {
    logger.error({ message: "Tickets extension not found. Is it registered?" });
    return 1;
  }

  // Allow setup command to run even when extension is disabled
  if (!(extension.enabled || isSetupCommand)) {
    const instructions = buildEnableInstructions({
      extension,
      namespace: "tickets",
      command: invocation.command,
      args: invocation.args,
    });

    await display.panel({
      title: "Extension disabled",
      tone: "warn",
      lines: instructions.lines,
    });

    // Offer interactive enable prompt
    const didEnable = await maybeEnableExtension({
      extension,
      namespace: "tickets",
      command: invocation.command,
      args: invocation.args,
      projectDir: loaded.context.project?.projectDir,
    });

    if (didEnable) {
      // Reload and continue with the original command
      const reloaded = await loadExtensionManagerForCli({ cwd: ctx.cwd });
      const nextExtension = reloaded.manager.getExtensionByNamespace({
        namespace: "tickets",
      });
      if (!nextExtension?.enabled) {
        logger.warn({
          message: "Extension still disabled after enable attempt.",
        });
        return 1;
      }

      if (!invocation.command || invocation.command === "help") {
        await renderTicketsHelp({
          commands: reloaded.manager.listCommands({ namespace: "tickets" }),
        });
        return 0;
      }

      const resolved = reloaded.manager.resolveCommand({
        namespace: "tickets",
        commandName: invocation.command,
      });
      if (!resolved) {
        logger.error({
          message: `Unknown tickets command: ${invocation.command}`,
        });
        return 1;
      }

      return await resolved.command.handler({
        ctx: reloaded.context,
        args: invocation.args,
      });
    }

    return 1;
  }

  if (!invocation.command || invocation.command === "help") {
    await renderTicketsHelp({
      commands: loaded.manager.listCommands({ namespace: "tickets" }),
    });
    return 0;
  }

  const resolved = loaded.manager.resolveCommand({
    namespace: "tickets",
    commandName: invocation.command,
  });

  if (!resolved) {
    logger.error({ message: `Unknown tickets command: ${invocation.command}` });
    await renderTicketsHelp({
      commands: loaded.manager.listCommands({ namespace: "tickets" }),
    });
    return 1;
  }

  return await resolved.command.handler({
    ctx: loaded.context,
    args: invocation.args,
  });
}

type TicketsInvocation = {
  readonly command?: string;
  readonly args: readonly string[];
};

function parseTicketsInvocation(opts: {
  readonly argv: readonly string[];
}): TicketsInvocation {
  const index = findTicketsIndex({ argv: opts.argv });
  if (index === -1) {
    return { args: [] };
  }

  const command = opts.argv[index + 1];
  const rawArgs = opts.argv.slice(index + 2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

  return { command, args };
}

function findTicketsIndex(opts: { readonly argv: readonly string[] }): number {
  for (let i = 0; i < opts.argv.length; i += 1) {
    const token = opts.argv[i] ?? "";
    if (token === "tickets") {
      return i;
    }
  }
  return -1;
}

async function renderTicketsHelp(opts: {
  readonly commands: readonly {
    readonly name: string;
    readonly summary: string;
    readonly commandId: string;
  }[];
}): Promise<void> {
  if (opts.commands.length === 0) {
    await display.panel({
      title: "Tickets",
      tone: "info",
      lines: ["No commands available."],
    });
    return;
  }

  await display.table({
    columns: ["Command", "Summary"],
    rows: opts.commands.map((cmd) => [`hack tickets ${cmd.name}`, cmd.summary]),
  });
}
