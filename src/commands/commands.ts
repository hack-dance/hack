import type { CliContext, CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import {
  optBranch,
  optFollow,
  optJson,
  optPath,
  optProject,
} from "../cli/options.ts";
import { cancelCommand } from "../lib/background-command/cancel.ts";
import {
  commandNotFound,
  DEFAULT_READ_MAX_BYTES,
  inspectCommand,
  type LoadedJournal,
  loadJournal,
  MAX_READ_MAX_BYTES,
  MAX_WAIT_MS,
  MIN_READ_MAX_BYTES,
  type ProjectedEvent,
  type ReadResult,
  readCommandEvents,
} from "../lib/background-command/reader.ts";
import { emitCliResult, HackCliError, okResult } from "../lib/cli-result.ts";
import { instanceIdFor } from "./background-command-start.ts";
import {
  resolveEffectiveBranchForCommand,
  resolveProjectForArgs,
} from "./project.ts";

const optAfter = defineOption({
  name: "after",
  type: "string",
  long: "--after",
  valueHint: "<cursor>",
  description: "Read events after this cursor (default: from the start)",
} as const);

const optWaitMs = defineOption({
  name: "waitMs",
  type: "number",
  long: "--wait-ms",
  valueHint: "<ms>",
  description: `Wait up to this long for new events (0-${MAX_WAIT_MS}; default 0, or no limit with --follow)`,
} as const);

const optMaxBytes = defineOption({
  name: "maxBytes",
  type: "number",
  long: "--max-bytes",
  valueHint: "<n>",
  description: `Output text per read (${MIN_READ_MAX_BYTES}-${MAX_READ_MAX_BYTES}; default ${DEFAULT_READ_MAX_BYTES})`,
} as const);

const optFollowEvents = defineOption({
  ...optFollow,
  description: "Keep reading until the command ends",
} as const);

const scopeOptions = [optPath, optProject, optBranch] as const;
const idPositional = [{ name: "commandId", required: true }] as const;

const readSpec = defineCommand({
  name: "read",
  summary: "Read a background command's events and output from a cursor",
  group: "Project",
  options: [
    ...scopeOptions,
    optAfter,
    optFollowEvents,
    optWaitMs,
    optMaxBytes,
    optJson,
  ],
  positionals: idPositional,
  subcommands: [],
} as const);

const showSpec = defineCommand({
  name: "show",
  summary: "Show a background command's state, limits and outcome",
  group: "Project",
  options: [...scopeOptions, optJson],
  positionals: idPositional,
  subcommands: [],
} as const);

const cancelSpec = defineCommand({
  name: "cancel",
  summary: "Cancel a background command",
  group: "Project",
  options: [...scopeOptions, optJson],
  positionals: idPositional,
  subcommands: [],
} as const);

const commandsSpec = defineCommand({
  name: "commands",
  summary:
    "Read, inspect or cancel background commands started with `hack exec|run --detach`",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [readSpec, showSpec, cancelSpec],
} as const);

/**
 * An id grants nothing: the journal must belong to the project and instance
 * the caller selects with the same rules as `hack exec`. A mismatch reads as
 * "not found", so ids of other projects are not confirmed to exist.
 */
async function loadScopedJournal(opts: {
  readonly ctx: CliContext;
  readonly commandId: string;
  readonly options: {
    readonly path?: string;
    readonly project?: string;
    readonly branch?: string;
    readonly json?: boolean;
  };
}): Promise<LoadedJournal> {
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: opts.options.path,
    projectOpt: opts.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: opts.options.branch,
    noticeToStderr: true,
  });
  const journal = await loadJournal({
    commandId: opts.commandId,
    inScope: (meta) =>
      meta.projectRoot === project.projectRoot &&
      meta.instanceId === instanceIdFor(branch),
  }).catch((error: unknown) => {
    if (error instanceof HackCliError && error.code === "E_USAGE") {
      throw commandNotFound();
    }
    throw error;
  });
  return journal;
}

function boundedNumber(opts: {
  readonly value: number | undefined;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly flag: string;
}): number {
  const value = opts.value ?? opts.fallback;
  if (
    !(Number.isSafeInteger(value) && value >= opts.min && value <= opts.max)
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `${opts.flag} must be an integer from ${opts.min} to ${opts.max}.`,
    });
  }
  return value;
}

