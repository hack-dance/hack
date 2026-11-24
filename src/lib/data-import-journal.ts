import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { fsStep, parseJsonText, syncPath } from "./data-backup-helper.ts";
import { isRecord } from "./guards.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "./projects-registry-lock.ts";

/**
 * Per-volume journal of `hack data import`, at
 * `$HACK_HOME/data-imports/<compose project>/<key>.json`. It records which
 * backup is being restored into which Docker volume and how far it got:
 * `started` before the target is created or filled, `complete` once the
 * restored tree matched the manifest digest, `failed` when it did not. A
 * rerun treats a non-empty target as its own interrupted import only when the
 * journal is not complete, names the same backup and target (by the sha256
 * of its Docker name, which can carry env values), and the volume
 * carries the matching `io.hack.data-backup.source` label. Writes are
 * atomic: a temp file, fsync, rename, then fsync of the directory.
 */
export const DATA_IMPORT_JOURNAL_SCHEMA = "hack.data-import-journal.v1";
export const DATA_IMPORTS_DIR_NAME = "data-imports";

export type DataImportJournalState = "started" | "complete" | "failed";

export type DataImportJournal = {
  readonly schema: typeof DATA_IMPORT_JOURNAL_SCHEMA;
  readonly backupId: string;
  readonly backup: string;
  readonly key: string;
  /** sha256 of the target's Docker name (names can carry env values). */
  readonly targetSha256: string;
  readonly state: DataImportJournalState;
  readonly updatedAt: string;
};

export function dataImportJournalPath(opts: {
  readonly hackHome: string;
  readonly composeProject: string;
  readonly key: string;
}): string {
  return join(
    opts.hackHome,
    DATA_IMPORTS_DIR_NAME,
    opts.composeProject,
    `${opts.key}.json`
  );
}

const STATES: readonly string[] = ["started", "complete", "failed"];

/** The journal at `path`, or null when it is missing or unreadable. */
export async function readDataImportJournal(
  path: string
): Promise<DataImportJournal | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  const value = text === null ? undefined : parseJsonText(text);
  if (
    !(
      isRecord(value) &&
      value.schema === DATA_IMPORT_JOURNAL_SCHEMA &&
      typeof value.backupId === "string" &&
      typeof value.backup === "string" &&
      typeof value.key === "string" &&
      typeof value.targetSha256 === "string" &&
      typeof value.state === "string" &&
      STATES.includes(value.state) &&
      typeof value.updatedAt === "string"
    )
  ) {
    return null;
  }
  return value as DataImportJournal;
}

export async function writeDataImportJournal(opts: {
  readonly path: string;
  readonly journal: Omit<DataImportJournal, "schema" | "updatedAt">;
  readonly now: Date;
}): Promise<void> {
  const directory = join(opts.path, "..");
  const temporary = `${opts.path}.${randomBytes(6).toString("hex")}.tmp`;
  const journal: DataImportJournal = {
    schema: DATA_IMPORT_JOURNAL_SCHEMA,
    ...opts.journal,
    updatedAt: opts.now.toISOString(),
  };
  await fsStep({ path: opts.path, operation: "write" }, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await syncPath(temporary);
    await rename(temporary, opts.path);
    await syncPath(directory);
  });
}

/** Bound for taking the import lock; a live holder refuses instead of waiting. */
const IMPORT_LOCK_WAIT_MS = 1000;

/**
 * Run `run` holding the per-project import lock,
 * `$HACK_HOME/data-imports/<compose project>/.lock`, so two imports of one
 * project never overlap. It is the repository's cooperative owner-file lock:
 * a lock left by a process that no longer exists is reclaimed, a live holder
 * refuses with `E_LOCKED` after a short bound.
 */
export async function withDataImportLock<T>(opts: {
  readonly hackHome: string;
  readonly composeProject: string;
  readonly run: () => Promise<T>;
  readonly timeoutMs?: number;
}): Promise<T> {
  const directory = join(
    opts.hackHome,
    DATA_IMPORTS_DIR_NAME,
    opts.composeProject
  );
  const lockPath = join(directory, ".lock");
  await fsStep({ path: directory, operation: "create_directory" }, () =>
    mkdir(directory, { recursive: true, mode: 0o700 })
  );
  try {
    return await withProjectsRegistryLock({
      lockPath,
      timeoutMs: opts.timeoutMs ?? IMPORT_LOCK_WAIT_MS,
      label: "data import",
      run: opts.run,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectsRegistryLockTimeoutError) {
      throw new HackCliError({
        code: "E_LOCKED",
        message: `Another hack data import of Compose project ${opts.composeProject} is running (lock ${lockPath}); nothing was changed. Retry when it finishes.`,
      });
    }
    throw error;
  }
}
