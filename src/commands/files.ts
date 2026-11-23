import { buildComposeArgs } from "../backends/runtime-backend.ts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import { defineCommand, withHandler } from "../cli/command.ts";
import { optBranch, optJson, optPath, optProject } from "../cli/options.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import {
  branchComposeProjectName,
  resolveComposeProjectName,
} from "../lib/compose-project-name.ts";
import { resolveHackEnv } from "../lib/hack-env.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import { readProjectConfig } from "../lib/project.ts";
import { resolveProjectEnvConfig } from "../lib/project-env-config.ts";
import { readServiceFiles } from "../lib/service-files.ts";
import { TARGET_SERVICE_PATTERN } from "../lib/target-inspect.ts";
import {
  desktopComposeTarget,
  optExpectComposeProject,
  resolveCommandComposeBase,
  resolveEffectiveBranchForCommand,
  resolveProjectForArgs,
  resolveStoredComposeLifecycleKey,
  resolveStoredRuntimeEnvName,
} from "./project.ts";

const options = [
  optBranch,
  optPath,
  optProject,
  optExpectComposeProject,
  optJson,
] as const;
const positionals = [
  { name: "service", required: true },
  { name: "container-path", required: true },
] as const;

const ls = defineCommand({
  name: "ls",
  summary: "List a running service's files and their mount sources",
  group: "Project",
  options,
  positionals,
  subcommands: [],
} as const);

const cat = defineCommand({
  ...ls,
  name: "cat",
  summary: "Read a file from a running service",
} as const);

async function runFiles(
  operation: "ls" | "cat",
  ctx: CliContext,
  args: CommandArgs<typeof options, typeof positionals>
): Promise<number> {
  const service = args.positionals.service;
  const path = args.positionals["container-path"];
  if (!(TARGET_SERVICE_PATTERN.test(service) && path.length > 0)) {
    throw new HackCliError({
      code: "E_USAGE",
      message: "Provide a Compose service name and a container path.",
    });
  }
  if (process.env.HACK_RUNTIME_BACKEND === "native") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: "Files are available for running Compose services.",
    });
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: args.options.json === true,
  });
  const cfg = await readProjectConfig(project);
  const expected = args.options.expectComposeProject;
  const base = await resolveCommandComposeBase({
    project,
    cfg,
    expected,
    forBranch: branch !== null,
  });
  const composeProject = desktopComposeTarget({
    expected,
    base,
    computed: branch ? branchComposeProjectName({ base, branch }) : null,
  });
  const { projectName, lifecycleComposeProject } =
    await resolveStoredComposeLifecycleKey({
      project,
      branch,
      base,
      legacyBase:
        expected === undefined
          ? base
          : await resolveComposeProjectName({ project, cfg }),
    });
  const envName = await resolveStoredRuntimeEnvName({
    requestedEnvName: undefined,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  // Compose's project selection can come from either the invoked environment
  // or its own .env. Use the environment sources used by exec without its
  // migration prompts or generated-file writes.
  const modern = await resolveProjectEnvConfig({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName,
    serviceNames: [service],
  });
  const env =
    modern?.globalEnv ??
    (
      await resolveHackEnv({
        projectDir: project.projectDir,
        projectName,
        envName,
        allowKeyProvisioning: false,
      })
    ).envForCompose;
  const result = await readServiceFiles({
    operation,
    project,
    expectedProject: expected,
    composeArgs: buildComposeArgs({
      composeFiles: [project.composeFile],
      composeProject,
      cwd: project.projectDir,
      profiles: ["*"],
    }),
    env,
    service,
    path,
  });
  if (args.options.json) {
    emitCliResult({
      result: machineSuccess({
        schema: MACHINE_SCHEMAS.files,
        data: { service, ...result },
      }),
    });
  } else if (result.operation === "ls") {
    for (const entry of result.entries) {
      process.stdout.write(`${entry.source}\t${JSON.stringify(entry.name)}\n`);
    }
  } else if (result.encoding === "base64" || result.truncated) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "Use --json to read binary files or the first 64 KiB of large files.",
    });
  } else {
    process.stdout.write(result.content);
  }
  return 0;
}

const handleLs: CommandHandlerFor<typeof ls> = ({ ctx, args }) =>
  runFiles("ls", ctx, args);
const handleCat: CommandHandlerFor<typeof cat> = ({ ctx, args }) =>
  runFiles("cat", ctx, args);

export const filesCommand = defineCommand({
  name: "files",
  summary: "Browse files in a running Compose service",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [withHandler(ls, handleLs), withHandler(cat, handleCat)],
} as const);
