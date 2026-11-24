import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import {
  type DataBackupDeadlines,
  resolveDataBackupDeadlines,
} from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  type DataBackupVolume,
  dataBackupNameSha256,
} from "./data-backup-format.ts";
import {
  DataHelperContainers,
  type HeldVolume,
  requireStep,
  withHeldVolume,
} from "./data-backup-held-volume.ts";
import { parseJsonText, refuseRunning } from "./data-backup-helper.ts";
import {
  foreignMountError,
  type MountMonitor,
  startMountMonitor,
} from "./data-backup-mount-monitor.ts";
import { type VerifiedBackup, verifyDataBackup } from "./data-backup-verify.ts";
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_VOLUME_LABEL,
  composeOwnsVolume,
  type DeclaredVolume,
  type DeclaredVolumePlan,
  dockerReadError,
  type InspectedVolume,
  inspectVolume,
  plainLocalVolume,
  planDeclaredVolumes,
  requireUnchangedVolume,
  type WatchedVolume,
} from "./data-backup-volumes.ts";
import {
  type DataImportJournal,
  dataImportJournalPath,
  readDataImportJournal,
  withDataImportLock,
  writeDataImportJournal,
} from "./data-import-journal.ts";

/** Names the backup a volume created by `hack data import` restores. */
export const DATA_IMPORT_SOURCE_LABEL = "io.hack.data-backup.source";
const COMPOSE_VERSION_LABEL = "com.docker.compose.version";
const COMPOSE_VERSION = /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/;

export type DataImportInput = {
  readonly docker: DataBackupDocker;
  /** The instance's Compose argv, as `hack up` builds it (see dataComposeArgs). */
  readonly composeArgs: readonly string[];
  readonly backupPath: string;
  /** This instance's Hack project name and branch slug (never Compose names). */
  readonly project: string;
  readonly branch: string | null;
  /**
   * The Hack project name the backup was taken from; required when the
   * backup is from another instance or project, or a volume's name differs.
   */
  readonly fromProject?: string;
  readonly hackHome: string;
  readonly now?: () => Date;
  readonly downCommand?: string;
  /** Bound for each event-stream marker (default 30 s). */
  readonly markerTimeoutMs?: number;
  /** Bound for taking the per-project import lock (default 1 s). */
  readonly lockTimeoutMs?: number;
  /** Bounds for Docker calls; default from the environment overrides. */
  readonly deadlines?: DataBackupDeadlines;
};

/** How a target was prepared before extraction. */
export type DataImportTargetKind =
  | "created"
  | "empty"
  | "replaced-partial"
  /** Completed by an earlier run of this backup; re-verified, not rewritten. */
  | "verified-complete";

/** A restored volume, by Compose key only: Docker names are never reported. */
export type DataImportVolume = {
  readonly key: string;
  readonly target: DataImportTargetKind;
  /** `restored` by this run, or `verified`: it already matched the backup. */
  readonly outcome: "restored" | "verified";
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
  /** The Hack project and branch the backup was taken from. */
  readonly sourceProject: string;
  readonly sourceBranch: string | null;
  /** This instance's Hack project and branch. */
  readonly project: string;
  readonly branch: string | null;
  readonly volumes: readonly DataImportVolume[];
  readonly skipped: readonly DataImportSkipped[];
};

/** A backed-up key that is still a declared, non-external volume here. */
type SelectedTarget = {
  readonly volume: DataBackupVolume;
  readonly name: string;
  readonly declared: DeclaredVolume;
};

type Target = SelectedTarget & {
  readonly journalPath: string;
  readonly kind: DataImportTargetKind;
  /** The inspection validated before; null for a target this import creates. */
  readonly identity: InspectedVolume | null;
};

export type DataTargetConflict = {
  readonly key: string;
  readonly reason:
    | "foreign"
    | "not_empty"
    | "already_imported"
    | "modified"
    | "unsupported_driver"
    | "changed";
};

type Context = {
  readonly input: DataImportInput;
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
  readonly deadlines: DataBackupDeadlines;
  /** This run's containers, by the IDs their creates returned. */
  readonly helpers: DataHelperContainers;
  /**
   * The Mountpoint of each target, by Docker name, once known (inspected,
   * or created by this import), for the window's foreign-start check.
   */
  readonly mountpoints: Map<string, string>;
  /** The identity of each target once validated or created, by Docker name. */
  readonly identities: Map<string, InspectedVolume>;
  readonly now: () => Date;
};

