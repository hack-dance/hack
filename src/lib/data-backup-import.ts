import { HackCliError } from "./cli-result.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import type { DataBackupVolume } from "./data-backup-format.ts";
import {
  dataBackupHelperArgv,
  foreignVolumeMounts,
  helperContainerName,
  helperFailure,
  parseJsonText,
  refuseRunning,
  treeDigest,
} from "./data-backup-helper.ts";
import { type VerifiedBackup, verifyDataBackup } from "./data-backup-verify.ts";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_VOLUME_LABEL,
  composeOwnsVolume,
  type DeclaredVolumePlan,
  dockerReadError,
  inspectVolume,
  planDeclaredVolumes,
} from "./data-backup-volumes.ts";
import {
  type DataImportJournal,
  dataImportJournalPath,
  readDataImportJournal,
  writeDataImportJournal,
} from "./data-import-journal.ts";

/** Names the backup a volume created by `hack data import` restores. */
export const DATA_IMPORT_SOURCE_LABEL = "io.hack.data-backup.source";
const COMPOSE_VERSION_LABEL = "com.docker.compose.version";
const COMPOSE_VERSION = /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/;

export type DataImportInput = {
  readonly docker: DataBackupDocker;
  /** `docker compose -p … --project-directory … -f …`, as other commands build it. */
  readonly composeArgs: readonly string[];
  readonly backupPath: string;
  /** Required when the backup's Compose project differs from this one. */
  readonly fromProject?: string;
  readonly hackHome: string;
  readonly now?: () => Date;
  readonly downCommand?: string;
};

/** How a target was prepared before extraction. */
export type DataImportTargetKind = "created" | "empty" | "replaced-partial";

export type DataImportVolume = {
  readonly key: string;
  readonly name: string;
  readonly target: DataImportTargetKind;
  readonly entries: number;
  readonly excludedSockets: number;
  readonly contentDigest: string;
};

export type DataImportSkipped = {
  readonly key: string;
  readonly reason: "undeclared" | "external";
};

export type DataImportResult = {
  readonly backup: string;
  readonly backupId: string;
  readonly sourceComposeProject: string;
  readonly composeProject: string;
  readonly volumes: readonly DataImportVolume[];
  readonly skipped: readonly DataImportSkipped[];
};

type Target = {
  readonly volume: DataBackupVolume;
  readonly name: string;
  readonly journalPath: string;
  readonly kind: DataImportTargetKind;
};

export type DataTargetConflict = {
  readonly key: string;
  readonly name: string;
  readonly reason: "foreign" | "not_empty" | "already_imported";
};

/**
 * Restore a verified `hack data export` backup into this project's Compose
 * volumes.
 *
 * Every check runs before any effect: the backup (manifest, tar sizes and
 * sha256), the source project, the running refusal, and each target. A
 * target is the Docker volume of a backed-up key that is still a declared,
 * non-external named volume; it must be absent (created with Compose's own
 * labels plus {@link DATA_IMPORT_SOURCE_LABEL}), empty and labeled for this
 * project and key, or this import's own interrupted copy (same source label,
 * journal not complete), which is wiped and redone. Anything else refuses
 * with `E_DATA_TARGET_CONFLICT` and is never touched. After extraction the
 * tree digest must equal the manifest's; only then is the journal complete.
 */
