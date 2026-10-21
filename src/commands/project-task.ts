import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import {
  optBranch,
  optEnv,
  optJson,
  optPath,
  optProject,
} from "../cli/options.ts";
import {
  type CliResult,
  emitCliResult,
  exitCodeForResult,
  HackCliError,
} from "../lib/cli-result.ts";
import {
  inspectTask,
  listTasks,
  type TaskInspectData,
  type TaskListData,
  type TaskTargetSelector,
} from "../lib/task-catalog.ts";
import { display } from "../ui/display.ts";

const optExpectGeneration = defineOption({
  name: "expectGeneration",
  type: "string",
  long: "--expect-generation",
  valueHint: "<id>",
  description:
    "Refuse unless the project's config generation still equals this id",
} as const);

const taskOptions = [
  optPath,
  optProject,
  optBranch,
  optEnv,
  optExpectGeneration,
  optJson,
] as const;

/**
 * `hack project task list|inspect`: read-only catalog of reviewed recipes
 * for existing repository scripts (HACK-1157). Nothing here executes a
 * task. Names, options and schemas are provisional; see
 * docs/reference/ax-task-catalog.md.
 */
const listSpec = defineCommand({
  name: "list",
  summary:
    "List reviewed task recipes and refusals for the target (read-only, provisional; runs nothing)",
  group: "Project",
  options: taskOptions,
  positionals: [],
  subcommands: [],
} as const);

const inspectSpec = defineCommand({
  name: "inspect",
  summary:
    "Show one reviewed task recipe: argv, service, env scope, effects and pins (read-only, provisional; runs nothing)",
  group: "Project",
  options: taskOptions,
  positionals: [{ name: "task", required: true }],
  subcommands: [],
} as const);

export const taskSpec = defineCommand({
  name: "task",
  summary:
    "Discover reviewed task recipes without running them (read-only, provisional)",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [listSpec, inspectSpec],
} as const);

type TaskOptionValues = {
  readonly project?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly env?: string;
  readonly expectGeneration?: string;
};

function selectorFrom(options: TaskOptionValues): TaskTargetSelector {
  return {
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.expectGeneration === undefined
      ? {}
      : { expectGeneration: options.expectGeneration }),
  };
}

/** JSON mode prints the envelope; human mode throws the closed refusal. */
function finish<T>(opts: {
  readonly json: boolean;
  readonly result: CliResult<T>;
}): T | number {
  if (opts.json) {
    emitCliResult({ result: opts.result });
    return exitCodeForResult({ result: opts.result });
  }
  if (!opts.result.ok) {
    throw new HackCliError(opts.result.error);
  }
  return opts.result.data;
}

const handleList: CommandHandlerFor<typeof listSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const result = await listTasks({
    cwd: ctx.cwd,
    selector: selectorFrom(args.options),
  });
  const data = finish({ json: args.options.json === true, result });
  if (typeof data === "number") {
    return data;
  }
  await display.kv({ title: "Task catalog", entries: listEntries(data) });
  return 0;
};

const handleInspect: CommandHandlerFor<typeof inspectSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const result = await inspectTask({
    cwd: ctx.cwd,
    selector: selectorFrom(args.options),
    taskId: args.positionals.task,
  });
  const data = finish({ json: args.options.json === true, result });
  if (typeof data === "number") {
    return data;
  }
  await display.kv({ title: "Task", entries: inspectEntries(data) });
  return 0;
};

function listEntries(
  data: TaskListData
): readonly (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = [
    ["Project", data.target.project.name],
    ["Instance", data.target.instance.compose_project],
    ["Env overlay", data.target.env.overlay ?? "base"],
    ["Catalog", data.catalog.present ? "present" : "absent"],
    ["Execution", "unavailable (read-only catalog)"],
  ];
  for (const entry of data.tasks) {
    const label = entry.id ?? `#${entry.index}`;
    rows.push([
      label,
      entry.status === "reviewed"
        ? `reviewed: ${entry.recipe.summary}`
        : `refused: ${entry.refusal.reason}`,
    ]);
  }
  return rows;
}

function inspectEntries(
  data: TaskInspectData
): readonly (readonly [string, string])[] {
  const task = data.task;
  return [
    ["Task", task.id],
    ["Summary", task.summary],
    ["Service", task.runner.service],
    ["Argv", JSON.stringify(task.argv)],
    ["Workdir", task.workdir ?? "service default"],
    ["Env overlay", task.env.overlay ?? "base"],
    ["Env keys", task.env.keys.join(", ") || "-"],
    ["Requires", task.requires.join(", ") || "-"],
    ["Effects", task.effects.join(", ")],
    ["Review", task.provenance.review],
    ["Execution", "unavailable (read-only catalog)"],
  ];
}

export const taskCommand = {
  ...taskSpec,
  subcommands: [
    withHandler(listSpec, handleList),
    withHandler(inspectSpec, handleInspect),
  ],
} as const;