/**
 * Restore a verified `hack data export` backup into this project's Compose
 * volumes.
 *
 * Every check runs before any write: the backup (manifest, tar sizes and
 * sha256), the source project, the per-project lock, the live event fence
 * and running refusal, and each target. A target is the Docker volume of a
 * backed-up key that is still a declared, non-external, plain local named
 * volume; it must be absent (created with Compose's own labels plus
 * {@link DATA_IMPORT_SOURCE_LABEL}), empty and labeled for this project and
 * key, or this import's own interrupted copy (same source label, journal not
 * complete), which is cleared and redone. Anything else refuses with
 * `E_DATA_TARGET_CONFLICT` and is never written.
 *
 * Each target is written through one held helper container (see
 * data-backup-held-volume.ts), bound to the validated volume, with bounded
 * steps and confirmed removal. After extraction the tree digest must equal
 * the manifest's; only then, and only once the event fence and the final
 * running check pass, is the journal complete.
 */
export async function importProjectData(
  input: DataImportInput
): Promise<DataImportResult> {
  const deadlines = input.deadlines ?? resolveDataBackupDeadlines();
  const backup = await verifyDataBackup(input.backupPath);
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
  requireSourceProject({ backup, plan, input });
  const { selected, skipped } = selectTargets({ backup, plan });
  requireSameNames({ selected, input });
  return await withDataImportLock({
    hackHome: input.hackHome,
    composeProject: instanceDir(input),
    timeoutMs: input.lockTimeoutMs,
    run: async () => {
      const helpers = new DataHelperContainers();
      // Subscribe and prove coverage before the first running-container check.
      const monitor = await startMountMonitor({
        docker: input.docker,
        purpose: "import",
        helpers,
        deadlines,
        markerTimeoutMs: input.markerTimeoutMs,
      });
      try {
        const volumes = await importWithin(
          {
            input,
            backup,
            plan,
            deadlines,
            helpers,
            mountpoints: new Map(),
            identities: new Map(),
            now: input.now ?? (() => new Date()),
          },
          selected,
          monitor
        );
        return {
          backup: backup.path,
          backupId: backup.id,
          sourceProject: backup.manifest.project,
          sourceBranch: backup.manifest.branch,
          project: input.project,
          branch: input.branch,
          volumes,
          skipped,
        };
      } finally {
        await monitor.stop();
      }
    },
  });
}

async function importWithin(
  context: Context,
  selected: readonly SelectedTarget[],
  monitor: MountMonitor
): Promise<readonly DataImportVolume[]> {
  const { input, plan } = context;
  const stopCommand = input.downCommand ?? "hack down";
  // The Mountpoint of every target that exists, before any hold, so the
  // first running check can see a container binding it. Reads only.
  for (const entry of selected) {
    const existing = await inspectVolume({
      docker: input.docker,
      name: entry.name,
    });
    if (existing !== null) {
      context.mountpoints.set(entry.name, existing.mountpoint);
    }
  }
  const watched = (): WatchedVolume[] =>
    selected.flatMap((entry) => {
      const mountpoint = context.mountpoints.get(entry.name);
      return mountpoint === undefined ? [] : [{ name: entry.name, mountpoint }];
    });
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    // An absent target is still checked by name (a container that would
    // create it by mounting it).
    volumes: [
      ...watched(),
      ...selected
        .filter((entry) => !context.mountpoints.has(entry.name))
        .map((entry) => ({ name: entry.name, mountpoint: "" })),
    ],
    exclude: context.helpers.created,
    timeoutMs: context.deadlines.commandMs,
    stopCommand,
    command: "import",
    lead: "The project is running, so its volumes cannot be restored safely; nothing was changed.",
  });
  const targets = await prepareTargets(context, selected);
  const composeVersion = targets.some((target) => target.kind === "created")
    ? await readComposeVersion(input.docker)
    : null;
  const volumes: DataImportVolume[] = [];
  for (const target of targets) {
    volumes.push(
      target.kind === "verified-complete"
        ? verifiedResult(target)
        : await restoreTarget(context, target, composeVersion)
    );
  }
  await refuseRunning({
    docker: input.docker,
    composeProject: plan.composeProject,
    volumes: watched(),
    exclude: context.helpers.created,
    timeoutMs: context.deadlines.commandMs,
    stopCommand,
    command: "import",
    lead: "A container started during the import, so the restore is not marked complete; rerunning hack data import after stopping it replaces its own copy.",
  });
  // Stop and drain the subscription, then decide.
  const keyOf = new Map(
    selected.map((entry) => [entry.name, entry.volume.key])
  );
  // Every target's Mountpoint is known by now: inspected, or created and
  // restored above.
  const mounts = (await monitor.finish(watched())).map((mount) => ({
    ...mount,
    volume: keyOf.get(mount.volume) ?? mount.volume,
  }));
  if (mounts.length > 0) {
    throw foreignMountError({
      mounts,
      command: "import",
      consequence:
        "the restore is not marked complete; rerunning hack data import replaces its own copy.",
      stopCommand,
    });
  }
  // Immediately before any target is marked complete: every target is
  // still the volume validated (or created) and written.
  for (const target of targets) {
    const identity = context.identities.get(target.name);
    if (identity !== undefined) {
      await requireUnchangedVolume({
        docker: input.docker,
        name: target.name,
        key: target.volume.key,
        identity,
        when: "after it was restored",
        consequence:
          "the restore is not marked complete; rerunning hack data import replaces its own copy.",
      });
    }
  }
  for (const target of targets) {
    if (target.kind !== "verified-complete") {
      await writeJournal(context, target, "complete");
    }
  }
  return volumes;
}

