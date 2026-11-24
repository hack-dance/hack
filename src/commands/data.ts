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
import { currentCandidateLauncher } from "../lib/candidate-launcher.ts";
import { emitCliResult, HackCliError } from "../lib/cli-result.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import {
  cleanupWithSettle,
  type DataCleanupResult,
} from "../lib/data-backup-cleanup.ts";
import { HELPER_NONCE_PATTERN } from "../lib/data-backup-cleanup-instruction.ts";
import { resolveDataBackupDeadlines } from "../lib/data-backup-deadlines.ts";
import { createHostDataBackupDocker } from "../lib/data-backup-docker.ts";
import {
  type DataExportResult,
  exportProjectData,
} from "../lib/data-backup-export.ts";
import { TIMED_OUT_CREATE_SETTLE_MS } from "../lib/data-backup-held-volume.ts";
import {
  type DataImportResult,
  importProjectData,
} from "../lib/data-backup-import.ts";
import { engineUnreachableError } from "../lib/data-backup-volumes.ts";
import {
  cleanupRecordError,
  type DataCleanupEngineSource,
  endpointDigest,
  engineSource,
  readDaemonId,
  readDataCleanupRecord,
  removeDataCleanupRecord,
} from "../lib/data-cleanup-record.ts";
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
    "Removes the containers labeled io.hack.data-backup.nonce=<nonce>, which a data command's refusal names when a helper create's outcome could not be reconciled. Reads the run's cleanup record under $HACK_HOME/data-cleanup/ for its env selection and engine, and refuses (E_DATA_CLEANUP_RECORD, no engine call) unless the project's managed env still resolves to the same engine. Removes by ID with removal confirmed; never removes a volume.",
  options: [optPath, optProject, optBranch, optNonce, optJson],
  positionals: [],
  subcommands: [],
} as const);

const dataSpec = defineCommand({
  name: "data",
  summary: "Back up and restore project volume data",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [exportSpec, importSpec, cleanupSpec],
} as const);

/**
 * Native data lives in the VM, not in Compose volumes; native support
 * arrives later. Same rule as requireNativeComposeBackend: an explicit
 * non-Compose backend refuses and the selection is left unchanged.
 */
