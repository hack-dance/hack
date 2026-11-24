import { mkdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { createBackingProver } from "./data-backup-backing-proof.ts";
import {
  type DataBackupDeadlines,
  resolveDataBackupDeadlines,
} from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
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
  DataHelperContainers,
  requireStep,
  withHeldVolume,
  withVolumeReferences,
} from "./data-backup-held-volume.ts";
import {
  fsStep,
  parseJsonText,
  parseTreeDigest,
  refuseRunning,
  syncPath,
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
  plainLocalInspected,
  planDeclaredVolumes,
  requireUnchangedVolume,
  volumeReplacedError,
  type WatchedVolume,
} from "./data-backup-volumes.ts";
import { withDataCleanupRecord } from "./data-cleanup-record.ts";
import { isRecord } from "./guards.ts";

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
  /** Bounds for Docker calls; default from the environment overrides. */
  readonly deadlines?: DataBackupDeadlines;
  /** fsync of a directory; a test seam for the post-rename durability path. */
  readonly syncDirectory?: (path: string) => Promise<void>;
  /**
   * The env selection the managed env was resolved with (see
   * ComposeRuntimeModel.envSelection), kept in the run's cleanup record;
   * `undefined` is the configured default.
   */
  readonly envSelection?: string | null;
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
    throw dockerReadError({
      result: config,
      command: "docker compose config",
      redactValues: input.docker.redactValues,
    });
  }
  const plan = planDeclaredVolumes(parseJsonText(config.stdout));
  const helpers = new DataHelperContainers();
  // Subscribe and prove coverage before the first running-container check.
  const deadlines = input.deadlines ?? resolveDataBackupDeadlines();
  // The run's cleanup record, durable before its first container create
  // (the start marker), so `hack data cleanup --nonce` can reach the same
  // engine if a create's outcome cannot be reconciled.
  return await withDataCleanupRecord(
    {
      hackHome: input.hackHome,
      command: "export",
      project: input.project,
      branch: input.branch,
      envSelection: input.envSelection,
      docker: input.docker,
      helpers,
      now,
    },
    async () => {
      const monitor = await startMountMonitor({
        docker: input.docker,
        purpose: "export",
        helpers,
        deadlines,
        markerTimeoutMs: input.markerTimeoutMs,
      });
      try {
        return await exportWithin({
          input,
          now,
          plan,
          monitor,
          helpers,
          deadlines,
        });
      } finally {
        await monitor.stop();
      }
    }
  );
}