/** `<hack project>[--<branch>]`: names this instance in Hack's own state. */
function instanceDir(opts: {
  readonly project: string;
  readonly branch: string | null;
}): string {
  return opts.branch ? `${opts.project}--${opts.branch}` : opts.project;
}

/**
 * The backup must be from this instance: its Compose project hash equals
 * this instance's. Restoring into a branch instance or another project needs
 * `--from-project` naming the backup's Hack project name. Messages name Hack
 * projects and branches only, never the resolved Compose project.
 */
function requireSourceProject(opts: {
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
  readonly input: DataImportInput;
}): void {
  const { manifest } = opts.backup;
  const source = instanceDir(manifest);
  const fromProject = opts.input.fromProject;
  if (fromProject !== undefined) {
    if (fromProject !== manifest.project) {
      throw new HackCliError({
        code: "E_USAGE",
        message: `--from-project ${fromProject} does not match the backup, which is from Hack project ${manifest.project}. Nothing was changed.`,
      });
    }
    return;
  }
  if (
    manifest.composeProjectSha256 !==
    dataBackupNameSha256(opts.plan.composeProject)
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `The backup is from ${source}, and this instance is ${instanceDir(opts.input)}. To restore it here (into a branch instance or a renamed project), rerun with --from-project ${manifest.project}. Nothing was changed.`,
    });
  }
}

/** Backed-up keys that are still declared, non-external volumes here. */
function selectTargets(opts: {
  readonly backup: VerifiedBackup;
  readonly plan: DeclaredVolumePlan;
}): {
  readonly selected: readonly SelectedTarget[];
  readonly skipped: readonly DataImportSkipped[];
} {
  const declared = new Map(
    opts.plan.declared.map((entry) => [entry.key, entry])
  );
  const external = new Set(opts.plan.external.map((entry) => entry.key));
  const selected: SelectedTarget[] = [];
  const skipped: DataImportSkipped[] = [];
  for (const volume of opts.backup.manifest.volumes) {
    const entry = declared.get(volume.key);
    if (entry !== undefined) {
      selected.push({ volume, name: entry.name, declared: entry });
    } else {
      skipped.push({
        key: volume.key,
        reason: external.has(volume.key) ? "external" : "undeclared",
      });
    }
  }
  return { selected, skipped };
}

/**
 * Within the same project, each target's Docker name must hash to the one
 * the backup recorded; a changed `name:` (or env value in it) needs the
 * explicit --from-project, as restoring into another project does.
 */
