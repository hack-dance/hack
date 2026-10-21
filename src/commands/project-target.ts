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
  emitCliResult,
  exitCodeForResult,
  HackCliError,
} from "../lib/cli-result.ts";
import {
  inspectTarget,
  type TargetInspectData,
} from "../lib/target-inspect.ts";
import { display } from "../ui/display.ts";

const optTargetService = defineOption({
  name: "service",
  type: "string",
  long: "--service",
  valueHint: "<service>",
  description: "Also resolve one Compose service of the target",
} as const);

const optExpectGeneration = defineOption({
  name: "expectGeneration",
  type: "string",
  long: "--expect-generation",
  valueHint: "<id>",
  description:
    "Refuse unless the project's config generation still equals this id",
} as const);

const targetOptions = [
  optPath,
  optProject,
  optBranch,
  optTargetService,
  optEnv,
  optExpectGeneration,
  optJson,
] as const;

/**
 * `hack project target`: read-only target inspector (HACK-1144). The name,
 * options and result schema are provisional until the AX compatibility
 * review; see docs/reference/ax-target-result-contract.md.
 */
export const targetSpec = defineCommand({
  name: "target",
  summary:
    "Inspect the exact project, checkout, instance and service a command would target (read-only, provisional)",
  group: "Project",
  options: targetOptions,
  positionals: [],
  subcommands: [],
} as const);

const handleTarget: CommandHandlerFor<typeof targetSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const options = args.options;
  const result = await inspectTarget({
    cwd: ctx.cwd,
    selector: {
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.service === undefined ? {} : { service: options.service }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.expectGeneration === undefined
        ? {}
        : { expectGeneration: options.expectGeneration }),
    },
  });

  if (options.json === true) {
    emitCliResult({ result });
    return exitCodeForResult({ result });
  }
  if (!result.ok) {
    throw new HackCliError(result.error);
  }
  await display.kv({ title: "Target", entries: targetEntries(result.data) });
  return 0;
};

function targetEntries(
  data: TargetInspectData
): readonly (readonly [string, string])[] {
  return [
    ["Project", data.project.name],
    [
      "Registration",
      data.project.registration
        ? `${data.project.registration.id} (${data.project.registration.match})`
        : "unregistered",
    ],
    ["Checkout", `${data.checkout.root} (${data.checkout.kind})`],
    ["Git branch", data.checkout.git_branch ?? "-"],
    ["Instance", `${data.instance.compose_project} (${data.instance.source})`],
    ["Service", data.service?.name ?? "-"],
    ["Env overlay", `${data.env.overlay ?? "base"} (${data.env.source})`],
    ["Generation", data.generation.id],
    ["Runtime", "not probed"],
  ];
}

export const targetCommand = withHandler(targetSpec, handleTarget);