function writeHumanEvent(event: ProjectedEvent): void {
  const { payload } = event;
  switch (event.type) {
    case "command.output": {
      if (typeof payload.text === "string") {
        (payload.stream === "stderr" ? process.stderr : process.stdout).write(
          payload.text
        );
      } else {
        process.stderr.write(
          `[hack: ${String(payload.length)} bytes of ${String(payload.stream)} withheld: ${String(payload.withheld)}]\n`
        );
      }
      return;
    }
    case "command.stalled":
      process.stderr.write(
        `[hack: no output for ${Math.round(Number(payload.idleMs) / 1000)}s; still running (advisory)]\n`
      );
      return;
    case "command.output_truncated":
      process.stderr.write(
        "[hack: capture limit reached; the command continues but further output is not stored]\n"
      );
      return;
    case "command.ended":
      process.stderr.write(
        `[hack: ended: ${String(payload.outcome)}${typeof payload.exitCode === "number" ? ` (exit ${payload.exitCode})` : ""}${typeof payload.reason === "string" ? `, ${payload.reason}` : ""}]\n`
      );
      return;
    case "gap":
      process.stderr.write(
        `[hack: cursor expired; earliest available cursor ${String(payload.earliestCursor)}]\n`
      );
      return;
    default:
      return;
  }
}

function readEndLine(result: ReadResult): Record<string, unknown> {
  return {
    type: "read.end",
    reason: result.endReason,
    commandId: result.commandId,
    state: result.state,
    nextCursor: result.nextCursor,
    gap: result.gap,
    timedOut: result.timedOut,
    ended: result.ended,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  };
}

const handleRead: CommandHandlerFor<typeof readSpec> = async ({
  ctx,
  args,
}) => {
  const journal = await loadScopedJournal({
    ctx,
    commandId: args.positionals.commandId,
    options: args.options,
  });
  const follow = args.options.follow === true;
  const maxBytes = boundedNumber({
    value: args.options.maxBytes,
    fallback: DEFAULT_READ_MAX_BYTES,
    min: MIN_READ_MAX_BYTES,
    max: MAX_READ_MAX_BYTES,
    flag: "--max-bytes",
  });
  const waitLimit =
    args.options.waitMs === undefined && follow
      ? Number.POSITIVE_INFINITY
      : boundedNumber({
          value: args.options.waitMs,
          fallback: 0,
          min: 0,
          max: follow ? Number.MAX_SAFE_INTEGER : MAX_WAIT_MS,
          flag: "--wait-ms",
        });
  const deadline = Date.now() + waitLimit;
  let after = args.options.after;
  for (;;) {
    const result = await readCommandEvents({
      journal,
      after,
      waitMs: Math.max(0, Math.min(MAX_WAIT_MS, deadline - Date.now())),
      maxBytes,
    });
    for (const event of result.events) {
      if (args.options.json === true) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        writeHumanEvent(event);
      }
    }
    after = result.nextCursor;
    const done =
      !follow ||
      result.ended ||
      result.gap ||
      (result.timedOut && Date.now() >= deadline);
    if (done) {
      if (args.options.json === true) {
        process.stdout.write(`${JSON.stringify(readEndLine(result))}\n`);
      } else if (!result.ended) {
        process.stderr.write(
          `[hack: ${result.endReason}; continue with --after ${result.nextCursor}]\n`
        );
      }
      return 0;
    }
  }
};

const handleShow: CommandHandlerFor<typeof showSpec> = async ({
  ctx,
  args,
}) => {
  const journal = await loadScopedJournal({
    ctx,
    commandId: args.positionals.commandId,
    options: args.options,
  });
  const data = await inspectCommand({ journal });
  if (args.options.json === true) {
    emitCliResult({ result: okResult({ data }) });
    return 0;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return 0;
};

const handleCancel: CommandHandlerFor<typeof cancelSpec> = async ({
  ctx,
  args,
}) => {
  const journal = await loadScopedJournal({
    ctx,
    commandId: args.positionals.commandId,
    options: args.options,
  });
  const data = await cancelCommand({ journal });
  if (args.options.json === true) {
    emitCliResult({ result: okResult({ data }) });
    return 0;
  }
  process.stdout.write(
    `${data.commandId}: ${data.alreadyEnded ? "already ended" : "cancel requested"}; outcome ${data.outcome}.${data.confirmed.containerProcess === "not_confirmed" ? " The process inside the container is not confirmed stopped." : ""}\n`
  );
  return 0;
};

export const commandsCommand = {
  ...commandsSpec,
  subcommands: [
    withHandler(readSpec, handleRead),
    withHandler(showSpec, handleShow),
    withHandler(cancelSpec, handleCancel),
  ],
} as const;