export async function importProjectData(
  input: DataImportInput
): Promise<DataImportResult> {
  const clock = input.now ?? (() => new Date());
  const backup = await verifyDataBackup(input.backupPath);
  const config = await input.docker.capture([
    ...input.composeArgs,
    "config",
    "--format",
    "json",
  ]);
  if (config.exitCode !== 0) {
    throw dockerReadError({ result: config, command: "docker compose config" });
  }
  const plan = planDeclaredVolumes(parseJsonText(config.stdout));
  requireSourceProject({ backup, plan, fromProject: input.fromProject });
  const { selected, skipped } = selectTargets({ backup, plan });
  const stopCommand = input.downCommand ?? "hack down";
  const volumeNames = selected.map((entry) => entry.name);
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumeNames,
    stopCommand,
    command: "import",
    lead: "The project is running, so its volumes cannot be restored safely; nothing was changed.",
  });
  const helperNames = new Set<string>();
  const helperName = (): string => {
    const name = helperContainerName("import");
    helperNames.add(name);
    return name;
  };
  const targets = await prepareTargets({
    docker: input.docker,
    backup,
    plan,
    selected,
    hackHome: input.hackHome,
    helperName,
  });

  const since = clock();
  const composeVersion = targets.some((target) => target.kind === "created")
    ? await readComposeVersion(input.docker)
    : null;
  const volumes: DataImportVolume[] = [];
  for (const target of targets) {
    volumes.push(
      await restoreTarget({
        docker: input.docker,
        backup,
        composeProject: plan.composeProject,
        composeVersion,
        target,
        helperName,
        now: clock,
      })
    );
  }
  const mounts = await foreignVolumeMounts({
    docker: input.docker,
    since,
    until: clock(),
    volumeNames,
    helperNames,
  });
  if (mounts.length > 0) {
    throw new HackCliError({
      code: "E_PROJECT_RUNNING",
      message: `Another container (${[...new Set(mounts.map((m) => m.container.slice(0, 12)))].join(", ")}) mounted a target volume during the import, so the restore is not marked complete. Make sure nothing uses the project's volumes (\`${stopCommand}\`), then rerun hack data import, which replaces its own copy.`,
      detail: { mounts },
    });
  }
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumeNames,
    stopCommand,
    command: "import",
    lead: "A container started during the import, so the restore is not marked complete; rerunning hack data import after stopping it replaces its own copy.",
  });
  for (const target of targets) {
    await writeJournal({ backup, target, state: "complete", now: clock() });
  }
  return {
    backup: backup.path,
    backupId: backup.id,
    sourceComposeProject: backup.manifest.composeProject,
    composeProject: plan.composeProject,
    volumes,
    skipped,
  };
}

function requireSourceProject(opts: {
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
  readonly fromProject: string | undefined;
}): void {
  const source = opts.backup.manifest.composeProject;
  if (opts.fromProject !== undefined) {
    if (opts.fromProject !== source) {
      throw new HackCliError({
        code: "E_USAGE",
        message: `--from-project ${opts.fromProject} does not match the backup, which is from Compose project ${source}. Nothing was changed.`,
      });
    }
    return;
  }
  if (source !== opts.plan.composeProject) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `The backup is from Compose project ${source}, and this project is ${opts.plan.composeProject}. To restore it here (into a branch instance or a renamed project), rerun with --from-project ${source}. Nothing was changed.`,
    });
  }
}

/** Backed-up keys that are still declared, non-external volumes here. */
function selectTargets(opts: {
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
}): {
  readonly selected: readonly {
    readonly volume: DataBackupVolume;
    readonly name: string;
  }[];
  readonly skipped: readonly DataImportSkipped[];
} {
  const declared = new Map(
    opts.plan.declared.map((entry) => [entry.key, entry.name])
  );
  const external = new Set(opts.plan.external.map((entry) => entry.key));
  const selected: { volume: DataBackupVolume; name: string }[] = [];
  const skipped: DataImportSkipped[] = [];
  for (const volume of opts.backup.manifest.volumes) {
    const name = declared.get(volume.key);
    if (name !== undefined) {
      selected.push({ volume, name });
    } else {
      skipped.push({
        key: volume.key,
        reason: external.has(volume.key) ? "external" : "undeclared",
      });
    }
  }
  return { selected, skipped };
}

