import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";

import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";

/**
 * Snapshots and rollback for upgrade steps (HACK-2189, the upgrade assistant
 * HACK-2188). A step that changes files (the env migration, a later
 * `hack upgrade apply`) snapshots them first, records what it wrote, and can
 * put every file back.
 *
 * Contract:
 * - {@link createUpgradeSnapshot} reads every target first and writes
 *   nothing unless all of them can be snapshotted (all or nothing). A target
 *   is a regular file (its exact bytes and mode are kept) or absent (the
 *   snapshot records that it did not exist). A symlink, directory or other
 *   entry at a target, a target larger than {@link MAX_SNAPSHOT_FILE_BYTES},
 *   or one that cannot be read refuses the whole snapshot.
 * - Storage is a private directory outside every Git working tree
 *   (default `~/.hack/upgrade/snapshots/<id>/`): directories 0700, files
 *   0600, created with no-follow and exclusive opens, owner-checked on every
 *   read. File bytes live in `blobs/<sha256>`. The manifest holds only
 *   paths, caller labels, kinds, sizes, modes and SHA-256 digests: never
 *   file content. Manifest writes are atomic (temporary file, fsync,
 *   rename).
 * - {@link recordUpgradeSnapshotAfter} records each target's state after the
 *   step wrote it. That is the reference for "changed since": restore puts a
 *   target back only when it still holds what the step wrote (or already
 *   holds the snapshot), and refuses with `conflict` otherwise, unless
 *   `overwrite` is set. A target with no recorded after state (an
 *   interrupted step) also needs `overwrite`.
 * - {@link restoreUpgradeSnapshot} never deletes data. What it replaces or
 *   removes (the step's output, or with `overwrite` a later edit) is first
 *   kept as a blob in the snapshot directory and named in the result
 *   (`keptAs`). A restored file gets the snapshot's exact bytes and mode,
 *   through a no-follow temporary file renamed over the target. Restore is
 *   idempotent: a target that already matches the snapshot is
 *   `already-restored`. Every target it could not restore is reported with
 *   a closed reason.
 * - Results and errors carry paths, labels, statuses and closed messages,
 *   never file content. Labels are caller input and must not hold values.
 *
 * Restore protocol, per target: stage the snapshot's copy beside the target;
 * move whatever is at the target to an invocation-owned sibling name (one
 * atomic rename) and keep exactly those bytes before removing the sibling;
 * publish the staged copy with a hard link, which fails if anything
 * appeared at the target meanwhile. A late edit found in the displaced file
 * is linked back unless `overwrite` is set, and is kept either way, so no
 * edit is lost at any point. Not atomic across targets.
 *
 * One writer per snapshot: `recordUpgradeSnapshotAfter` rewrites the
 * manifest (read, modify, atomic rename, directory fsync), so two
 * concurrent recorders on the same snapshot can lose each other's after
 * states. Callers (one upgrade step at a time) own the snapshot while they
 * run.
 */

export const UPGRADE_SNAPSHOT_VERSION = 1;
export const UPGRADE_SNAPSHOT_KIND = "hack-upgrade-snapshot";
/** Largest file a snapshot keeps; larger targets refuse the snapshot. */
export const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MANIFEST_NAME = "manifest.json";
const BLOBS_DIR = "blobs";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A file's state: its digest, size and permission bits, or absence. */
export type UpgradeSnapshotState =
  | {
      readonly kind: "file";
      readonly size: number;
      /** Permission bits (`mode & 0o7777`). */
      readonly mode: number;
      readonly sha256: string;
    }
  | { readonly kind: "absent" };

export type UpgradeSnapshotEntry = {
  /** Absolute, normalized target path. */
  readonly path: string;
  /** Caller's description, for example `project app-a: .env`. No values. */
  readonly label: string;
  readonly before: UpgradeSnapshotState;
  /** Recorded by {@link recordUpgradeSnapshotAfter}; null until then. */
  readonly after: UpgradeSnapshotState | null;
};

export type UpgradeSnapshotManifest = {
  readonly version: typeof UPGRADE_SNAPSHOT_VERSION;
  readonly kind: typeof UPGRADE_SNAPSHOT_KIND;
  readonly id: string;
  /** What the snapshot is for, for example `env-migration app-a`. */
  readonly purpose: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entries: readonly UpgradeSnapshotEntry[];
};

