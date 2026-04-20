import type {
  CliContext,
  CommandArgs,
  PositionalSpec,
} from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { logger } from "../ui/logger.ts";

const removedArgsPositionals = [
  {
    name: "args",
    required: false,
    multiple: true,
    description: "Legacy subcommand and arguments",
  },
] as const satisfies readonly PositionalSpec[];

export function createRemovedSurfaceCommand(input: {
  readonly name: string;
  readonly summary: string;
  readonly replacement: string;
  readonly reason: string;
}) {
  return withHandler(
    defineCommand({
      name: input.name,
      summary: input.summary,
      description: [
        `Removed in v3: ${input.reason}`,
        "",
        `Migration: ${input.replacement}`,
      ].join("\n"),
      group: "Integrations",
      options: [] as const,
      positionals: removedArgsPositionals,
      subcommands: [] as const,
    } as const),
    ({
      args,
    }: {
      readonly ctx: CliContext;
      readonly args: CommandArgs<readonly [], typeof removedArgsPositionals>;
    }): Promise<number> => {
      const attempted =
        args.positionals.args.length > 0
          ? `${input.name} ${args.positionals.args.join(" ")}`
          : input.name;
      logger.error({
        message: [
          `\`hack ${attempted}\` was removed in v3.`,
          input.reason,
          `Migration: ${input.replacement}`,
        ].join(" "),
      });
      return Promise.resolve(1);
    }
  );
}
