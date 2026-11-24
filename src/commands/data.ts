import { resolve } from "node:path";
import { formatNativeSourceBytes } from "../backends/native-project-source-size.ts";
import { buildComposeArgs } from "../backends/runtime-backend.ts";
import type { CliContext, CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { resolveRequestedEnvName } from "../cli/env-selection.ts";
import {
  optBranch,
  optEnv,
  optJson,
  optPath,
  optProject,
} from "../cli/options.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { resolveDataBackupDeadlines } from "../lib/data-backup-deadlines.ts";
import { createHostDataBackupDocker } from "../lib/data-backup-docker.ts";
import {
  type DataExportResult,
  exportProjectData,
} from "../lib/data-backup-export.ts";
import {
  type DataImportResult,
  importProjectData,
} from "../lib/data-backup-import.ts";
import { HACK_VERSION } from "../lib/hack-version.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import { scopedHackCommand } from "../lib/printed-shell-command.ts";
import { resolveEffectiveProjectName } from "../lib/project.ts";
import {
  type ComposeRuntimeModel,
  resolveComposeRuntimeModel,
  resolveEffectiveBranchForCommand,
  resolveProjectForArgs,
} from "./project.ts";

const optOut = defineOption({
  name: "out",
  type: "string",
  long: "--out",
  valueHint: "<dir>",
  description:
    "Parent directory for the backup (default: $HACK_HOME/data-backups/<hack project>[--<branch>])",
} as const);

const exportSpec = defineCommand({
  name: "export",
  summary: "Back up the project's Compose named volumes to verified tar files",
  group: "Project",
  description:
    "Copies each declared, non-external named volume that Docker labels as this project's into <backup>/<key>.tar, with a manifest of sizes and digests. The project must be stopped; Hack never stops it for you. External and foreign volumes are skipped and reported. Compose backend only. Restore with hack data import.",
  options: [optPath, optProject, optBranch, optEnv, optOut, optJson],
  positionals: [],
  subcommands: [],
} as const);

const optFromProject = defineOption({
  name: "fromProject",
  type: "string",
  long: "--from-project",
  valueHint: "<hack project>",
  description:
    "Restore a backup taken from another instance or project (a branch instance or a renamed project): the backup's Hack project name",
} as const);

const importSpec = defineCommand({
  name: "import",
  summary:
    "Restore a hack data export backup into the project's Compose volumes",
  group: "Project",
  description:
    "Verifies the backup (manifest, tar sizes and sha256), then restores each backed-up volume that is still declared here into its Docker volume and checks the restored tree against the recorded digest. Never overwrites data: a target that holds data or belongs to something else refuses. An absent target is created with Compose's labels. The project must be stopped. A rerun after an interruption replaces only this import's own partial copy. Compose backend only.",
  options: [optPath, optProject, optBranch, optEnv, optFromProject, optJson],
  positionals: [{ name: "backupDir", required: true }],
  subcommands: [],
} as const);

const dataSpec = defineCommand({
  name: "data",
  summary: "Back up and restore project volume data",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [exportSpec, importSpec],
} as const);

/**
 * Native data lives in the VM, not in Compose volumes; native support
 * arrives later. Same rule as requireNativeComposeBackend: an explicit
 * non-Compose backend refuses and the selection is left unchanged.
 */
export function requireComposeBackendForData(opts: {
  readonly command: "export" | "import";
  readonly backend: string | undefined;
}): void {
  if (opts.backend !== undefined && opts.backend !== "compose") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `hack data ${opts.command} works on Compose volumes and does not support the native backend yet. The selected runtime was not changed. Rerun with HACK_RUNTIME_BACKEND=compose to ${opts.command === "export" ? "back up" : "restore"} the project's Compose data.`,
    });
  }
}

/**
 * The project, instance and Docker boundary both data commands use: the
 * same project and branch resolution as other project commands, and the
 * managed Compose env `hack up` gives the project (it can select the engine).
 */
async function resolveDataContext(opts: {
  readonly ctx: CliContext;
  readonly command: "export" | "import";
  readonly options: {
    readonly path?: string;
    readonly project?: string;
    readonly branch?: string;
    readonly env?: string;
    readonly json?: boolean;
  };
}) {
  requireComposeBackendForData({
    command: opts.command,
    backend: process.env.HACK_RUNTIME_BACKEND,
  });
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: opts.options.path,
    projectOpt: opts.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: opts.options.branch,
    noticeToStderr: opts.options.json === true,
  });
  // Hack's project name (hack.config.json `name`, else the checkout): never
  // the resolved Compose project name, which can carry interpolated values.
  const projectName = await resolveEffectiveProjectName(project);
  // Refuse a malformed deadline override before anything runs.
  const deadlines = resolveDataBackupDeadlines();
  // Exactly the Compose invocation `hack up` builds for this instance (files,
  // project name, project directory and managed env, which can select the
  // engine), with every profile active so a profile-gated service's volume
  // is seen too.
  const model = await resolveComposeRuntimeModel({
    project,
    branch,
    envName: resolveRequestedEnvName({ envOption: opts.options.env }),
  });
  return {
    projectName,
    branch,
    deadlines,
    docker: createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
      captureTimeoutMs: deadlines.commandMs,
    }),
    composeArgs: dataComposeArgs(model),
    hackHome: resolveGlobalHackDir(),
    downCommand: scopedHackCommand("down", {
      path: opts.options.path,
      project: opts.options.project,
      branch: branch ?? undefined,
    }),
  };
}