export type UpgradeSnapshot = {
  readonly id: string;
  readonly dir: string;
  readonly manifestPath: string;
  readonly manifest: UpgradeSnapshotManifest;
};

export type UpgradeSnapshotTarget = {
  readonly path: string;
  readonly label: string;
};

/** Why one target could not be snapshotted. */
export type UpgradeSnapshotTargetRefusal =
  | "not-absolute"
  | "duplicate"
  | "symlink"
  | "not-a-file"
  | "too-large"
  | "unreadable"
  | "inside-snapshot-root";

/** Why a snapshot directory could not be used. */
export type UpgradeSnapshotRootRefusal =
  | "inside-working-tree"
  | "not-private"
  | "not-owned"
  | "symlink"
  | "not-a-directory"
  | "unwritable";

export type CreateUpgradeSnapshotResult =
  | { readonly status: "created"; readonly snapshot: UpgradeSnapshot }
  | {
      readonly status: "refused";
      readonly reason: "targets";
      readonly targets: readonly {
        readonly path: string;
        readonly label: string;
        readonly reason: UpgradeSnapshotTargetRefusal;
      }[];
    }
  | {
      readonly status: "refused";
      readonly reason: "root";
      readonly root: string;
      readonly rootReason: UpgradeSnapshotRootRefusal;
    };

/** The default snapshot directory: `<hack home>/upgrade/snapshots`. */
export function defaultUpgradeSnapshotRoot(): string {
  return join(resolveGlobalHackDir(), "upgrade", "snapshots");
}

/**
 * Snapshots `targets` into a new private directory under `root`. Reads
 * every target before writing anything; any refused target refuses the
 * whole snapshot and nothing is written.
 */
export async function createUpgradeSnapshot(input: {
  readonly purpose: string;
  readonly targets: readonly UpgradeSnapshotTarget[];
  readonly root?: string;
  readonly now?: Date;
  /** Test seam; production uses a timestamp and random suffix. */
  readonly id?: string;
}): Promise<CreateUpgradeSnapshotResult> {
  const root = resolve(input.root ?? defaultUpgradeSnapshotRoot());
  const read = await readTargets({ targets: input.targets, root });
  if (read.refused.length > 0) {
    return { status: "refused", reason: "targets", targets: read.refused };
  }
  const rootProblem = await ensurePrivateRoot(root);
  if (rootProblem !== null) {
    return { status: "refused", reason: "root", root, rootReason: rootProblem };
  }
  const now = input.now ?? new Date();
  const id = input.id ?? snapshotId(now);
  if (!SNAPSHOT_ID.test(id)) {
    throw new Error("Invalid upgrade snapshot id.");
  }
  const dir = join(root, id);
  // Exclusive: a second snapshot with the same id never reuses a directory.
  await mkdir(dir, { mode: 0o700 });
  await mkdir(join(dir, BLOBS_DIR), { mode: 0o700 });
  for (const target of read.targets) {
    if (target.bytes !== null && target.state.kind === "file") {
      await writeBlob({
        dir,
        sha256: target.state.sha256,
        bytes: target.bytes,
      });
    }
  }
  const stamp = now.toISOString();
  const manifest: UpgradeSnapshotManifest = {
    version: UPGRADE_SNAPSHOT_VERSION,
    kind: UPGRADE_SNAPSHOT_KIND,
    id,
    purpose: input.purpose,
    createdAt: stamp,
    updatedAt: stamp,
    entries: read.targets.map((target) => ({
      path: target.path,
      label: target.label,
      before: target.state,
      after: null,
    })),
  };
  const manifestPath = join(dir, MANIFEST_NAME);
  await writeManifest({ path: manifestPath, manifest });
  return { status: "created", snapshot: { id, dir, manifestPath, manifest } };
}

export type RecordUpgradeSnapshotAfterResult =
  | { readonly status: "recorded"; readonly snapshot: UpgradeSnapshot }
  | { readonly status: "invalid-manifest"; readonly message: string }
  | {
      readonly status: "refused";
      readonly paths: readonly {
        readonly path: string;
        readonly reason: UpgradeSnapshotTargetRefusal;
      }[];
    };

/**
 * Records the current state of the snapshot's targets (all of them, or
 * `paths`) as what the step wrote. Call it after each write, or once after
 * the step. Only digests are recorded; nothing is copied.
 */
