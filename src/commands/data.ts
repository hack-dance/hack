import { resolve } from "node:path";
import { formatNativeSourceBytes } from "../backends/native-project-source-size.ts";
import { buildComposeArgs } from "../backends/runtime-backend.ts";
import type { CommandHandlerFor } from "../cli/command.ts";
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
    "Copies each declared, non-external named volume that Docker labels as this project's into <backup>/<key>.tar, with a manifest of sizes and digests. The project must be stopped; Hack never stops it for you. External and foreign volumes are skipped and reported. Compose backend only. Restore is not available yet.",
  options: [optPath, optProject, optBranch, optEnv, optOut, optJson],
  positionals: [],
  subcommands: [],
} as const);

const dataSpec = defineCommand({
  name: "data",
  summary: "Back up project volume data",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [exportSpec],
} as const);

/**
 * Native data lives in the VM, not in Compose volumes; the native export
 * arrives later. Same rule as requireNativeComposeBackend: an explicit
 * non-Compose backend refuses and the selection is left unchanged.
 */
export function requireComposeBackendForDataExport(
  backend: string | undefined
): void {
  if (backend !== undefined && backend !== "compose") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message:
        "hack data export reads Compose volumes and does not support the native backend yet. The selected runtime was not changed. Rerun with HACK_RUNTIME_BACKEND=compose to back up the project's Compose data.",
    });
  }
}

const handleExport: CommandHandlerFor<typeof exportSpec> = async ({
  ctx,
  args,
}) => {
  requireComposeBackendForDataExport(process.env.HACK_RUNTIME_BACKEND);
  const json = args.options.json === true;
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
  });
  // Exactly the Compose invocation `hack up` builds for this instance (files,
  // project name, project directory and managed env, which can select the
  // engine), with every profile active so a profile-gated service's volume
  // is seen too.
  // Refuse a malformed deadline override before anything runs.
  const deadlines = resolveDataBackupDeadlines();
  const model = await resolveComposeRuntimeModel({
    project,
    branch,
    envName: resolveRequestedEnvName({ envOption: args.options.env }),
  });
  const result = await exportProjectData({
    docker: createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
      captureTimeoutMs: deadlines.commandMs,
    }),
    deadlines,
    composeArgs: dataComposeArgs(model),
    project: await resolveEffectiveProjectName(project),
    branch,
    hackHome: resolveGlobalHackDir(),
    outDir:
      args.options.out === undefined
        ? undefined
        : resolve(ctx.cwd, args.options.out),
    hackVersion: HACK_VERSION,
    downCommand: scopedHackCommand("down", {
      path: args.options.path,
      project: args.options.project,
      branch: branch ?? undefined,
    }),
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
  subcommands: [withHandler(exportSpec, handleExport)],
} as const;