function requireSameNames(opts: {
  readonly selected: readonly SelectedTarget[];
  readonly input: DataImportInput;
}): void {
  if (opts.input.fromProject !== undefined) {
    return;
  }
  const changed = opts.selected
    .filter(
      (entry) => dataBackupNameSha256(entry.name) !== entry.volume.nameSha256
    )
    .map((entry) => entry.volume.key);
  if (changed.length > 0) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `The Docker volume name for ${changed.join(", ")} differs from the one the backup was taken from. To restore under the current name, rerun with --from-project ${opts.input.project}. Nothing was changed.`,
      detail: { keys: changed },
    });
  }
}

const EMPTY_CHECK = ["find", "/v", "-mindepth", "1", "-print", "-quit"];

async function isEmpty(
  context: Context,
  held: HeldVolume,
  key: string
): Promise<boolean> {
  const result = requireStep({
    result: await held.exec(EMPTY_CHECK, {
      timeoutMs: context.deadlines.stepMs,
    }),
    label: key,
    action: "inspect",
    timeoutMs: context.deadlines.stepMs,
    consequence: "nothing was changed.",
    redactValues: context.input.docker.redactValues,
  });
  return result.stdout.trim() === "";
}

function changedTarget(key: string): () => HackCliError {
  return () => conflictError([{ key, reason: "changed" }]);
}

/** Hold an existing target read-only to see whether it is empty. */
async function existingIsEmpty(
  context: Context,
  entry: SelectedTarget,
  identity: InspectedVolume
): Promise<boolean> {
  return await withHeldVolume(
    {
      docker: context.input.docker,
      volume: entry.name,
      label: entry.volume.key,
      identity,
      readOnly: true,
      purpose: "import",
      deadlines: context.deadlines,
      helpers: context.helpers,
      changed: changedTarget(entry.volume.key),
      consequence: "nothing was changed.",
    },
    async (held) => {
      const empty = await isEmpty(context, held, entry.volume.key);
      // A removal under the bind leaves an empty tree: recheck the volume.
      await requireUnchangedVolume({
        docker: context.input.docker,
        name: entry.name,
        key: entry.volume.key,
        identity,
        when: "while it was being checked",
        consequence: "nothing was changed.",
        // Nothing was written yet: the same conflict as a target replaced
        // after validation.
        refusal: changedTarget(entry.volume.key),
      });
      return empty;
    }
  );
}

/** Whether an existing target's tree, read-only, equals the backup's. */
async function existingMatches(
  context: Context,
  entry: SelectedTarget,
  identity: InspectedVolume
): Promise<boolean> {
  const tree = await withHeldVolume(
    {
      docker: context.input.docker,
      volume: entry.name,
      label: entry.volume.key,
      identity,
      readOnly: true,
      purpose: "import",
      deadlines: context.deadlines,
      helpers: context.helpers,
      changed: changedTarget(entry.volume.key),
      consequence: "nothing was changed.",
    },
    async (held) => {
      const digest = await held.treeDigest("nothing was changed.");
      await requireUnchangedVolume({
        docker: context.input.docker,
        name: entry.name,
        key: entry.volume.key,
        identity,
        when: "while it was being checked",
        consequence: "nothing was changed.",
        // Nothing was written yet: the same conflict as a target replaced
        // after validation.
        refusal: changedTarget(entry.volume.key),
      });
      return digest;
    }
  );
  return (
    tree.digest === entry.volume.contentDigest &&
    tree.entries === entry.volume.entries
  );
}

function verifiedResult(target: Target): DataImportVolume {
  return {
    key: target.volume.key,
    target: "verified-complete",
    outcome: "verified",
    entries: target.volume.entries,
    excludedSockets: target.volume.excludedSockets,
    contentDigest: target.volume.contentDigest,
  };
}