export async function recordUpgradeSnapshotAfter(input: {
  readonly manifestPath: string;
  readonly paths?: readonly string[];
  readonly now?: Date;
}): Promise<RecordUpgradeSnapshotAfterResult> {
  const loaded = await readUpgradeSnapshot({
    manifestPath: input.manifestPath,
  });
  if (loaded.status !== "ok") {
    return { status: "invalid-manifest", message: loaded.message };
  }
  const { snapshot } = loaded;
  const wanted =
    input.paths === undefined
      ? null
      : new Set(input.paths.map((path) => normalize(resolve(path))));
  const refused: { path: string; reason: UpgradeSnapshotTargetRefusal }[] = [];
  const entries: UpgradeSnapshotEntry[] = [];
  for (const entry of snapshot.manifest.entries) {
    if (wanted !== null && !wanted.has(entry.path)) {
      entries.push(entry);
      continue;
    }
    const current = await inspectTarget(entry.path);
    if (current.kind === "refused") {
      refused.push({ path: entry.path, reason: current.reason });
      entries.push(entry);
      continue;
    }
    entries.push({ ...entry, after: current.state });
  }
  if (wanted !== null) {
    const known = new Set(snapshot.manifest.entries.map((entry) => entry.path));
    for (const path of wanted) {
      if (!known.has(path)) {
        throw new Error("The path is not a target of this upgrade snapshot.");
      }
    }
  }
  if (refused.length > 0) {
    return { status: "refused", paths: refused };
  }
  const manifest: UpgradeSnapshotManifest = {
    ...snapshot.manifest,
    updatedAt: (input.now ?? new Date()).toISOString(),
    entries,
  };
  await writeManifest({ path: snapshot.manifestPath, manifest });
  return { status: "recorded", snapshot: { ...snapshot, manifest } };
}

/** Per-target outcome of a restore. */
export type UpgradeRestoreStatus =
  /** The snapshot's bytes and mode were put back. */
  | "restored"
  /** The target was absent in the snapshot; what the step created was moved into the snapshot directory. */
  | "moved-aside"
  /** The target already matches the snapshot; nothing changed. */
  | "already-restored"
  /** The target changed since the step recorded it (or no after state was recorded); left unchanged. */
  | "conflict"
  /** A symlink, directory or other entry is at the target; left unchanged, even with overwrite. */
  | "not-a-file"
  /** The snapshot's copy is missing or does not match its digest. */
  | "backup-damaged"
  | "error";

export type UpgradeRestoreEntry = {
  readonly path: string;
  readonly label: string;
  readonly status: UpgradeRestoreStatus;
  /** Where the replaced or removed content was kept, when any was. */
  readonly keptAs?: string;
  readonly message?: string;
};

export type RestoreUpgradeSnapshotResult =
  | { readonly status: "invalid-manifest"; readonly message: string }
  | {
      /** Every target is back as it was in the snapshot. */
      readonly status: "restored" | "incomplete";
      readonly results: readonly UpgradeRestoreEntry[];
    };

const MESSAGES = {
  conflict:
    "The file changed since the upgrade step wrote it; left unchanged. Check it, then rerun with overwrite to keep the current file in the snapshot and restore the snapshot's copy.",
  noAfter:
    "The upgrade step did not record what it wrote here, so a change cannot be told apart from the step's own write; left unchanged. Rerun with overwrite to restore the snapshot's copy (the current file is kept in the snapshot).",
  notAFile:
    "A link, directory or other entry is at this path; left unchanged. Move it aside, then rerun the restore.",
  damaged:
    "The snapshot's copy of this file is missing or does not match its recorded digest; nothing was restored here.",
  error: "The file could not be restored at this path; left as it was.",
} as const;

/**
 * Puts the snapshot's targets (all, or `paths`) back. See the module
 * contract: never deletes, refuses changed targets unless `overwrite`,
 * reports every target it could not restore.
 */