const handleExport: CommandHandlerFor<typeof exportSpec> = async ({
  ctx,
  args,
}) => {
  const json = args.options.json === true;
  const context = await resolveDataContext({
    ctx,
    command: "export",
    options: args.options,
  });
  const result = await exportProjectData({
    docker: context.docker,
    deadlines: context.deadlines,
    composeArgs: context.composeArgs,
    project: context.projectName,
    branch: context.branch,
    hackHome: context.hackHome,
    outDir:
      args.options.out === undefined
        ? undefined
        : resolve(ctx.cwd, args.options.out),
    hackVersion: HACK_VERSION,
    downCommand: context.downCommand,
  });
  if (json) {
    emitCliResult({
      result: machineSuccess({
        schema: MACHINE_SCHEMAS.dataExport,
        data: result,
      }),
    });
  } else {
    process.stdout.write(renderDataExportText(result));
  }
  return 0;
};

const handleImport: CommandHandlerFor<typeof importSpec> = async ({
  ctx,
  args,
}) => {
  const context = await resolveDataContext({
    ctx,
    command: "import",
    options: args.options,
  });
  const result = await importProjectData({
    docker: context.docker,
    deadlines: context.deadlines,
    composeArgs: context.composeArgs,
    project: context.projectName,
    branch: context.branch,
    backupPath: resolve(ctx.cwd, args.positionals.backupDir),
    fromProject: args.options.fromProject,
    hackHome: context.hackHome,
    downCommand: context.downCommand,
  });
  if (args.options.json === true) {
    emitCliResult({
      result: machineSuccess({
        schema: MACHINE_SCHEMAS.dataImport,
        data: result,
      }),
    });
  } else {
    process.stdout.write(renderDataImportText(result));
  }
  return 0;
};

/** Text summary: each restored volume and how its target was prepared. */
export function renderDataImportText(result: DataImportResult): string {
  const how = {
    created: "created",
    empty: "existing empty volume",
    "replaced-partial": "replaced an interrupted import",
    "verified-complete": "already matches this backup",
  } as const;
  const restored = result.volumes.filter(
    (volume) => volume.outcome === "restored"
  ).length;
  let heading = `Restored ${restored} volume${restored === 1 ? "" : "s"} from ${result.backup}:`;
  if (result.volumes.length === 0) {
    heading = `Nothing to restore from ${result.backup}.`;
  } else if (restored === 0) {
    heading = `Nothing to restore: all volumes already match this backup (${result.backup}):`;
  }
  const lines = [heading];
  for (const volume of result.volumes) {
    lines.push(
      `  ${volume.key}  ${how[volume.target]}  ${volume.entries} entr${volume.entries === 1 ? "y" : "ies"} verified${socketNote(volume.excludedSockets)}`
    );
  }
  if (result.skipped.length > 0) {
    lines.push("Skipped:");
    for (const entry of result.skipped) {
      lines.push(
        `  ${entry.key}  ${entry.reason === "external" ? "external here, not managed by this project" : "no longer declared by this project"}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Sockets are runtime artifacts tar cannot archive; say how many were left out. */
export function socketNote(count: number): string {
  return count === 0
    ? ""
    : `, ${count} socket${count === 1 ? "" : "s"} not copied`;
}

/** Compose argv for a data command: the instance's model, all profiles on. */
export function dataComposeArgs(model: ComposeRuntimeModel): string[] {
  return buildComposeArgs({
    composeFiles: model.composeFiles,
    composeProject: model.composeProject,
    profiles: ["*"],
    cwd: model.cwd,
  });
}

/** Text summary: each copied volume, each skipped one with its reason, the path. */
export function renderDataExportText(result: DataExportResult): string {
  const { volumes, skipped } = result.manifest;
  const lines = [
    volumes.length === 0
      ? "No owned volume data to back up."
      : `Backed up ${volumes.length} volume${volumes.length === 1 ? "" : "s"}:`,
  ];
  for (const volume of volumes) {
    lines.push(
      `  ${volume.key}  ${formatNativeSourceBytes(volume.tarBytes)}  ${volume.entries} entr${volume.entries === 1 ? "y" : "ies"}${socketNote(volume.excludedSockets)}`
    );
  }
  const reasons = {
    external: "external, not managed by this project",
    foreign: "labels name another project, not read",
    absent: "not created yet, nothing to back up",
  } as const;
  if (skipped.length > 0) {
    lines.push("Skipped:");
    for (const entry of skipped) {
      lines.push(`  ${entry.key}  ${reasons[entry.reason]}`);
    }
  }
  lines.push(`Backup: ${result.backup}`);
  return `${lines.join("\n")}\n`;
}

export const dataCommand = {
  ...dataSpec,
  subcommands: [
    withHandler(exportSpec, handleExport),
    withHandler(importSpec, handleImport),
  ],
} as const;
