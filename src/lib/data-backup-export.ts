import { mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_DIGEST_SCRIPT,
  DATA_BACKUP_MANIFEST,
  DATA_BACKUP_PARTIAL_SUFFIX,
  DATA_BACKUP_SCHEMA,
  DATA_BACKUP_TREE_DIGEST,
  DATA_BACKUPS_DIR_NAME,
  type DataBackupManifest,
  type DataBackupVolume,
  dataBackupHelperImage,
  dataBackupTimestamp,
} from "./data-backup-format.ts";
import {
  classifyDeclaredVolumes,
  dockerReadError,
  type OwnedVolume,
  planDeclaredVolumes,
  runningContainers,
} from "./data-backup-volumes.ts";
import { closedFileWriteError, type FileWriteOperation } from "./fs.ts";
import { isRecord } from "./guards.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/;

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
 * using an owned volume, runs, before and again after the copy; it never
 * stops anything. Atomicity: everything is written into `<backup>.partial/`,
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
  const plan = planDeclaredVolumes(parseJson(config.stdout));
  const stopCommand = input.downCommand ?? "hack down";
  const { owned, skipped } = await classifyDeclaredVolumes({
    docker: input.docker,
    plan,
  });
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumes: owned,
    stopCommand,
    when: "before",
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
        helperImage,
      })
    );
  }
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumes: owned,
    stopCommand,
    when: "during",
    partial,
  });

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
  await publishBackup({ partial, backup, parent, manifest });
  return { backup, manifest };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function fsStep<T>(
  opts: { readonly path: string; readonly operation: FileWriteOperation },
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    throw closedFileWriteError({ error, ...opts });
  }
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

async function refuseRunning(opts: {
  readonly docker: DataBackupDocker;
  readonly composeProject: string;
  readonly volumes: readonly OwnedVolume[];
  readonly stopCommand: string;
  readonly when: "before" | "during";
  readonly partial?: string;
}): Promise<void> {
  const running = await runningContainers(opts);
  if (running.length === 0) {
    return;
  }
  const lead =
    opts.when === "before"
      ? "The project is running, so its volumes cannot be copied consistently; nothing was backed up."
      : `A container started during the export, so the copy may be inconsistent and was not published; the incomplete copy is in ${opts.partial}, which you can delete.`;
  throw new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `${lead} Stop it with \`${opts.stopCommand}\`, then retry. Hack never stops containers for an export.`,
    detail: { running },
  });
}

/** Copy one owned volume: a tar stream to `<key>.tar`, then its tree digest. */
async function copyVolume(opts: {
  readonly docker: DataBackupDocker;
  readonly volume: OwnedVolume;
  readonly partial: string;
  readonly helperImage: string;
}): Promise<DataBackupVolume> {
  const { volume } = opts;
  const helper = (entrypoint: string, extra: readonly string[] = []) => [
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "--pull",
    "missing",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--label",
    "io.hack.data-backup=export",
    ...extra,
    "--volume",
    `${volume.name}:/v:ro`,
    "--entrypoint",
    entrypoint,
    opts.helperImage,
  ];
  const file = `${volume.key}.tar`;
  const path = join(opts.partial, file);
  const tar = await fsStep({ path, operation: "write" }, () =>
    opts.docker.streamToFile({
      argv: [...helper("tar"), "--numeric-owner", "-cpf", "-", "-C", "/v", "."],
      path,
    })
  );
  if (tar.exitCode !== 0) {
    throw helperFailure({ volume, stage: "tar", result: tar });
  }
  const digest = await opts.docker.capture(
    [
      ...helper("bun", [
        "--tmpfs",
        "/tmp",
        "--env",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
      ]),
      "-e",
      DATA_BACKUP_DIGEST_SCRIPT,
    ],
    { unbounded: true }
  );
  if (digest.exitCode !== 0) {
    throw helperFailure({ volume, stage: "digest", result: digest });
  }
  const tree = parseJson(digest.stdout.trim());
  if (
    !(
      isRecord(tree) &&
      tree.algorithm === DATA_BACKUP_TREE_DIGEST &&
      typeof tree.entries === "number" &&
      Number.isSafeInteger(tree.entries) &&
      tree.entries > 0 &&
      typeof tree.digest === "string" &&
      SHA256_HEX.test(tree.digest)
    )
  ) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The backup helper returned an unreadable digest for volume ${volume.name}; the incomplete copy is in ${opts.partial}.`,
    });
  }
  return {
    key: volume.key,
    name: volume.name,
    driver: volume.driver,
    labels: volume.labels,
    file,
    tarBytes: tar.bytes,
    tarSha256: tar.sha256,
    entries: tree.entries,
    contentDigest: tree.digest,
  };
}

function helperFailure(opts: {
  readonly volume: OwnedVolume;
  readonly stage: "tar" | "digest";
  readonly result: { readonly exitCode: number; readonly stderr: string };
}): HackCliError {
  const engine = dockerReadError({
    result: { ...opts.result, stdout: "" },
    command: "docker run",
  });
  if (engine.code !== "E_UNEXPECTED") {
    return engine;
  }
  return new HackCliError({
    code: "E_UNEXPECTED",
    message: `The backup helper failed to ${opts.stage === "tar" ? "copy" : "digest"} volume ${opts.volume.name} (exit ${opts.result.exitCode}); no backup was published. The helper image is ${dataBackupHelperImage()}; check that Docker can run it.`,
  });
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Manifest last, fsync, then one rename: a reader sees a whole backup or none. */
async function publishBackup(opts: {
  readonly partial: string;
  readonly backup: string;
  readonly parent: string;
  readonly manifest: DataBackupManifest;
}): Promise<void> {
  const manifestPath = join(opts.partial, DATA_BACKUP_MANIFEST);
  await fsStep({ path: manifestPath, operation: "write" }, async () => {
    await writeFile(
      manifestPath,
      `${JSON.stringify(opts.manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    await syncPath(manifestPath);
    await syncPath(opts.partial);
  });
  await refuseExisting(opts.backup);
  await fsStep({ path: opts.backup, operation: "write" }, async () => {
    await rename(opts.partial, opts.backup);
    await syncPath(opts.parent);
  });
}