export async function restoreUpgradeSnapshot(input: {
  readonly manifestPath: string;
  readonly overwrite?: boolean;
  readonly paths?: readonly string[];
  /** Test seam: runs after a target's checks, before it is displaced. */
  readonly beforeReplace?: (path: string) => Promise<void>;
  /** Test seam: runs after the target is displaced, before publication. */
  readonly afterDisplace?: (path: string) => Promise<void>;
}): Promise<RestoreUpgradeSnapshotResult> {
  const loaded = await readUpgradeSnapshot({
    manifestPath: input.manifestPath,
  });
  if (loaded.status !== "ok") {
    return { status: "invalid-manifest", message: loaded.message };
  }
  const { snapshot } = loaded;
  const wanted =
    input.paths === undefined
      ? null
      : new Set(input.paths.map((path) => normalize(resolve(path))));
  if (wanted !== null) {
    const known = new Set(snapshot.manifest.entries.map((entry) => entry.path));
    for (const path of wanted) {
      if (!known.has(path)) {
        throw new Error("The path is not a target of this upgrade snapshot.");
      }
    }
  }
  const results: UpgradeRestoreEntry[] = [];
  for (const entry of snapshot.manifest.entries) {
    if (wanted !== null && !wanted.has(entry.path)) {
      continue;
    }
    let outcome: Omit<UpgradeRestoreEntry, "path" | "label">;
    try {
      outcome = await restoreEntry({
        snapshot,
        entry,
        overwrite: input.overwrite === true,
        beforeReplace: input.beforeReplace,
        afterDisplace: input.afterDisplace,
      });
    } catch {
      outcome = { status: "error", message: MESSAGES.error };
    }
    results.push({ path: entry.path, label: entry.label, ...outcome });
  }
  const done = results.every(
    (result) =>
      result.status === "restored" ||
      result.status === "moved-aside" ||
      result.status === "already-restored"
  );
  return { status: done ? "restored" : "incomplete", results };
}

export type ReadUpgradeSnapshotResult =
  | { readonly status: "ok"; readonly snapshot: UpgradeSnapshot }
  | { readonly status: "invalid"; readonly message: string };

const INVALID_MANIFEST =
  "The upgrade snapshot manifest is missing, unreadable, not private to this user, or not a valid Hack upgrade snapshot.";

/**
 * Reads and validates a manifest: owned by this user, not a link, private
 * (no group or other access), and of the expected shape.
 */
export async function readUpgradeSnapshot(input: {
  readonly manifestPath: string;
}): Promise<ReadUpgradeSnapshotResult> {
  const invalid = { status: "invalid", message: INVALID_MANIFEST } as const;
  const manifestPath = resolve(input.manifestPath);
  const dir = dirname(manifestPath);
  if (basename(manifestPath) !== MANIFEST_NAME) {
    return invalid;
  }
  if (
    (await privateDirectoryProblem(dir)) !== null ||
    (await privateDirectoryProblem(join(dir, BLOBS_DIR))) !== null
  ) {
    return invalid;
  }
  const text = await readPrivateFile({
    path: manifestPath,
    maxBytes: MAX_MANIFEST_BYTES,
  });
  if (text === null) {
    return invalid;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.toString("utf8"));
  } catch {
    return invalid;
  }
  const manifest = parseManifest(parsed);
  if (manifest === null || manifest.id !== basename(dir)) {
    return invalid;
  }
  return {
    status: "ok",
    snapshot: { id: manifest.id, dir, manifestPath, manifest },
  };
}

/** Snapshots under `root`, newest first; unreadable ones are skipped. */
export async function listUpgradeSnapshots(
  input: { readonly root?: string } = {}
): Promise<readonly UpgradeSnapshot[]> {
  const root = resolve(input.root ?? defaultUpgradeSnapshotRoot());
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const found: UpgradeSnapshot[] = [];
  for (const name of names) {
    if (!SNAPSHOT_ID.test(name)) {
      continue;
    }
    const read = await readUpgradeSnapshot({
      manifestPath: join(root, name, MANIFEST_NAME),
    });
    if (read.status === "ok") {
      found.push(read.snapshot);
    }
  }
  return found.sort((a, b) =>
    b.manifest.createdAt.localeCompare(a.manifest.createdAt)
  );
}

// ---------------------------------------------------------------------------
// Reading targets
// ---------------------------------------------------------------------------

type ReadTarget = {
  readonly path: string;
  readonly label: string;
  readonly state: UpgradeSnapshotState;
  readonly bytes: Buffer | null;
};