/** Classify one target; a conflict is returned, never thrown. */
async function classifyTarget(
  context: Context,
  entry: SelectedTarget
): Promise<Target | DataTargetConflict> {
  const key = entry.volume.key;
  if (!plainLocalVolume(entry.declared)) {
    return { key, reason: "unsupported_driver" };
  }
  const journalPath = dataImportJournalPath({
    hackHome: context.input.hackHome,
    composeProject: instanceDir(context.input),
    key,
  });
  const inspected = await inspectVolume({
    docker: context.input.docker,
    name: entry.name,
  });
  if (inspected === null) {
    return { ...entry, journalPath, kind: "created", identity: null };
  }
  if (
    !composeOwnsVolume({
      volume: inspected,
      composeProject: context.plan.composeProject,
      key,
    })
  ) {
    return { key, reason: "foreign" };
  }
  if (!plainLocalVolume(inspected)) {
    return { key, reason: "unsupported_driver" };
  }
  context.mountpoints.set(entry.name, inspected.mountpoint);
  context.identities.set(entry.name, inspected);
  const target = { ...entry, journalPath, identity: inspected };
  const journal = await readDataImportJournal(journalPath);
  const sameRestore =
    journal !== null &&
    journal.backupId === context.backup.id &&
    journal.targetSha256 === dataBackupNameSha256(entry.name);
  // An earlier run of this backup completed this target: re-verify it and
  // move on, so a run interrupted after some targets can finish the rest.
  // Checked before emptiness: a target emptied since it was restored refuses
  // as modified (its deletion is not undone), and one that is empty in the
  // backup verifies instead of being rewritten.
  if (sameRestore && journal.state === "complete") {
    return (await existingMatches(context, entry, inspected))
      ? { ...target, kind: "verified-complete" }
      : { key, reason: "modified" };
  }
  if (await existingIsEmpty(context, entry, inspected)) {
    return { ...target, kind: "empty" };
  }
  if (
    sameRestore &&
    inspected.labels[DATA_IMPORT_SOURCE_LABEL] === context.backup.id
  ) {
    return { ...target, kind: "replaced-partial" };
  }
  return { key, reason: "not_empty" };
}

/** Classify every target before any write; one refusal names all conflicts. */
async function prepareTargets(
  context: Context,
  selected: readonly SelectedTarget[]
): Promise<readonly Target[]> {
  const targets: Target[] = [];
  const conflicts: DataTargetConflict[] = [];
  for (const entry of selected) {
    const outcome = await classifyTarget(context, entry);
    if ("reason" in outcome) {
      conflicts.push(outcome);
    } else {
      targets.push(outcome);
    }
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
        return `the volume for ${conflict.key} exists but its labels name another project or key, so Hack does not touch it`;
      case "already_imported":
        return `the volume for ${conflict.key} already holds a completed restore of this backup`;
      case "modified":
        return `the volume for ${conflict.key} was restored from this backup earlier but no longer matches it (it changed since)`;
      case "unsupported_driver":
        return `the volume for ${conflict.key} is declared or created with a driver other than plain \`local\` or with driver_opts, and hack data import restores into plain local volumes only for now`;
      case "changed":
        return `the volume for ${conflict.key} appeared or changed while this import prepared it (it is not the empty volume Hack validated or created with this backup's labels), so Hack wrote nothing to it`;
      default:
        return `the volume for ${conflict.key} already holds data`;
    }
  });
  return new HackCliError({
    code: "E_DATA_TARGET_CONFLICT",
    message: `Refused to restore: ${lines.join("; ")}. Hack never overwrites or deletes data: move the volume aside (find it with \`docker volume ls --filter label=com.docker.compose.volume=<key>\`), or back it up first with \`hack data export\`, then rerun. Nothing was written.`,
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
      redactValues: docker.redactValues,
    });
  }
  return match[1];
}

async function writeJournal(
  context: Context,
  target: Target,
  state: DataImportJournal["state"]
): Promise<void> {
  await writeDataImportJournal({
    path: target.journalPath,
    journal: {
      backupId: context.backup.id,
      backup: context.backup.path,
      key: target.volume.key,
      targetSha256: dataBackupNameSha256(target.name),
      state,
    },
    now: context.now(),
  });
}

/**
 * Create an absent target with Compose's labels plus the source label, and
 * return its inspection. `docker volume create` returns an existing volume
 * of that name unchanged, so the result must carry this backup's source
 * label, the expected Compose labels and a plain local driver, or the
 * target appeared meanwhile and refuses before any write.
 */
