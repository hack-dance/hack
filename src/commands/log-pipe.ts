import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";

import type { LogInputFormat, OutputStream } from "../ui/log-format.ts";
import { runPrettyLogPipe } from "../ui/log-pipe.ts";

const optFormat = defineOption({
  name: "format",
  type: "string",
  long: "--format",
  valueHint: "<auto|docker-compose|plain>",
  description: "How to parse incoming lines from stdin",
  defaultValue: "auto",
} as const);

const optStream = defineOption({
  name: "stream",
  type: "string",
  long: "--stream",
  valueHint: "<stdout|stderr>",
  description:
    "Treat stdin as stdout or stderr (stderr forces ERROR level + writes to stderr)",
  defaultValue: "stdout",
} as const);

const options = [optFormat, optStream] as const;

type LogPipeArgs = CommandArgs<typeof options, readonly []>;

const spec = defineCommand({
  name: "log-pipe",
  summary:
    "Read log lines from stdin and pretty-print them (best-effort JSON parsing)",
  group: "Diagnostics",
  options,
  positionals: [],
  subcommands: [],
} as const);

export const logPipeCommand = withHandler(spec, handleLogPipe);

async function handleLogPipe({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: LogPipeArgs;
}): Promise<number> {
  const format = parseFormat(args.options.format);
  const stream = parseStream(args.options.stream);
  return await runPrettyLogPipe({ format, stream });
}

function parseFormat(raw: string | undefined): LogInputFormat {
  const v = (raw ?? "auto").trim();
  if (v === "auto" || v === "docker-compose" || v === "plain") {
    return v;
  }
  throw new CliUsageError(`Invalid --format: ${v}`);
}

function parseStream(raw: string | undefined): OutputStream {
  const v = (raw ?? "stdout").trim();
  if (v === "stdout" || v === "stderr") {
    return v;
  }
  throw new CliUsageError(`Invalid --stream: ${v}`);
}