async function exportWithin(opts: {
  readonly input: DataExportInput;
  readonly now: Date;
  readonly plan: DeclaredVolumePlan;
  readonly monitor: MountMonitor;
  readonly helpers: DataHelperContainers;
  readonly deadlines: DataBackupDeadlines;
}): Promise<DataExportResult> {
  const { input, now, plan, monitor, helpers, deadlines } = opts;
  const stopCommand = input.downCommand ?? "hack down";
  const { owned, skipped } = await classifyDeclaredVolumes({
    docker: input.docker,
    plan,
  });
  // Hack reads a volume by binding its Mountpoint, never by mounting it by
  // name (which would create it if it vanished): plain local volumes only.
  const unsupported = owned
    .filter((volume) => !plainLocalInspected(volume.identity))
    .map((volume) => volume.key);
  if (unsupported.length > 0) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: `hack data export reads only plain local volumes for now; the volume for ${unsupported.join(", ")} uses another driver or driver options. Nothing was backed up.`,
      detail: { keys: unsupported, reason: "unsupported_driver" },
    });
  }
  const watched = owned.map((volume) => ({
    name: volume.name,
    mountpoint: volume.identity.mountpoint,
  }));
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumes: watched,
    exclude: helpers.created,
    timeoutMs: deadlines.commandMs,
    prove: createBackingProver({
      docker: input.docker,
      purpose: "export",
      deadlines,
      helpers,
    }),
    stopCommand,
    command: "export",
    lead: "The project is running, so its volumes cannot be copied consistently; nothing was backed up.",
  });

  const parent =
    input.outDir ??
    join(
      input.hackHome,
      DATA_BACKUPS_DIR_NAME,
      input.branch ? `${input.project}--${input.branch}` : input.project
    );
  // Directories this export creates; their entries are flushed at the end.
  const createdDirs = await missingDirectories(parent);
  await fsStep({ path: parent, operation: "create_directory" }, () =>
    mkdir(parent, { recursive: true, mode: 0o700 })
  );
  const { backup, partial } = await claimBackupPath({
    parent,
    stamp: dataBackupTimestamp(now),
    // An explicit --out names exactly this parent; refuse a collision there.
    nextFreeName: input.outDir === undefined,
  });

  const helperImage = dataBackupHelperImage();
  const notPublishedNote = `the backup was not published; the incomplete copy is in ${partial}, which you can delete.`;
  // A Docker reference to every copied volume for the whole copy and its
  // checks, so `docker volume rm` is refused while the binds read it.
  const volumes = await withVolumeReferences(
    { docker: input.docker, purpose: "export", deadlines, helpers },
    async (references) => {
      for (const volume of owned) {
        // A reference never creates a volume: a missing one refuses here.
        await references.add(
          volume.name,
          () =>
            new HackCliError({
              code: "E_PROJECT_RUNNING",
              message: `The volume for ${volume.key} was removed after it was validated, so it was not read and nothing was created; ${notPublishedNote} Make sure nothing removes the project's volumes, then retry.`,
              detail: { key: volume.key, reason: "volume_changed" },
            })
        );
      }
      // A volume replaced under its name before its reference existed is
      // referenced as it now is: it must still be the one validated.
      for (const volume of owned) {
        await requireUnchangedVolume({
          docker: input.docker,
          name: volume.name,
          key: volume.key,
          identity: volume.identity,
          when: "before Hack could take a reference to it",
          consequence: notPublishedNote,
        });
      }
      return await copyWithinWindow({
        input,
        owned,
        watched,
        partial,
        monitor,
        helpers,
        deadlines,
        composeProject: plan.composeProject,
        stopCommand,
        consequence: notPublishedNote,
      });
    }
  );

  const manifest: DataBackupManifest = {
    schema: DATA_BACKUP_SCHEMA,
    project: input.project,
    branch: input.branch,
    composeProjectSha256: dataBackupNameSha256(plan.composeProject),
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
    createdDirs,
    syncDirectory: input.syncDirectory ?? syncPath,
    // Immediately before the rename: every copied volume is still the one
    // validated and read.
    beforeRename: async () => {
      for (const volume of owned) {
        await requireUnchangedVolume({
          docker: input.docker,
          name: volume.name,
          key: volume.key,
          identity: volume.identity,
          when: "after it was copied",
          consequence: `the backup was not published; the incomplete copy is in ${partial}, which you can delete.`,
        });
      }
    },
  });
  return { backup, manifest };
}

/**
 * Copy every owned volume, then run the window's last checks: the running
 * check, the end of the event window (foreign mounts and starts), and any
 * destroy or create of a copied volume's name.
 */
async function copyWithinWindow(opts: {
  readonly input: DataExportInput;
  readonly owned: readonly OwnedVolume[];
  readonly watched: readonly WatchedVolume[];
  readonly partial: string;
  readonly monitor: MountMonitor;
  readonly helpers: DataHelperContainers;
  readonly deadlines: DataBackupDeadlines;
  readonly composeProject: string;
  readonly stopCommand: string;
  readonly consequence: string;
}): Promise<DataBackupVolume[]> {
  const { input, owned, watched, partial, monitor, helpers, deadlines } = opts;
  const { stopCommand, consequence } = opts;
  const volumes: DataBackupVolume[] = [];
  for (const volume of owned) {
    volumes.push(
      await copyVolume({
        docker: input.docker,
        volume,
        partial,
        helpers,
        deadlines,
      })
    );
  }
  await refuseRunning({
    docker: input.docker,
    composeProject: opts.composeProject,
    volumes: watched,
    exclude: helpers.created,
    timeoutMs: deadlines.commandMs,
    prove: createBackingProver({
      docker: input.docker,
      purpose: "export",
      deadlines,
      helpers,
    }),
    stopCommand,
    command: "export",
    lead: `A container started during the export, so the copy may be inconsistent and was not published; the incomplete copy is in ${partial}, which you can delete.`,
  });
  // Stop and drain the subscription, then decide.
  const keyOf = new Map(owned.map((volume) => [volume.name, volume.key]));
  const mounts = (await monitor.finish(watched)).map((mount) => ({
    ...mount,
    volume: keyOf.get(mount.volume) ?? mount.volume,
  }));
  if (mounts.length > 0) {
    throw foreignMountError({
      mounts,
      command: "export",
      consequence,
      stopCommand,
    });
  }
  // Export creates no volume: any destroy or create of a copied volume's
  // name in the window is someone else's.
  const replaced = monitor.changedVolumes({
    names: owned.map((volume) => volume.name),
  });
  if (replaced.length > 0) {
    throw volumeReplacedError({
      keys: replaced.map((name) => keyOf.get(name) ?? name).sort(),
      consequence,
    });
  }

  return volumes;
}

