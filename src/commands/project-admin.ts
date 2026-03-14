import { resolve } from "node:path";
import type { CommandHandlerFor } from "../cli/command.ts";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import {
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import { display } from "../ui/display.ts";

const ownerShowOptions = [optPath, optProject, optJson] as const;

const ownerShowSpec = defineCommand({
  name: "show",
  summary: "Show the explicit ownership for the current project",
  group: "Project",
  options: ownerShowOptions,
  positionals: [],
  subcommands: [],
} as const);

const ownerSpec = defineCommand({
  name: "owner",
  summary: "Inspect or manage project ownership",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [ownerShowSpec],
} as const);

const projectSpec = defineCommand({
  name: "project",
  summary: "Inspect or manage project metadata",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [ownerSpec],
} as const);

const handleOwnerShow: CommandHandlerFor<typeof ownerShowSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectTarget({
    cwd: ctx.cwd,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const config = await readProjectConfig(project);
  if (config.parseError) {
    const configPath = config.configPath ?? project.configFile;
    throw new Error(`Failed to parse ${configPath}: ${config.parseError}`);
  }
  const payload = {
    project_root: project.projectRoot,
    ownership: {
      mode: config.ownership.mode,
      owner_type: config.ownership.ownerType,
      owner_id: config.ownership.ownerId,
      managed_by: config.ownership.managedBy,
    },
  };

  if (args.options.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  await display.kv({
    entries: [
      ["Project root", payload.project_root],
      ["Ownership mode", payload.ownership.mode],
      ["Owner type", payload.ownership.owner_type],
      ["Owner id", payload.ownership.owner_id ?? ""],
      ["Managed by", payload.ownership.managed_by],
    ],
  });
  return 0;
};

const ownerCommand = {
  ...ownerSpec,
  subcommands: [withHandler(ownerShowSpec, handleOwnerShow)],
} as const;

export const projectCommand = {
  ...projectSpec,
  subcommands: [ownerCommand],
} as const;

async function resolveProjectTarget(input: {
  readonly cwd: string;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}) {
  if (input.pathOpt && input.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (input.projectOpt) {
    const name = sanitizeProjectSlug(input.projectOpt);
    if (name.length === 0) {
      throw new CliUsageError("Invalid --project value.");
    }
    const project = await resolveRegisteredProjectByName({ name });
    if (!project) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return project;
  }

  const startDir = input.pathOpt
    ? resolve(input.cwd, input.pathOpt)
    : input.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new Error(
      `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`
    );
  }
  return project;
}
