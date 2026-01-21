import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { printHelpForPath } from "../cli/help.ts";

const helpPositionals = [
  { name: "path", required: false, multiple: true },
] as const;

type HelpArgs = CommandArgs<readonly [], typeof helpPositionals>;

const helpSpec = defineCommand({
  name: "help",
  summary: "Show help for a command (e.g. hack help global logs)",
  group: "Diagnostics",
  options: [],
  positionals: helpPositionals,
  subcommands: [],
} as const);

export const helpCommand = withHandler(helpSpec, handleHelp);

async function handleHelp({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: HelpArgs;
}): Promise<number> {
  const parts = args.positionals.path;
  const path = Array.isArray(parts) ? parts : [];
  await printHelpForPath(ctx.cli, path);
  return 0;
}
