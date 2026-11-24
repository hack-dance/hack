import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_MANIFEST,
  DATA_BACKUP_PARTIAL_SUFFIX,
  DATA_BACKUP_SCHEMA,
  DATA_BACKUP_TREE_DIGEST,
  DATA_BACKUPS_DIR_NAME,
  type DataBackupManifest,
  type DataBackupVolume,
  dataBackupHelperImage,
  dataBackupNameSha256,
  dataBackupTimestamp,
} from "./data-backup-format.ts";
import {
  dataBackupHelperArgv,
  fsStep,
  helperContainerName,
  helperFailure,
  parseJsonText,
  refuseRunning,
  syncPath,
  treeDigest,
} from "./data-backup-helper.ts";
import {
  foreignMountError,
  type MountMonitor,
  startMountMonitor,
} from "./data-backup-mount-monitor.ts";
import {
  classifyDeclaredVolumes,
  type DeclaredVolumePlan,
  dockerReadError,
  type OwnedVolume,
  planDeclaredVolumes,
} from "./data-backup-volumes.ts";

export type DataExportInput = {
  readonly docker: DataBackupDocker;
  /** `docker compose -p … --project-directory … -f …`, as other commands build it. */
  readonly composeArgs: readonly string[];
  readonly project: string;
  readonly branch: string | null;
  /** Hack's home; the default parent is `<home>/data-backups/<compose project>`. */
  readonly hackHome: string;
  /** `--out`: replaces the default parent directory. */
  readonly outDir?: string;
  readonly hackVersion: string;
  readonly now?: () => Date;
  /** The command that stops this instance, named in the running refusal. */
  readonly downCommand?: string;
  /** Bound for each event-stream marker (default 30 s). */
  readonly markerTimeoutMs?: number;
  /** fsync of a directory; a test seam for the post-rename durability path. */
  readonly syncDirectory?: (path: string) => Promise<void>;
};

export type DataExportResult = {
  readonly backup: string;
  readonly manifest: DataBackupManifest;
};

/**
 * Write a verified file-level backup of the project's owned Compose volumes.
 *
 * Ownership: only declared, non-external volumes whose labels name this
 * Compose project and key are mounted, read-only, in a network-less helper.
 * Consistency: refuses while a container of the project, or any container
 * using an owned volume, runs, before and again after the copy, and when a
 * live Docker event subscription sees any container but this run's helpers
 * mount an owned volume; it never stops anything. The subscription is
 * proven live (see startMountMonitor) before the first running-container
 * check, so a mount between that check and the first copy is seen too.
 * Atomicity: everything is written into `<backup>.partial/`,
 * the manifest last, fsynced, then renamed to `<backup>/`. A failure leaves
 * only the `.partial` directory, which is never a backup and is never reused:
 * each run takes a fresh UTC-second timestamp, and an existing target or
 * partial directory is refused rather than overwritten.
 */
export async function exportProjectData(
  input: DataExportInput
): Promise<DataExportResult> {
  const now = (input.now ?? (() => new Date()))();
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
  const helperNames = new Set<string>();
  // Subscribe and prove coverage before the first running-container check.
  const monitor = await startMountMonitor({
    docker: input.docker,
    purpose: "export",
    helperNames,
    markerTimeoutMs: input.markerTimeoutMs,
  });
  try {
    return await exportWithin({ input, now, plan, monitor, helperNames });
  } finally {
    await monitor.stop();
  }
}

async function exportWithin(opts: {
  readonly input: DataExportInput;
  readonly now: Date;
  readonly plan: DeclaredVolumePlan;
  readonly monitor: MountMonitor;
  readonly helperNames: Set<string>;
}): Promise<DataExportResult> {
  const { input, now, plan, monitor, helperNames } = opts;
  const stopCommand = input.downCommand ?? "hack down";
  const { owned, skipped } = await classifyDeclaredVolumes({
    docker: input.docker,
    plan,
  });
  const volumeNames = owned.map((volume) => volume.name);
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumeNames,
    stopCommand,
    command: "export",
    lead: "The project is running, so its volumes cannot be copied consistently; nothing was backed up.",
  });

  const parent =
    input.outDir ??
    join(input.hackHome, DATA_BACKUPS_DIR_NAME, plan.composeProject);
  const backup = join(parent, dataBackupTimestamp(now));
  const partial = `${backup}${DATA_BACKUP_PARTIAL_SUFFIX}`;
  await fsStep({ path: parent, operation: "create_directory" }, () =>
    mkdir(parent, { recursive: true, mode: 0o700 })
  );
  await refuseExisting(backup);
  await refuseExisting(partial);
  await fsStep({ path: partial, operation: "create_directory" }, () =>
    mkdir(partial, { mode: 0o700 })
  );

  const helperImage = dataBackupHelperImage();
  const volumes: DataBackupVolume[] = [];
  for (const volume of owned) {
    volumes.push(
      await copyVolume({
        docker: input.docker,
        volume,
        partial,
        helperNames,
      })
    );
  }
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumeNames,
    stopCommand,
    command: "export",
    lead: `A container started during the export, so the copy may be inconsistent and was not published; the incomplete copy is in ${partial}, which you can delete.`,
  });
  // Stop and drain the subscription, then decide.
  const keyOf = new Map(owned.map((volume) => [volume.name, volume.key]));
  const mounts = (await monitor.finish(volumeNames)).map((mount) => ({
    ...mount,
    volume: keyOf.get(mount.volume) ?? mount.volume,
  }));
  if (mounts.length > 0) {
    throw foreignMountError({
      mounts,
      command: "export",
      consequence: `the backup was not published; the incomplete copy is in ${partial}, which you can delete.`,
      stopCommand,
    });
  }

  const manifest: DataBackupManifest = {
    schema: DATA_BACKUP_SCHEMA,
    project: input.project,
    branch: input.branch,
    composeProject: plan.composeProject,
    createdAt: now.toISOString(),
    hackVersion: input.hackVersion,
    helperImage,
    digestAlgorithm: DATA_BACKUP_TREE_DIGEST,
    volumes,
    skipped,
  };
  await publishBackup({
    partial,
    backup,
    parent,
    manifest,
    syncDirectory: input.syncDirectory ?? syncPath,
  });
  return { backup, manifest };
}