async function readTargets(input: {
  readonly targets: readonly UpgradeSnapshotTarget[];
  readonly root: string;
}): Promise<{
  readonly targets: readonly ReadTarget[];
  readonly refused: readonly {
    readonly path: string;
    readonly label: string;
    readonly reason: UpgradeSnapshotTargetRefusal;
  }[];
}> {
  const targets: ReadTarget[] = [];
  const refused: {
    path: string;
    label: string;
    reason: UpgradeSnapshotTargetRefusal;
  }[] = [];
  const seen = new Set<string>();
  for (const target of input.targets) {
    if (!isAbsolute(target.path)) {
      refused.push({ ...target, reason: "not-absolute" });
      continue;
    }
    const path = normalize(target.path);
    if (seen.has(path)) {
      refused.push({ path, label: target.label, reason: "duplicate" });
      continue;
    }
    seen.add(path);
    if (isInside({ path, dir: input.root })) {
      refused.push({
        path,
        label: target.label,
        reason: "inside-snapshot-root",
      });
      continue;
    }
    const read = await readTargetBytes(path);
    if (read.kind === "refused") {
      refused.push({ path, label: target.label, reason: read.reason });
      continue;
    }
    targets.push({
      path,
      label: target.label,
      state: read.state,
      bytes: read.bytes,
    });
  }
  return { targets, refused };
}

type TargetRead =
  | {
      readonly kind: "ok";
      readonly state: UpgradeSnapshotState;
      readonly bytes: Buffer | null;
    }
  | { readonly kind: "refused"; readonly reason: UpgradeSnapshotTargetRefusal };

/** A target's state and bytes, read through a no-follow open. */
async function readTargetBytes(path: string): Promise<TargetRead> {
  const entry = await lstatOrNull(path);
  if (entry === "error") {
    return { kind: "refused", reason: "unreadable" };
  }
  if (entry === null) {
    return { kind: "ok", state: { kind: "absent" }, bytes: null };
  }
  if (entry.isSymbolicLink()) {
    return { kind: "refused", reason: "symlink" };
  }
  if (!entry.isFile()) {
    return { kind: "refused", reason: "not-a-file" };
  }
  if (entry.size > MAX_SNAPSHOT_FILE_BYTES) {
    return { kind: "refused", reason: "too-large" };
  }
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== entry.ino || info.dev !== entry.dev) {
      return { kind: "refused", reason: "not-a-file" };
    }
    if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      return { kind: "refused", reason: "too-large" };
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
      return { kind: "refused", reason: "too-large" };
    }
    return {
      kind: "ok",
      state: {
        kind: "file",
        size: bytes.byteLength,
        mode: info.mode & 0o7777,
        sha256: sha256(bytes),
      },
      bytes,
    };
  } catch (error: unknown) {
    return {
      kind: "refused",
      reason: errorCode(error) === "ELOOP" ? "symlink" : "unreadable",
    };
  } finally {
    await handle?.close();
  }
}

/** A target's current state, without keeping its bytes. */
async function inspectTarget(
  path: string
): Promise<
  | { readonly kind: "ok"; readonly state: UpgradeSnapshotState }
  | { readonly kind: "refused"; readonly reason: UpgradeSnapshotTargetRefusal }