async function volumeIsEmpty(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  readonly helperName: () => string;
}): Promise<boolean> {
  const result = await opts.docker.capture(
    [
      ...dataBackupHelperArgv({
        name: opts.helperName(),
        volume: opts.name,
        readOnly: true,
        entrypoint: "find",
        purpose: "import",
      }),
      "/v",
      "-mindepth",
      "1",
      "-print",
      "-quit",
    ],
    { unbounded: true }
  );
  if (result.exitCode !== 0) {
    throw helperFailure({
      volume: opts.name,
      action: "inspect",
      result,
      consequence: "nothing was changed.",
    });
  }
  return result.stdout.trim() === "";
}

/** Classify every target before any effect; one refusal names all conflicts. */
async function prepareTargets(opts: {
  readonly docker: DataBackupDocker;
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
  readonly selected: readonly {
    readonly volume: DataBackupVolume;
    readonly name: string;
  }[];
  readonly hackHome: string;
  readonly helperName: () => string;
}): Promise<readonly Target[]> {
  const targets: Target[] = [];
  const conflicts: DataTargetConflict[] = [];
  for (const { volume, name } of opts.selected) {
    const journalPath = dataImportJournalPath({
      hackHome: opts.hackHome,
      composeProject: opts.plan.composeProject,
      key: volume.key,
    });
    const target = { volume, name, journalPath };
    const inspected = await inspectVolume({ docker: opts.docker, name });
    if (inspected === null) {
      targets.push({ ...target, kind: "created" });
      continue;
    }
    if (
      !composeOwnsVolume({
        volume: inspected,
        composeProject: opts.plan.composeProject,
        key: volume.key,
      })
    ) {
      conflicts.push({ key: volume.key, name, reason: "foreign" });
      continue;
    }
    if (
      await volumeIsEmpty({
        docker: opts.docker,
        name,
        helperName: opts.helperName,
      })
    ) {
      targets.push({ ...target, kind: "empty" });
      continue;
    }
    const journal = await readDataImportJournal(journalPath);
    const ours =
      inspected.labels[DATA_IMPORT_SOURCE_LABEL] === opts.backup.id &&
      journal !== null &&
      journal.backupId === opts.backup.id &&
      journal.target === name;
    if (ours && journal.state !== "complete") {
      targets.push({ ...target, kind: "replaced-partial" });
      continue;
    }
    conflicts.push({
      key: volume.key,
      name,
      reason: ours ? "already_imported" : "not_empty",
    });
  }
  if (conflicts.length > 0) {
    throw conflictError(conflicts);
  }
  return targets;
}

function conflictError(conflicts: readonly DataTargetConflict[]): HackCliError {
  const lines = conflicts.map((conflict) => {
    switch (conflict.reason) {
      case "foreign":
        return `${conflict.name} exists but its labels name another project or key, so Hack does not touch it`;
      case "already_imported":
        return `${conflict.name} already holds a completed restore of this backup`;
      default:
        return `${conflict.name} already holds data`;
    }
  });
  return new HackCliError({
    code: "E_DATA_TARGET_CONFLICT",
    message: `Refused to restore: ${lines.join("; ")}. Hack never overwrites or deletes data: move the volume aside (or remove it once you no longer need it), or back it up first with \`hack data export\`, then rerun. Nothing was changed.`,
    detail: { conflicts },
  });
}

async function readComposeVersion(docker: DataBackupDocker): Promise<string> {
  const result = await docker.capture([
    "docker",
    "compose",
    "version",
    "--short",
  ]);
  const match = COMPOSE_VERSION.exec(result.stdout);
  if (result.exitCode !== 0 || !match?.[1]) {
    throw dockerReadError({
      result: { ...result, exitCode: result.exitCode || 1 },
      command: "docker compose version",
    });
  }
  return match[1];
}

async function writeJournal(opts: {
  readonly backup: VerifiedBackup;
  readonly target: Target;
  readonly state: DataImportJournal["state"];
  readonly now: Date;
}): Promise<void> {
  await writeDataImportJournal({
    path: opts.target.journalPath,
    journal: {
      backupId: opts.backup.id,
      backup: opts.backup.path,
      key: opts.target.volume.key,
      target: opts.target.name,
      state: opts.state,
    },
    now: opts.now,
  });
}

