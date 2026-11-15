import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ClosedCliError } from "./cli-result.ts";
import { migrationRefusal, readMigrationFile } from "./env-migration-files.ts";
import { resolveEnvMigrationDataHome } from "./env-migration-home.ts";
import { isRecord } from "./guards.ts";

const verification = new AsyncLocalStorage<string>();

/** Read-only path calculation shared by the journal owner and every env reader. */
export function migrationJournalPath(projectRoot: string): string {
  return join(
    resolveEnvMigrationDataHome(),
    "env-migrations",
    createHash("sha256").update(projectRoot).digest("hex"),
    "journal.json"
  );
}

export class EnvMigrationPendingError extends ClosedCliError {
  constructor(state: "applying" | "rolling_back") {
    super(
      state === "applying"
        ? "An env migration is unfinished. Resume with hack env migrate --apply (add --accept-tracked-env-changes for its tracked edits), or use its rollback manifest. No project command was run."
        : "An env rollback is unfinished. Resume hack env migrate --rollback-manifest with the same manifest before running project commands."
    );
  }
}

async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return resolve(path);
    }
    throw migrationRefusal();
  }
}

function journalRefusal(path: string): ClosedCliError {
  return new ClosedCliError(
    `Env migration journal could not be verified at ${JSON.stringify(path)}. Keep this file and the upgrade snapshots for recovery; no env data was used (values omitted).`
  );
}

/** Central admission: native, Compose, daemon, metadata and value readers all use it. */
export async function assertEnvMigrationReadable(input: {
  readonly projectRoot: string;
}): Promise<void> {
  const projectRoot = await canonicalRoot(input.projectRoot);
  if (verification.getStore() === projectRoot) {
    return;
  }
  const path = migrationJournalPath(projectRoot);
  const file = await readMigrationFile(path).catch(() => {
    throw journalRefusal(path);
  });
  if (file.text === null) {
    return;
  }
  const info = await lstat(path).catch(() => {
    throw journalRefusal(path);
  });
  if (
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0
  ) {
    throw journalRefusal(path);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch {
    throw journalRefusal(path);
  }
  if (
    !(
      isRecord(raw) &&
      raw.version === 1 &&
      raw.kind === "hack-env-migration" &&
      isRecord(raw.project) &&
      raw.project.projectRoot === projectRoot &&
      [
        "applying",
        "complete",
        "cleaning",
        "cleaned",
        "rolling_back",
        "rolled_back",
      ].includes(String(raw.state))
    )
  ) {
    throw journalRefusal(path);
  }
  if (raw.state === "applying" || raw.state === "rolling_back") {
    throw new EnvMigrationPendingError(raw.state);
  }
}

/** Only the journal owner may inspect its completed publications before committing completion. */
export async function withEnvMigrationVerification<T>(input: {
  readonly projectRoot: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  return await verification.run(
    await canonicalRoot(input.projectRoot),
    input.run
  );
}