/**
 * The directories `mkdir -p` would create for `path`, deepest first: `path`
 * and each ancestor up to (not including) the first that exists.
 */
async function missingDirectories(path: string): Promise<readonly string[]> {
  const missing: string[] = [];
  let current = path;
  while ((await stat(current).catch(() => null)) === null) {
    missing.push(current);
    const up = dirname(current);
    if (up === current) {
      break;
    }
    current = up;
  }
  return missing;
}

/** How many `<UTC>-<n>` names a default-path export tries in one second. */
const MAX_BACKUP_NAME_SUFFIX = 100;

/**
 * Claim this export's backup name under `parent`: `<stamp>`, or with
 * `nextFreeName` the first free of `<stamp>-2`, `<stamp>-3`, ... (a
 * refused export leaves its `.partial`, and a quick retry lands in the same
 * second). The claim is `mkdir <name>.partial` itself: its EEXIST is the
 * signal to move on, never a check followed by a create, so two exports in
 * one second never share a name. A name whose final directory already
 * exists is skipped as well (the empty `.partial` this run just made is
 * removed first). Never reuses or replaces an existing backup or
 * `.partial`. Without `nextFreeName` (an explicit --out), any collision
 * refuses with E_PATH_CONFLICT as before.
 */
async function claimBackupPath(opts: {
  readonly parent: string;
  readonly stamp: string;
  readonly nextFreeName: boolean;
}): Promise<{ readonly backup: string; readonly partial: string }> {
  const tries = opts.nextFreeName ? MAX_BACKUP_NAME_SUFFIX : 1;
  for (let index = 1; index <= tries; index += 1) {
    const backup = join(
      opts.parent,
      index === 1 ? opts.stamp : `${opts.stamp}-${index}`
    );
    const partial = `${backup}${DATA_BACKUP_PARTIAL_SUFFIX}`;
    if (!opts.nextFreeName) {
      await refuseExisting(backup);
    }
    const claimed = await fsStep(
      { path: partial, operation: "create_directory" },
      () =>
        mkdir(partial, { mode: 0o700 }).then(
          () => true,
          (error: unknown) => {
            if (isRecord(error) && error.code === "EEXIST") {
              return false;
            }
            throw error;
          }
        )
    );
    if (!claimed) {
      if (!opts.nextFreeName) {
        await refuseExisting(partial);
      }
      continue;
    }
    if ((await stat(backup).catch(() => null)) === null) {
      return { backup, partial };
    }
    // The final name is taken: release the empty claim this run made.
    await fsStep({ path: partial, operation: "create_directory" }, () =>
      rmdir(partial)
    );
    if (!opts.nextFreeName) {
      await refuseExisting(backup);
    }
  }
  throw new HackCliError({
    code: "E_PATH_CONFLICT",
    message: `${join(opts.parent, opts.stamp)} and its next ${MAX_BACKUP_NAME_SUFFIX - 1} names already exist; Hack never writes into or replaces an existing backup. Retry in a second, or choose another --out.`,
  });
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

/**
 * Copy one owned volume through one held helper container: digest the
 * tree, stream the tar to `<key>.tar`, digest the tree again, then digest
 * the archive itself (streamed back in). Publication requires source digest
 * before == source digest after == archive digest.
 */
async function copyVolume(opts: {
  readonly docker: DataBackupDocker;
  readonly volume: OwnedVolume;
  readonly partial: string;
  readonly helpers: DataHelperContainers;
  readonly deadlines: DataBackupDeadlines;
}): Promise<DataBackupVolume> {
  const { volume, deadlines } = opts;
  const consequence = `no backup was published; the incomplete copy is in ${opts.partial}.`;
  const file = `${volume.key}.tar`;
  const path = join(opts.partial, file);
  return await withHeldVolume(
    {
      docker: opts.docker,
      volume: volume.name,
      label: volume.key,
      identity: volume.identity,
      readOnly: true,
      purpose: "export",
      deadlines,
      helpers: opts.helpers,
      consequence,
      changed: () =>
        new HackCliError({
          code: "E_PROJECT_RUNNING",
          message: `The volume for ${volume.key} was removed, replaced or relabeled after it was validated, so it was not read and nothing was created; ${consequence}`,
          detail: { key: volume.key, reason: "volume_changed" },
        }),
    },
    async (held) => {
      const before = await held.treeDigest(consequence);
      const tar = requireStep({
        result: await fsStep({ path, operation: "write" }, () =>
          held.execToFile(
            ["tar", "--numeric-owner", "-cpf", "-", "-C", "/v", "."],
            path
          )
        ),
        label: volume.key,
        action: "copy",
        timeoutMs: deadlines.stepMs,
        consequence,
        redactValues: opts.docker.redactValues,
      });
      const after = await held.treeDigest(consequence);
      // A removal under the bind empties the tree the helper sees; both
      // digests could agree on that empty tree.
      await requireUnchangedVolume({
        docker: opts.docker,
        name: volume.name,
        key: volume.key,
        identity: volume.identity,
        when: "while it was being copied",
        consequence,
      });
      if (before.digest !== after.digest || before.entries !== after.entries) {
        throw new HackCliError({
          code: "E_PROJECT_RUNNING",
          message: `The volume for ${volume.key} changed while it was being copied (its tree digest before and after the copy differ), so the copy is not consistent; ${consequence} Make sure nothing writes to the project's volumes, then retry.`,
          detail: { key: volume.key, reason: "source_changed" },
        });
      }
      // The archive itself must hold exactly that tree.
      const archive = parseTreeDigest({
        stdout: requireStep({
          result: await held.execFromFile(
            ["bun", "-e", DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT],
            path
          ),
          label: volume.key,
          action: "verify the archive of",
          timeoutMs: deadlines.stepMs,
          consequence,
          redactValues: opts.docker.redactValues,
        }).stdout,
        label: volume.key,
        consequence,
      });
      if (
        archive.digest !== before.digest ||
        archive.entries !== before.entries
      ) {
        throw new HackCliError({
          code: "E_UNEXPECTED",
          message: `The archive of volume ${volume.key} does not hold the tree that was copied (the archive digest differs from the source digest), so it was not published; ${consequence} Check the disk the backup is written to, then retry.`,
          detail: { key: volume.key, reason: "archive_mismatch" },
        });
      }
      return {
        key: volume.key,
        nameSha256: dataBackupNameSha256(volume.name),
        driver: volume.driver,
        labelsSha256: {
          "com.docker.compose.project": dataBackupNameSha256(
            volume.labels["com.docker.compose.project"]
          ),
          "com.docker.compose.volume": dataBackupNameSha256(
            volume.labels["com.docker.compose.volume"]
          ),
        },
        file,
        tarBytes: tar.bytes,
        tarSha256: tar.sha256,
        entries: before.entries,
        excludedSockets: before.excludedSockets,
        contentDigest: before.digest,
      };
    }
  );
}

/**
 * Manifest last; fsync the manifest and the `.partial` directory (each tar
 * was fsynced as it was written); one rename publishes; then fsync the
 * parent, and the directory above each directory this export created. A failure before the rename leaves only `.partial`. A failed
 * parent fsync after it is a distinct outcome: the backup is complete and
 * visible, but its durability is unconfirmed (`detail.published: true,
 * durable: false`).
 */
async function publishBackup(opts: {
  readonly partial: string;
  readonly backup: string;
  readonly parent: string;
  readonly manifest: DataBackupManifest;
  /** Directories this export created, deepest first. */
  readonly createdDirs: readonly string[];
  readonly syncDirectory: (path: string) => Promise<void>;
  /** The last check before the rename; a refusal leaves `.partial`. */
  readonly beforeRename: () => Promise<void>;
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
  await opts.beforeRename();
  await fsStep({ path: opts.backup, operation: "write" }, () =>
    rename(opts.partial, opts.backup)
  );
  try {
    await opts.syncDirectory(opts.parent);
    // A directory this export created is durable only once its own entry
    // in the directory above is flushed, deepest first.
    for (const created of opts.createdDirs) {
      await opts.syncDirectory(dirname(created));
    }
  } catch {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The backup at ${opts.backup} is complete but its durability could not be confirmed: the rename that published it could not be flushed to disk. Check the file system, then use the backup or export again.`,
      detail: { backup: opts.backup, published: true, durable: false },
    });
  }
}