export function requireComposeBackendForData(opts: {
  readonly command: "export" | "import" | "cleanup";
  readonly backend: string | undefined;
}): void {
  if (opts.backend !== undefined && opts.backend !== "compose") {
    throw new HackCliError({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: `hack data ${opts.command} works on Compose volumes and does not support the native backend yet. The selected runtime was not changed. Rerun with HACK_RUNTIME_BACKEND=compose to ${{ export: "back up", import: "restore", cleanup: "clean up" }[opts.command]} the project's Compose data.`,
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
  readonly command: "export" | "import" | "cleanup";
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
      hackCleanupCommand: dataCleanupCommand({
        path: opts.options.path,
        project: opts.options.project,
        branch: branch ?? undefined,
      }),
    }),
    // Kept in the run's cleanup record, so cleanup resolves the same env.
    envSelection: model.envSelection,
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
    envSelection: context.envSelection,
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
    envSelection: context.envSelection,
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
export function dataComposeArgs(
  model: Pick<ComposeRuntimeModel, "composeFiles" | "composeProject" | "cwd"> &
    Partial<ComposeRuntimeModel>
): string[] {
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
}): (nonce: string) => string {
  return (nonce) => {
    const argv = [currentCandidateLauncher().command, "data", "cleanup"];
    if (selection.path !== undefined && canPrintPathSelector(selection.path)) {
      argv.push(`--path=${selection.path}`);
    }
    for (const [name, value] of [
      ["project", selection.project],
      ["branch", selection.branch],
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
  requireComposeBackendForData({
    command: "cleanup",
    backend: process.env.HACK_RUNTIME_BACKEND,
  });
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
  const hackHome = resolveGlobalHackDir();
  // The run's record, not an argument, says how it reached its engine.
  const record = await readDataCleanupRecord({ hackHome, nonce });
  const projectName = await resolveEffectiveProjectName(project);
  if (record.project !== projectName || record.branch !== branch) {
    throw cleanupRecordError({
      nonce,
      why: `it was made for another project or instance than this command selects (pass the same --path, --project or --branch the ${record.command} used)`,
    });
  }
  // The managed env through the recorded selection: the same engine.
  const model = await resolveComposeRuntimeModel({
    project,
    branch,
    envName: record.envDefault ? undefined : record.envName,
  });
  const docker = createHostDataBackupDocker({
    env: model.env,
    cwd: model.cwd,
    captureTimeoutMs: deadlines.commandMs,
  });
  const source = engineSource({
    docker,
    envName: record.envDefault ? null : record.envName,
  });
  if (JSON.stringify(source) !== JSON.stringify(record.engine)) {
    throw cleanupRecordError({
      nonce,
      why: `the setting that selects the engine changed since the ${record.command} (it now comes from ${describeEngineSource(source)}, the record says ${describeEngineSource(record.engine)})`,
    });
  }
  // Local CLI reads only (a context's endpoints), never an engine call.
  if ((await endpointDigest(docker)) !== record.endpointSha256) {
    throw cleanupRecordError({
      nonce,
      why: `the engine this project's env now selects is not the one the ${record.command} used (its endpoint digest differs)`,
    });
  }
  // The positive proof: the daemon this client reaches is the one the run
  // recorded. Read before any listing or removal.
  const daemon = await readDaemonId({
    docker,
    timeoutMs: deadlines.commandMs,
  });
  if (daemon.kind === "unreachable") {
    throw engineUnreachableError("hack data cleanup");
  }
  if (daemon.kind !== "read") {
    throw cleanupRecordError({
      nonce,
      why: "the Docker engine's ID could not be read (docker info), so the engine this project's env reaches cannot be proven to be the one the run used",
    });
  }
  if (daemon.id !== record.daemonId) {
    throw cleanupRecordError({
      nonce,
      why: `the Docker engine this project's env reaches is not the one the ${record.command} used (its daemon ID differs)`,
    });
  }
  const { result, settled } = await cleanupWithSettle({
    docker,
    nonce,
    deadlines,
    unresolvedCreates: record.unresolvedCreates ?? [],
    settleMs: TIMED_OUT_CREATE_SETTLE_MS,
  });
  if (settled) {
    await removeDataCleanupRecord({ hackHome, nonce });
  } else if (result.listed.length === 0) {
    // A timed-out create of that run may still land: keep the record.
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `No container is labeled ${result.label} yet, but the run had a create whose outcome is unknown and Hack could not prove it will not land (its event watch did not stay live, or a create was seen). The cleanup record was kept; retry \`hack data cleanup --nonce ${nonce}\`.`,
      detail: { ...result, outcome: "unknown" },
    });
  }
  if (result.unconfirmed.length > 0) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `Hack could not verify or confirm the removal of ${result.unconfirmed.length} container${result.unconfirmed.length === 1 ? "" : "s"} labeled ${result.label} (${result.unconfirmed.map((id) => id.slice(0, 12)).join(", ")}); retry the same \`hack data cleanup --nonce ${result.nonce}\`.`,
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
  // Only an empty listing is a no-op: never when Docker listed a container.
  if (result.listed.length === 0) {
    return `No container is labeled ${result.label}; nothing to remove.\n`;
  }
  return `Removed ${result.removed.length} container${result.removed.length === 1 ? "" : "s"} labeled ${result.label}: ${result.removed.map((id) => id.slice(0, 12)).join(", ")}.\n`;
}

/** A record's engine source in words (names a context, never an endpoint). */
function describeEngineSource(source: DataCleanupEngineSource): string {
  if (source.kind === "managed-context") {
    return `the managed DOCKER_CONTEXT ${source.context}`;
  }
  if (source.kind === "managed-host") {
    return `a managed DOCKER_HOST (env ${source.overlay ?? "base"})`;
  }
  return "the caller's own Docker settings";
}

export const dataCommand = {
  ...dataSpec,
  subcommands: [
    withHandler(exportSpec, handleExport),
    withHandler(importSpec, handleImport),
    withHandler(cleanupSpec, handleCleanup),
  ],
} as const;