> {
  const read = await readTargetBytes(path);
  return read.kind === "ok" ? { kind: "ok", state: read.state } : read;
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

function sameState(a: UpgradeSnapshotState, b: UpgradeSnapshotState): boolean {
  if (a.kind === "absent" || b.kind === "absent") {
    return a.kind === b.kind;
  }
  return a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode;
}

type RestoreOutcome = Omit<UpgradeRestoreEntry, "path" | "label">;

/**
 * What restoring `entry` would start from: the target's current bytes, or
 * the outcome when there is nothing to do or it must not be touched.
 */
async function restoreStart(input: {
  readonly entry: UpgradeSnapshotEntry;
  readonly overwrite: boolean;
}): Promise<
  | { readonly kind: "done"; readonly outcome: RestoreOutcome }
  | { readonly kind: "go"; readonly current: TargetRead & { kind: "ok" } }
> {
  const { entry } = input;
  const current = await readTargetBytes(entry.path);
  if (current.kind === "refused") {
    const outcome: RestoreOutcome =
      current.reason === "unreadable" || current.reason === "too-large"
        ? { status: "error", message: MESSAGES.error }
        : { status: "not-a-file", message: MESSAGES.notAFile };
    return { kind: "done", outcome };
  }
  if (sameState(current.state, entry.before)) {
    return { kind: "done", outcome: { status: "already-restored" } };
  }
  const stepOutput =
    entry.after !== null && sameState(current.state, entry.after);
  if (!(stepOutput || input.overwrite)) {
    return {
      kind: "done",
      outcome: {
        status: "conflict",
        message: entry.after === null ? MESSAGES.noAfter : MESSAGES.conflict,
      },
    };
  }
  return { kind: "go", current };
}

async function restoreEntry(input: {
  readonly snapshot: UpgradeSnapshot;
  readonly entry: UpgradeSnapshotEntry;
  readonly overwrite: boolean;
  readonly beforeReplace?: (path: string) => Promise<void>;
  readonly afterDisplace?: (path: string) => Promise<void>;
}): Promise<RestoreOutcome> {
  const { snapshot, entry } = input;
  const start = await restoreStart(input);
  if (start.kind === "done") {
    return start.outcome;
  }
  const { current } = start;
  let staged: string | null = null;
  if (entry.before.kind === "file") {
    const bytes = await readBlob({
      dir: snapshot.dir,
      sha256: entry.before.sha256,
    });
    if (bytes === null) {
      return { status: "backup-damaged", message: MESSAGES.damaged };
    }
    staged = await stageFile({
      path: entry.path,
      bytes,
      mode: entry.before.mode,
    });
  }
  try {
    await input.beforeReplace?.(entry.path);
    const displaced = await displaceTarget({
      snapshot,
      path: entry.path,
      expected: current.state,
      overwrite: input.overwrite,
    });
    if (displaced.kind === "stopped") {
      return displaced.outcome;
    }
    const kept =
      displaced.keptAs === undefined ? {} : { keptAs: displaced.keptAs };
    await input.afterDisplace?.(entry.path);
    if (staged === null) {
      return displaced.keptAs === undefined
        ? { status: "already-restored" }
        : { status: "moved-aside", ...kept };
    }
    const published = await publishStaged({ staged, path: entry.path });
    staged = null;
    return published
      ? { status: "restored", ...kept }
      : { status: "conflict", message: MESSAGES.conflict, ...kept };
  } finally {
    if (staged !== null) {
      await unlink(staged).catch(() => undefined);
    }
  }
}

/**
 * Moves whatever is at `path` right now to an invocation-owned sibling
 * name (one atomic rename), keeps exactly those bytes as a blob, then
 * removes the sibling. What was displaced is what is kept, so an edit that
 * landed after the checks is never lost. When the displaced file is not
 * what was inspected (a late edit) and `overwrite` is off, it is linked
 * back and the target is reported as a conflict. A displaced link,
 * directory or other entry is put back and reported as `not-a-file`.
 */
async function displaceTarget(input: {
  readonly snapshot: UpgradeSnapshot;
  readonly path: string;
  readonly expected: UpgradeSnapshotState;
  readonly overwrite: boolean;
}): Promise<
  | { readonly kind: "displaced"; readonly keptAs?: string }
  | { readonly kind: "stopped"; readonly outcome: RestoreOutcome }
> {
  const sibling = join(
    dirname(input.path),
    `.${basename(input.path)}.hack-displaced-${randomBytes(6).toString("hex")}`
  );
  try {
    await rename(input.path, sibling);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    // Nothing is there now.
    return input.expected.kind === "absent" || input.overwrite
      ? { kind: "displaced" }
      : {
          kind: "stopped",
          outcome: { status: "conflict", message: MESSAGES.conflict },
        };
  }
  const moved = await readTargetBytes(sibling);
  if (moved.kind === "refused" || moved.state.kind !== "file") {
    // Not a regular file: put it back where it was, untouched.
    await putBack({ sibling, path: input.path, file: false });
    return {
      kind: "stopped",
      outcome: { status: "not-a-file", message: MESSAGES.notAFile },
    };
  }
  const keptAs = await writeBlob({
    dir: input.snapshot.dir,
    sha256: moved.state.sha256,
    bytes: moved.bytes ?? Buffer.alloc(0),
  });
  if (!(sameState(moved.state, input.expected) || input.overwrite)) {
    // A late edit: it goes back where it was (and is kept as a blob too).
    await putBack({ sibling, path: input.path, file: true });
    return {
      kind: "stopped",
      outcome: { status: "conflict", message: MESSAGES.conflict, keptAs },
    };
  }
  await unlink(sibling);
  return { kind: "displaced", keptAs };
}

/**
 * Returns a displaced entry to `path` without replacing anything that
 * appeared there meanwhile: a file is linked back (refused when the name
 * is taken); another entry is renamed back only while the name is free.
 * When the name was taken, the entry stays under its sibling name.
 */
async function putBack(input: {
  readonly sibling: string;
  readonly path: string;
  readonly file: boolean;
}): Promise<void> {
  if (input.file) {
    try {
      await link(input.sibling, input.path);
      await unlink(input.sibling);
    } catch {
      // The name was taken: the displaced file stays at its sibling name
      // (and in the snapshot).
    }
    return;
  }
  if ((await lstatOrNull(input.path)) === null) {
    await rename(input.sibling, input.path).catch(() => undefined);
  }
}

/**
 * Writes `bytes` with exactly `mode` to a new no-follow temporary file in
 * the target's directory (created 0700 when missing) and syncs it.
 */
async function stageFile(input: {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
}): Promise<string> {
  const parent = dirname(input.path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(
    parent,
    `.${basename(input.path)}.hack-restore-${randomBytes(6).toString("hex")}`
  );
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(input.bytes);
    await handle.chmod(input.mode);
    await handle.sync();
  } catch (error: unknown) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return temporary;
}

/**
 * Publishes a staged file at `path` only while the name is free: a hard
 * link, which fails when anything appeared there since the displacement.
 * False (and the staged file removed) when the name is taken. On a
 * filesystem without hard links, a rename after checking the name is free.
 */
async function publishStaged(input: {
  readonly staged: string;
  readonly path: string;
}): Promise<boolean> {
  try {
    await link(input.staged, input.path);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      await unlink(input.staged).catch(() => undefined);
      return false;
    }
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") {
      await unlink(input.staged).catch(() => undefined);
      throw error;
    }
    if ((await lstatOrNull(input.path)) !== null) {
      await unlink(input.staged).catch(() => undefined);
      return false;
    }
    await rename(input.staged, input.path);
    return true;
  }
  await unlink(input.staged);
  return true;
}

