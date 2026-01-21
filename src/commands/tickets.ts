import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { loadExtensionManagerForCli } from "../control-plane/extensions/cli.ts";
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

  if (!extension.enabled) {
    await display.panel({
      title: "Extension disabled",
      tone: "warn",
      lines: [
        `Extension: ${extension.manifest.id}`,
        "Enable with:",
        "  hack config set 'controlPlane.extensions[\"dance.hack.tickets\"].enabled' true",
      ],
    });
    return 1;
  }

  // Parse command from raw argv
  const invocation = parseTicketsInvocation({ argv: args.raw.argv });

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