async function createTarget(
  context: Context,
  target: Target,
  composeVersion: string | null
): Promise<InspectedVolume> {
  const { docker } = context.input;
  const key = target.volume.key;
  const created = await docker.capture([
    "docker",
    "volume",
    "create",
    "--label",
    `${COMPOSE_PROJECT_LABEL}=${context.plan.composeProject}`,
    "--label",
    `${COMPOSE_VOLUME_LABEL}=${key}`,
    "--label",
    `${COMPOSE_VERSION_LABEL}=${composeVersion ?? ""}`,
    "--label",
    `${DATA_IMPORT_SOURCE_LABEL}=${context.backup.id}`,
    target.name,
  ]);
  if (created.exitCode !== 0) {
    throw dockerReadError({
      result: created,
      command: "docker volume create",
      redactValues: docker.redactValues,
    });
  }
  const inspected = await inspectVolume({ docker, name: target.name });
  if (
    !(
      inspected !== null &&
      inspected.labels[DATA_IMPORT_SOURCE_LABEL] === context.backup.id &&
      composeOwnsVolume({
        volume: inspected,
        composeProject: context.plan.composeProject,
        key,
      }) &&
      plainLocalVolume(inspected)
    )
  ) {
    throw changedTarget(key)();
  }
  return inspected;
}

/** Create or clear, extract and verify one target in one held helper. */
async function restoreTarget(
  context: Context,
  target: Target,
  composeVersion: string | null
): Promise<DataImportVolume> {
  const key = target.volume.key;
  const identity =
    target.kind === "created"
      ? await createTarget(context, target, composeVersion)
      : target.identity;
  if (identity === null) {
    throw changedTarget(key)();
  }
  context.mountpoints.set(target.name, identity.mountpoint);
  context.identities.set(target.name, identity);
  const recoverable = target.kind !== "empty";
  const partialNote = recoverable
    ? `the volume for ${key} may hold a partial copy; rerunning hack data import replaces it.`
    : `the volume for ${key} may hold a partial copy without Hack's import label, so a rerun refuses it: remove that volume once you have checked it, then rerun.`;
  const tree = await withHeldVolume(
    {
      docker: context.input.docker,
      volume: target.name,
      label: key,
      identity,
      readOnly: false,
      purpose: "import",
      deadlines: context.deadlines,
      helpers: context.helpers,
      changed: changedTarget(key),
      consequence: partialNote,
    },
    async (held) => {
      // Still the empty volume validated or created a moment ago?
      if (
        target.kind !== "replaced-partial" &&
        !(await isEmpty(context, held, key))
      ) {
        throw changedTarget(key)();
      }
      // From the first write on, a rerun recognizes this target.
      await writeJournal(context, target, "started");
      if (target.kind === "replaced-partial") {
        requireStep({
          result: await held.exec(["find", "/v", "-mindepth", "1", "-delete"]),
          label: key,
          action: "clear the earlier partial import in",
          timeoutMs: context.deadlines.stepMs,
          consequence: partialNote,
          redactValues: context.input.docker.redactValues,
        });
      }
      const extracted = await held.execFromFile(
        ["tar", "--numeric-owner", "-xpf", "-", "-C", "/v"],
        join(context.backup.path, target.volume.file)
      );
      if (extracted.exitCode !== 0) {
        await writeJournal(context, target, "failed");
      }
      requireStep({
        result: extracted,
        label: key,
        action: "restore",
        timeoutMs: context.deadlines.stepMs,
        consequence: partialNote,
        redactValues: context.input.docker.redactValues,
      });
      const restored = await held.treeDigest(partialNote);
      // A removal under the bind would leave the restore in a deleted
      // directory: the volume must still be the one written.
      await requireUnchangedVolume({
        docker: context.input.docker,
        name: target.name,
        key,
        identity,
        when: "while it was being restored",
        consequence: `the restore is not marked complete; ${partialNote}`,
      });
      return restored;
    }
  );
  if (
    tree.digest !== target.volume.contentDigest ||
    tree.entries !== target.volume.entries
  ) {
    await writeJournal(context, target, "failed");
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The restored tree of the volume for ${key} does not match the backup's content digest (${tree.entries} entries, expected ${target.volume.entries}); the restore is marked failed and the volume was left as it is. ${recoverable ? "Rerunning hack data import replaces this partial copy." : partialNote}`,
      detail: {
        key,
        expected: target.volume.contentDigest,
        actual: tree.digest,
      },
    });
  }
  return {
    key,
    target: target.kind,
    outcome: "restored",
    entries: tree.entries,
    excludedSockets: target.volume.excludedSockets,
    contentDigest: tree.digest,
  };
}
