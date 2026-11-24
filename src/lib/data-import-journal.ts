import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fsStep, parseJsonText, syncPath } from "./data-backup-helper.ts";
import { isRecord } from "./guards.ts";

/**
 * Per-volume journal of `hack data import`, at
 * `$HACK_HOME/data-imports/<compose project>/<key>.json`. It records which
 * backup is being restored into which Docker volume and how far it got:
 * `started` before the target is created or filled, `complete` once the
 * restored tree matched the manifest digest, `failed` when it did not. A
 * rerun treats a non-empty target as its own interrupted import only when the
 * journal is not complete, names the same backup and target, and the volume
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
  readonly target: string;
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
      typeof value.target === "string" &&
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
