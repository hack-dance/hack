import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { emitCliResult } from "../lib/cli-result.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import { buildVersionReport } from "../lib/version-report.ts";

const versionSpec = defineCommand({
  name: "version",
  summary: "Print version",
  group: "Diagnostics",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

const handleVersion: CommandHandlerFor<typeof versionSpec> = async ({
  ctx,
  args,
}) => {
  if (args.options.json) {
    const report = await buildVersionReport({
      version: ctx.cli.version,
      executable: process.execPath,
      compiled: Bun.main.startsWith("/$bunfs/"),
    });
    emitCliResult({
      result: machineSuccess({ schema: MACHINE_SCHEMAS.version, data: report }),
    });
    return 0;
  }
  console.log(`${ctx.cli.name} v${ctx.cli.version}`);
  return 0;
};

export const versionCommand = withHandler(versionSpec, handleVersion);
