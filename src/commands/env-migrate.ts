import { resolve } from "node:path";
import {
  type CliContext,
  CliUsageError,
  type CommandArgs,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import {
  applyEnvMigration,
  cleanupEnvMigration,
  previewEnvCleanup,
  previewEnvMigration,
  rollbackEnvMigration,
} from "../lib/env-migration.ts";
import { envMigrationSnapshots } from "../lib/env-migration-snapshot.ts";
import { MissingProjectContextError } from "../lib/missing-project-error.ts";
import { findProjectContext, readProjectConfig } from "../lib/project.ts";
import { discoverComposeServiceNames } from "../lib/project-env-config.ts";

const optApply = defineOption({
  name: "apply",
  type: "boolean",
  long: "--apply",
  description:
    "Apply the previewed migration with a snapshot and resumable journal",
} as const);
const optCleanup = defineOption({
  name: "cleanup",
  type: "boolean",
  long: "--cleanup",
  description:
    "Preview later legacy cleanup; combine with --apply only after migration has completed",
} as const);
const optRollback = defineOption({
  name: "rollbackManifest",
  type: "string",
  long: "--rollback-manifest",
  valueHint: "<manifest>",
  description:
    "Restore the migration snapshot, refusing changes made afterward",
} as const);
const optAccept = defineOption({
  name: "acceptTrackedChanges",
  type: "boolean",
  long: "--accept-tracked-env-changes",
  description:
    "Consent to the displayed edits or removals of Git-tracked legacy env files",
} as const);
const optPreserve = defineOption({
  name: "preserveChanges",
  type: "boolean",
  long: "--preserve-changes",
  description:
    "With rollback, restore originals and retain later edits privately in the snapshot",
} as const);

const options = [
  optPath,
  optJson,
  optApply,
  optCleanup,
  optRollback,
  optAccept,
  optPreserve,
] as const;
const spec = defineCommand({
  name: "migrate",
  summary:
    "Preview, resume or undo project env migration; cleanup is a separate later step",
  group: "Integrations",
  options,
  positionals: [],
  subcommands: [],
} as const);

function validateMigrationOptions(
  opts: CommandArgs<typeof options, readonly []>["options"]
): void {
  if (
    opts.rollbackManifest !== undefined &&
    (opts.apply || opts.cleanup || opts.acceptTrackedChanges)
  ) {
    throw new CliUsageError(
      "--rollback-manifest cannot be combined with --apply, --cleanup or --accept-tracked-env-changes."
    );
  }
  if (opts.acceptTrackedChanges && !opts.apply) {
    throw new CliUsageError("--accept-tracked-env-changes requires --apply.");
  }
  if (opts.preserveChanges && !opts.rollbackManifest) {
    throw new CliUsageError("--preserve-changes requires --rollback-manifest.");
  }
}

export async function handleEnvMigrate({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof options, readonly []>;
}): Promise<number> {
  const opts = args.options;
  validateMigrationOptions(opts);
  const context = await findProjectContext(resolve(ctx.cwd, opts.path ?? "."));
  if (!context) {
    throw new MissingProjectContextError();
  }
  const config = await readProjectConfig(context);
  const project = {
    projectRoot: context.projectRoot,
    projectDir: context.projectDir,
    projectName: config.name ?? "project",
    serviceNames: await discoverComposeServiceNames({
      composeFile: context.composeFile,
    }),
  };
  let action = "preview";
  if (opts.apply) {
    action = "apply";
  }
  if (opts.cleanup) {
    action = "cleanup";
  }
  if (opts.rollbackManifest) {
    action = "rollback";
  }
  let data: unknown;
  if (opts.rollbackManifest) {
    data = await rollbackEnvMigration({
      project,
      manifestPath: resolve(ctx.cwd, opts.rollbackManifest),
      snapshots: await envMigrationSnapshots(),
      preserveChanges: opts.preserveChanges === true,
    });
  } else if (opts.apply) {
    data = await (opts.cleanup ? cleanupEnvMigration : applyEnvMigration)({
      project,
      acceptTrackedChanges: opts.acceptTrackedChanges === true,
      snapshots: await envMigrationSnapshots(),
    });
  } else {
    const preview = await (opts.cleanup
      ? previewEnvCleanup
      : previewEnvMigration)(project);
    data = {
      ...preview,
      action,
      dryRun: true,
      files: preview.files,
    };
  }
  if (opts.json) {
    emitCliResult({ result: okResult({ data }) });
    return 0;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

export const envMigrateCommand = withHandler(spec, handleEnvMigrate);