// ---------------------------------------------------------------------------
// Private storage
// ---------------------------------------------------------------------------

function blobPath(input: { readonly dir: string; readonly sha256: string }) {
  return join(input.dir, BLOBS_DIR, input.sha256);
}

/**
 * Stores `bytes` as `blobs/<sha256>` (0600, exclusive, no-follow). A blob
 * that already exists with the same digest is reused. Returns its path.
 */
async function writeBlob(input: {
  readonly dir: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}): Promise<string> {
  const path = blobPath(input);
  const existing = await readPrivateFile({
    path,
    maxBytes: MAX_SNAPSHOT_FILE_BYTES,
  });
  if (existing !== null && sha256(existing) === input.sha256) {
    return path;
  }
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(input.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}

async function readBlob(input: {
  readonly dir: string;
  readonly sha256: string;
}): Promise<Buffer | null> {
  const bytes = await readPrivateFile({
    path: blobPath(input),
    maxBytes: MAX_SNAPSHOT_FILE_BYTES,
  });
  return bytes !== null && sha256(bytes) === input.sha256 ? bytes : null;
}

async function writeManifest(input: {
  readonly path: string;
  readonly manifest: UpgradeSnapshotManifest;
}): Promise<void> {
  const temporary = `${input.path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(`${JSON.stringify(input.manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, input.path);
  await syncDirectory(dirname(input.path));
}

/** Makes a rename in `dir` durable; best effort where directories cannot be synced. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms and filesystems do not sync directories.
  } finally {
    await handle?.close();
  }
}

/**
 * Reads a file this user owns, that is not a link and that grants no group
 * or other access, up to `maxBytes`. Null for anything else.
 */
async function readPrivateFile(input: {
  readonly path: string;
  readonly maxBytes: number;
}): Promise<Buffer | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      input.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > input.maxBytes ||
      (info.mode & 0o077) !== 0 ||
      !ownedByThisUser(info.uid)
    ) {
      return null;
    }
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function ownedByThisUser(uid: number): boolean {
  const own = process.getuid?.();
  return own === undefined || own === uid;
}

/** Why `dir` is not a private directory of this user, or null. */
async function privateDirectoryProblem(
  dir: string
): Promise<UpgradeSnapshotRootRefusal | null> {
  const entry = await lstatOrNull(dir);
  if (entry === null || entry === "error") {
    return "not-a-directory";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (!entry.isDirectory()) {
    return "not-a-directory";
  }
  if (!ownedByThisUser(entry.uid)) {
    return "not-owned";
  }
  if ((entry.mode & 0o077) !== 0) {
    return "not-private";
  }
  return null;
}

/**
 * Creates the snapshot root (0700, each missing component) and checks it:
 * a private directory of this user, not a link, and not inside a Git
 * working tree.
 */
async function ensurePrivateRoot(
  root: string
): Promise<UpgradeSnapshotRootRefusal | null> {
  // Check the path as written and as resolved: a symlinked ancestor (a
  // `~/.hack` that points into a dotfiles checkout) must not carry the
  // snapshot into a working tree.
  const canonical = await canonicalPath(root);
  if (canonical === null) {
    return "unwritable";
  }
  if ((await insideWorkingTree(root)) || (await insideWorkingTree(canonical))) {
    return "inside-working-tree";
  }
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return errorCode(error) === "EEXIST" || errorCode(error) === "ENOTDIR"
      ? "not-a-directory"
      : "unwritable";
  }
  // Again on the created directory, before anything is written into it.
  const created = await realpath(root).catch(() => null);
  if (created === null) {
    return "unwritable";
  }
  if (await insideWorkingTree(created)) {
    return "inside-working-tree";
  }
  return await privateDirectoryProblem(root);
}

/**
 * The resolved form of `path`: the real path of its deepest existing
 * ancestor, with the components that do not exist yet appended. Null when
 * an ancestor cannot be resolved for another reason.
 */
async function canonicalPath(path: string): Promise<string | null> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        return null;
      }
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether `path` or any directory above it holds a `.git` entry. */
async function insideWorkingTree(path: string): Promise<boolean> {
  let current = resolve(path);
  for (;;) {
    const marker = await lstatOrNull(join(current, ".git"));
    if (marker !== null && marker !== "error") {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

function parseState(raw: unknown): UpgradeSnapshotState | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.kind === "absent") {
    return { kind: "absent" };
  }
  const { kind, size, mode, sha256: digest } = raw;
  if (
    kind !== "file" ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > MAX_SNAPSHOT_FILE_BYTES ||
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o7777 ||
    typeof digest !== "string" ||
    !SHA256_HEX.test(digest)
  ) {
    return null;
  }
  return { kind: "file", size, mode, sha256: digest };
}

function parseEntry(raw: unknown): UpgradeSnapshotEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { path, label } = raw;
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    typeof label !== "string"
  ) {
    return null;
  }
  const before = parseState(raw.before);
  const after = raw.after === null ? null : parseState(raw.after);
  if (before === null || (raw.after !== null && after === null)) {
    return null;
  }
  return { path, label, before, after };
}

