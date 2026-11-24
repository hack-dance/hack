import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import { planCatalogEdit } from "../lib/compose-catalog-edit.ts";
import { withEnvLayerLock } from "../lib/env-layer-lock.ts";
import {
  readAtomicWriteTargetText,
  writeTextFileAtomicIfChanged,
} from "../lib/fs.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import {
  assertLegacyProjectDirectory,
  ProjectInputSelectionError,
} from "../lib/project-input-selection.ts";
import { resolveProjectForArgs } from "./project.ts";

const addSpec = defineCommand({
  name: "add",
  summary: "Add a catalog service to the project's Compose file",
  group: "Project",
  options: [
    optPath,
    optProject,
    optJson,
    defineOption({
      name: "name",
      long: "--name",
      type: "string",
      valueHint: "<service>",
      description: "Use a custom Compose service name",
    }),
    defineOption({
      name: "dryRun",
      long: "--dry-run",
      type: "boolean",
      description: "Show the diff without saving",
    }),
    defineOption({
      name: "expectRevision",
      long: "--expect-revision",
      type: "string",
      valueHint: "<revision>",
      description: "Save only if the dry-run revision still matches",
    }),
  ],
  positionals: [
    {
      name: "catalog-id",
      required: true,
      description: "redis, postgres, mysql, mongodb, minio, or mailpit",
    },
  ],
  subcommands: [],
} as const);

function authoredCatalogRefusal(error: unknown): never {
  if (
    error instanceof ProjectInputSelectionError &&
    error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
  ) {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "This project uses .hack/hack.project.json. Add the service to its workloads, then use hack config validate and hack up.",
    });
  }
  throw error;
}

const addCommand = withHandler(addSpec, async ({ ctx, args }) => {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  }).catch(authoredCatalogRefusal);
  const { composeFile, projectRoot } = project;
  const directory = await realpath(projectRoot);
  const validatePath = async () => {
    await assertLegacyProjectDirectory({
      projectDir: project.projectDir,
    }).catch(authoredCatalogRefusal);
    const actual = await realpath(composeFile);
    const file = relative(projectRoot, composeFile);
    if (
      actual !== join(directory, file) ||
      !(await lstat(composeFile)).isFile()
    ) {
      throw new HackCliError({
        code: "E_PERMISSION",
        message: "Use a regular Compose file inside the project checkout.",
      });
    }
  };
  const dryRun = args.options.dryRun === true;
  const edit = async () => {
    await validatePath();
    const text = await readAtomicWriteTargetText(composeFile);
    if (text === null) {
      throw new HackCliError({
        code: "E_CONFIG_INVALID",
        message: "The selected project's Compose file is missing.",
      });
    }
    const plan = planCatalogEdit({
      text,
      file: relative(projectRoot, composeFile),
      id: args.positionals["catalog-id"],
      name: args.options.name,
    });
    if (
      args.options.expectRevision !== undefined &&
      args.options.expectRevision !== plan.revision
    ) {
      throw new HackCliError({
        code: "E_REQUEST_CONFLICT",
        message:
          "The Compose file changed after preview. Preview the edit again.",
      });
    }
    if (!dryRun) {
      await writeTextFileAtomicIfChanged(composeFile, plan.updated, {
        expectedExisting: text,
        noFollowTarget: true,
        validatePath,
      });
    }
    const { file, service, credentials, diff, revision } = plan;
    return { file, service, credentials, diff, revision, saved: !dryRun };
  };
  await validatePath();
  const result = dryRun
    ? await edit()
    : await withEnvLayerLock({ layerPath: composeFile, run: edit });
  if (args.options.json) {
    emitCliResult({
      result: machineSuccess({
        schema: MACHINE_SCHEMAS.serviceAdd,
        data: result,
      }),
    });
  } else if (dryRun) {
    process.stdout.write(result.diff);
  } else {
    process.stdout.write(`Saved locally (not committed): ${result.file}\n`);
    if (result.credentials.length > 0) {
      process.stdout.write(
        `Set ${result.credentials.join(", ")} under the ${result.service} service scope in Hack env before starting.\n`
      );
    }
  }
  return 0;
});

export const serviceCommand = defineCommand({
  name: "service",
  summary: "Manage catalog services in a Compose project",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [addCommand],
} as const);