/** Create or wipe, extract, digest; the journal is `started` throughout. */
async function restoreTarget(opts: {
  readonly docker: DataBackupDocker;
  readonly backup: VerifiedBackup;
  readonly composeProject: string;
  readonly composeVersion: string | null;
  readonly target: Target;
  readonly helperName: () => string;
  readonly now: () => Date;
}): Promise<DataImportVolume> {
  const { target, docker } = opts;
  const name = target.name;
  await writeJournal({ ...opts, state: "started", now: opts.now() });
  const recoverable = target.kind !== "empty";
  const partialNote = recoverable
    ? `the target ${name} may hold a partial copy; rerunning hack data import replaces it.`
    : `the target ${name} may hold a partial copy without Hack's import label, so a rerun refuses it: remove it with \`docker volume rm ${name}\` once you have checked it, then rerun.`;
  if (target.kind === "created") {
    const created = await docker.capture([
      "docker",
      "volume",
      "create",
      "--label",
      `${COMPOSE_PROJECT_LABEL}=${opts.composeProject}`,
      "--label",
      `${COMPOSE_VOLUME_LABEL}=${target.volume.key}`,
      "--label",
      `${COMPOSE_VERSION_LABEL}=${opts.composeVersion ?? ""}`,
      "--label",
      `${DATA_IMPORT_SOURCE_LABEL}=${opts.backup.id}`,
      name,
    ]);
    if (created.exitCode !== 0) {
      throw dockerReadError({
        result: created,
        command: "docker volume create",
      });
    }
  } else if (target.kind === "replaced-partial") {
    const wiped = await docker.capture(
      [
        ...dataBackupHelperArgv({
          name: opts.helperName(),
          volume: name,
          readOnly: false,
          entrypoint: "find",
          purpose: "import",
        }),
        "/v",
        "-mindepth",
        "1",
        "-delete",
      ],
      { unbounded: true }
    );
    if (wiped.exitCode !== 0) {
      throw helperFailure({
        volume: name,
        action: "clear the earlier partial import in",
        result: wiped,
        consequence: partialNote,
      });
    }
  }
  const extracted = await docker.streamFromFile({
    argv: [
      ...dataBackupHelperArgv({
        name: opts.helperName(),
        volume: name,
        readOnly: false,
        entrypoint: "tar",
        purpose: "import",
        stdin: true,
      }),
      "--numeric-owner",
      "-xpf",
      "-",
      "-C",
      "/v",
    ],
    path: `${opts.backup.path}/${target.volume.file}`,
  });
  if (extracted.exitCode !== 0) {
    await writeJournal({ ...opts, state: "failed", now: opts.now() });
    throw helperFailure({
      volume: name,
      action: "restore",
      result: extracted,
      consequence: partialNote,
    });
  }
  const tree = await treeDigest({
    docker,
    name: opts.helperName(),
    volume: name,
    purpose: "import",
    consequence: partialNote,
  });
  if (
    tree.digest !== target.volume.contentDigest ||
    tree.entries !== target.volume.entries
  ) {
    await writeJournal({ ...opts, state: "failed", now: opts.now() });
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The restored tree of ${name} does not match the backup's content digest (${tree.entries} entries, expected ${target.volume.entries}); the restore is marked failed and the volume was left as it is. ${recoverable ? "Rerunning hack data import replaces this partial copy." : partialNote}`,
      detail: {
        key: target.volume.key,
        name,
        expected: target.volume.contentDigest,
        actual: tree.digest,
      },
    });
  }
  return {
    key: target.volume.key,
    name,
    target: target.kind,
    entries: tree.entries,
    excludedSockets: target.volume.excludedSockets,
    contentDigest: tree.digest,
  };
}