function parseManifest(raw: unknown): UpgradeSnapshotManifest | null {
  if (
    !isRecord(raw) ||
    raw.version !== UPGRADE_SNAPSHOT_VERSION ||
    raw.kind !== UPGRADE_SNAPSHOT_KIND ||
    typeof raw.id !== "string" ||
    !SNAPSHOT_ID.test(raw.id) ||
    typeof raw.purpose !== "string" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Array.isArray(raw.entries)
  ) {
    return null;
  }
  const entries: UpgradeSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const value of raw.entries) {
    const entry = parseEntry(value);
    if (entry === null || seen.has(entry.path)) {
      return null;
    }
    seen.add(entry.path);
    entries.push(entry);
  }
  return {
    version: UPGRADE_SNAPSHOT_VERSION,
    kind: UPGRADE_SNAPSHOT_KIND,
    id: raw.id,
    purpose: raw.purpose,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ISO_SEPARATORS = /[-:]/g;
const ISO_FRACTION = /\.\d+Z$/;

function snapshotId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(ISO_SEPARATORS, "")
    .replace(ISO_FRACTION, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(input: { readonly path: string; readonly dir: string }) {
  const dir = input.dir.endsWith("/") ? input.dir : `${input.dir}/`;
  return input.path === input.dir || input.path.startsWith(dir);
}

async function lstatOrNull(path: string): Promise<Stats | null | "error"> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    return errorCode(error) === "ENOENT" ? null : "error";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}
