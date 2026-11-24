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
import { currentCandidateLauncher } from "../lib/candidate-launcher.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import {
  cleanupDataHelpers,
  type DataCleanupResult,
} from "../lib/data-backup-cleanup.ts";
import { HELPER_NONCE_PATTERN } from "../lib/data-backup-cleanup-instruction.ts";
import { resolveDataBackupDeadlines } from "../lib/data-backup-deadlines.ts";
import { createHostDataBackupDocker } from "../lib/data-backup-docker.ts";
import {
  type DataExportResult,
  exportProjectData,
} from "../lib/data-backup-export.ts";
import { HACK_VERSION } from "../lib/hack-version.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import {
  canPrintPathSelector,
  printedShellCommand,
  scopedHackCommand,
} from "../lib/printed-shell-command.ts";
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

const optNonce = defineOption({
  name: "nonce",
  type: "string",
  long: "--nonce",
  valueHint: "<nonce>",
  description:
    "The io.hack.data-backup.nonce label value a data command's refusal named",
} as const);

const cleanupSpec = defineCommand({
  name: "cleanup",
  summary: "Remove a helper container a data command could not track",
  group: "Project",
  description:
    "Removes the containers labeled io.hack.data-backup.nonce=<nonce>, which a data command's refusal names when a helper create's outcome could not be reconciled, on the engine the project's managed env selects (as export resolves it), by ID with removal confirmed. Never removes a volume.",
  options: [optPath, optProject, optBranch, optEnv, optNonce, optJson],
  positionals: [],
  subcommands: [],
} as const);

const dataSpec = defineCommand({
  name: "data",
  summary: "Back up project volume data",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [exportSpec, cleanupSpec],
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
      hackCleanupCommand: dataCleanupCommand({
        path: args.options.path,
        project: args.options.project,
        branch: branch ?? undefined,
        env: args.options.env,
      }),
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

/**
 * The `hack data cleanup --nonce <nonce>` line for a data command's
 * selection (project, instance and `--env` when it had one), so cleanup
 * runs on the same engine. A path that looks like a pasted assignment is
 * left out, as for every printed command.
 */
export function dataCleanupCommand(selection: {
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly env?: string;
}): (nonce: string) => string {
  return (nonce) => {
    const argv = [currentCandidateLauncher().command, "data", "cleanup"];
    if (selection.path !== undefined && canPrintPathSelector(selection.path)) {
      argv.push(`--path=${selection.path}`);
    }
    for (const [name, value] of [
      ["project", selection.project],
      ["branch", selection.branch],
      ["env", selection.env],
    ] as const) {
      if (value !== undefined) {
        argv.push(`--${name}=${value}`);
      }
    }
    argv.push(`--nonce=${nonce}`);
    return printedShellCommand(argv);
  };
}

const handleCleanup: CommandHandlerFor<typeof cleanupSpec> = async ({
  ctx,
  args,
}) => {
  requireComposeBackendForDataExport(process.env.HACK_RUNTIME_BACKEND);
  const json = args.options.json === true;
  const nonce = args.options.nonce;
  if (nonce === undefined || !HELPER_NONCE_PATTERN.test(nonce)) {
    throw new HackCliError({
      code: "E_USAGE",
      message:
        "hack data cleanup needs --nonce <nonce>: the 32-character hex value of the io.hack.data-backup.nonce label a data command's refusal named.",
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
    noticeToStderr: json,
  });
  const deadlines = resolveDataBackupDeadlines();
  // The managed env exactly as export resolves it: the same engine.
  const model = await resolveComposeRuntimeModel({
    project,
    branch,
    envName: resolveRequestedEnvName({ envOption: args.options.env }),
  });
  const result = await cleanupDataHelpers({
    docker: createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
      captureTimeoutMs: deadlines.commandMs,
    }),
    nonce,
    deadlines,
  });
  if (result.unconfirmed.length > 0) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `Docker could not confirm the removal of ${result.unconfirmed.length} container${result.unconfirmed.length === 1 ? "" : "s"} labeled ${result.label} (${result.unconfirmed.map((id) => id.slice(0, 12)).join(", ")}); retry, or remove ${result.unconfirmed.length === 1 ? "it" : "them"} with \`docker rm -f <id>\`.`,
      detail: result,
    });
  }
  if (json) {
    emitCliResult({
      result: machineSuccess({
        schema: MACHINE_SCHEMAS.dataCleanup,
        data: result,
      }),
    });
  } else {
    process.stdout.write(renderDataCleanupText(result));
  }
  return 0;
};

/** Text summary of a cleanup: what was removed, or that nothing matched. */
export function renderDataCleanupText(result: DataCleanupResult): string {
  if (result.removed.length === 0) {
    return `No container is labeled ${result.label}; nothing to remove.\n`;
  }
  return `Removed ${result.removed.length} container${result.removed.length === 1 ? "" : "s"} labeled ${result.label}: ${result.removed.map((id) => id.slice(0, 12)).join(", ")}.\n`;
}

export const dataCommand = {
  ...dataSpec,
  subcommands: [
    withHandler(exportSpec, handleExport),
    withHandler(cleanupSpec, handleCleanup),
  ],
} as const;