async function refuseExisting(path: string): Promise<void> {
  const existing = await stat(path).catch(() => null);
  if (existing) {
    throw new HackCliError({
      code: "E_PATH_CONFLICT",
      message: `${path} already exists; Hack never writes into or replaces an existing backup. Retry to use a new timestamp, or choose another --out.`,
    });
  }
}

/** Copy one owned volume: a tar stream to `<key>.tar`, then its tree digest. */
async function copyVolume(opts: {
  readonly docker: DataBackupDocker;
  readonly volume: OwnedVolume;
  readonly partial: string;
  readonly helperNames: Set<string>;
}): Promise<DataBackupVolume> {
  const { volume } = opts;
  const name = (): string => {
    const helper = helperContainerName("export");
    opts.helperNames.add(helper);
    return helper;
  };
  const consequence = `no backup was published; the incomplete copy is in ${opts.partial}.`;
  const file = `${volume.key}.tar`;
  const path = join(opts.partial, file);
  const tar = await fsStep({ path, operation: "write" }, () =>
    opts.docker.streamToFile({
      argv: [
        ...dataBackupHelperArgv({
          name: name(),
          volume: volume.name,
          readOnly: true,
          entrypoint: "tar",
          purpose: "export",
        }),
        "--numeric-owner",
        "-cpf",
        "-",
        "-C",
        "/v",
        ".",
      ],
      path,
    })
  );
  if (tar.exitCode !== 0) {
    throw helperFailure({
      volume: volume.key,
      action: "copy",
      result: tar,
      consequence,
    });
  }
  const tree = await treeDigest({
    docker: opts.docker,
    name: name(),
    volume: volume.name,
    label: volume.key,
    purpose: "export",
    consequence,
  });
  return {
    key: volume.key,
    nameSha256: dataBackupNameSha256(volume.name),
    driver: volume.driver,
    labels: volume.labels,
    file,
    tarBytes: tar.bytes,
    tarSha256: tar.sha256,
    entries: tree.entries,
    excludedSockets: tree.excludedSockets,
    contentDigest: tree.digest,
  };
}

/**
 * Manifest last; fsync the manifest and the `.partial` directory (each tar
 * was fsynced as it was written); one rename publishes; then fsync the
 * parent. A failure before the rename leaves only `.partial`. A failed
 * parent fsync after it is a distinct outcome: the backup is complete and
 * visible, but its durability is unconfirmed (`detail.published: true,
 * durable: false`).
 */
async function publishBackup(opts: {
  readonly partial: string;
  readonly backup: string;
  readonly parent: string;
  readonly manifest: DataBackupManifest;
  readonly syncDirectory: (path: string) => Promise<void>;
}): Promise<void> {
  const manifestPath = join(opts.partial, DATA_BACKUP_MANIFEST);
  await fsStep({ path: manifestPath, operation: "write" }, async () => {
    await writeFile(
      manifestPath,
      `${JSON.stringify(opts.manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    await syncPath(manifestPath);
    await opts.syncDirectory(opts.partial);
  });
  await refuseExisting(opts.backup);
  await fsStep({ path: opts.backup, operation: "write" }, () =>
    rename(opts.partial, opts.backup)
  );
  try {
    await opts.syncDirectory(opts.parent);
  } catch {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The backup at ${opts.backup} is complete but its durability could not be confirmed: the rename that published it could not be flushed to disk. Check the file system, then use the backup or export again.`,
      detail: { backup: opts.backup, published: true, durable: false },
    });
  }
}
