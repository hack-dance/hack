import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import {
  ACTIVITY_READ_LIMIT_MAX,
  ACTIVITY_SCHEMA_VERSION,
  type ActivityRecord,
  readActivity,
} from "../lib/activity-log.ts";
import { emitCliResult, errorResult, okResult } from "../lib/cli-result.ts";

const WHOLE_NUMBER = /^[1-9][0-9]*$/;

/** Entries returned when `--limit` is not given. */
export const ACTIVITY_DEFAULT_LIMIT = 50;

const optActivityProject = defineOption({
  name: "project",
  type: "string",
  long: "--project",
  valueHint: "<name>",
  description:
    "Only entries for this project name (canonical-name aliases accepted)",
} as const);

const optLimit = defineOption({
  name: "limit",
  type: "string",
  long: "--limit",
  valueHint: "<n>",
  description: `Most entries to show, newest first (default ${ACTIVITY_DEFAULT_LIMIT}, at most ${ACTIVITY_READ_LIMIT_MAX})`,
} as const);

const activityOptions = [optJson, optActivityProject, optLimit] as const;

type ActivityArgs = CommandArgs<typeof activityOptions, readonly []>;

const activitySpec = defineCommand({
  name: "activity",
  summary: "Show recent up, down and restart actions (newest first)",
  group: "Project",
  options: activityOptions,
  positionals: [],
  subcommands: [],
} as const);

export function parseActivityLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return ACTIVITY_DEFAULT_LIMIT;
  }
  const value = raw.trim();
  if (!WHOLE_NUMBER.test(value) || Number(value) > ACTIVITY_READ_LIMIT_MAX) {
    throw new CliUsageError(
      `--limit must be a whole number from 1 to ${ACTIVITY_READ_LIMIT_MAX}.`
    );
  }
  return Number(value);
}

async function handleActivity({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ActivityArgs;
}): Promise<number> {
  const json = args.options.json === true;
  let entries: readonly ActivityRecord[];
  try {
    const limit = parseActivityLimit(args.options.limit);
    entries = await readActivity({
      limit,
      ...(args.options.project === undefined
        ? {}
        : { project: args.options.project }),
    });
  } catch (error: unknown) {
    const usage = error instanceof CliUsageError;
    const message = usage
      ? error.message
      : "Cannot read the activity log (it is not this user's regular file, or it could not be read).";
    if (json) {
      emitCliResult({
        result: errorResult({
          code: usage ? "E_USAGE" : "E_PATH_CONFLICT",
          message,
        }),
      });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }
  if (json) {
    emitCliResult({
      result: okResult({ data: { version: ACTIVITY_SCHEMA_VERSION, entries } }),
    });
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("No activity recorded yet.\n");
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(`${formatActivityLine(entry)}\n`);
  }
  return 0;
}

function formatActivityLine(entry: ActivityRecord): string {
  const target = entry.project
    ? `${entry.project}${entry.branch ? ` (${entry.branch})` : ""}`
    : "(unregistered project)";
  const failed =
    entry.failed_services.length > 0
      ? `  failed: ${entry.failed_services.join(", ")}`
      : "";
  const seconds = (entry.duration_ms / 1000).toFixed(1);
  return `${entry.ts}  ${entry.action.padEnd(7)}  ${entry.outcome.padEnd(11)}  ${entry.origin.padEnd(9)}  ${seconds}s  ${target}${failed}`;
}

export const activityCommand = withHandler(activitySpec, handleActivity);
