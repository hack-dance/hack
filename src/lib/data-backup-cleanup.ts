import { HackCliError } from "./cli-result.ts";
import { HELPER_NONCE_LABEL } from "./data-backup-cleanup-instruction.ts";
import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import { removeContainerConfirmed } from "./data-backup-held-volume.ts";
import { dockerReadError } from "./data-backup-volumes.ts";
import {
  type DataCleanupRecord,
  removeDataCleanupRecord,
  writeDataCleanupRecord,
} from "./data-cleanup-record.ts";

/** What `hack data cleanup` found and removed, by full container ID. */
export type DataCleanupResult = {
  readonly nonce: string;
  readonly label: string;
  /** Every container Docker listed under the label. */
  readonly listed: readonly string[];
  readonly removed: readonly string[];
  /**
   * Listed containers Hack could not verify (their inspect failed or timed
   * out) or whose removal Docker could not confirm.
   */
  readonly unconfirmed: readonly string[];
};

const CONTAINER_ID = /^[0-9a-f]{64}$/;
/** Docker prints a container's `.Name` with a leading slash. */
const LEADING_SLASH = /^\//;

/**
 * Remove the containers a data command created under `nonce` (and could
 * not reconcile): every container, running or not, whose
 * `io.hack.data-backup.nonce` label equals the nonce, by the IDs Docker
 * lists, each removal confirmed. Uses the given client, so the managed env
 * selects the same engine the data command used. Never removes a volume
 * (`docker rm --force` without `--volumes`).
 */
export async function cleanupDataHelpers(opts: {
  readonly docker: DataBackupDocker;
  readonly nonce: string;
  readonly deadlines: DataBackupDeadlines;
}): Promise<DataCleanupResult> {
  return (await removeLabeled(opts)).result;
}

/**
 * {@link cleanupDataHelpers}, also naming the containers whose removal it
 * confirmed (by the name Docker read back with the label).
 */
async function removeLabeled(opts: {
  readonly docker: DataBackupDocker;
  readonly nonce: string;
  readonly deadlines: DataBackupDeadlines;
}): Promise<{
  readonly result: DataCleanupResult;
  readonly removedNames: ReadonlySet<string>;
}> {
  const label = `${HELPER_NONCE_LABEL}=${opts.nonce}`;
  const listed = await opts.docker.capture(
    [
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=${label}`,
    ],
    { timeoutMs: opts.deadlines.commandMs }
  );
  if (listed.exitCode !== 0) {
    throw dockerReadError({
      result: listed,
      command: "docker ps",
      redactValues: opts.docker.redactValues,
    });
  }
  const ids = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => CONTAINER_ID.test(line))
    ),
  ];
  // Only a container whose label holds exactly this nonce, read back by ID
  // with its name. One Docker listed but Hack cannot read back is not
  // settled: unconfirmed.
  const matching: { readonly id: string; readonly name: string }[] = [];
  const unconfirmed: string[] = [];
  for (const id of ids) {
    const read = await opts.docker.capture(
      [
        "docker",
        "container",
        "inspect",
        "--format",
        `{{index .Config.Labels "${HELPER_NONCE_LABEL}"}} {{.Name}}`,
        id,
      ],
      { timeoutMs: opts.deadlines.commandMs }
    );
    const [value = "", name = ""] = read.stdout.trim().split(" ");
    if (read.exitCode !== 0) {
      unconfirmed.push(id);
    } else if (value === opts.nonce) {
      matching.push({ id, name: name.replace(LEADING_SLASH, "") });
    }
  }
  const removed: string[] = [];
  const removedNames = new Set<string>();
  for (const { id, name } of matching) {
    if (
      await removeContainerConfirmed({
        docker: opts.docker,
        container: id,
        deadlines: opts.deadlines,
      })
    ) {
      removed.push(id);
      removedNames.add(name);
    } else {
      unconfirmed.push(id);
    }
  }
  return {
    result: { nonce: opts.nonce, label, listed: ids, removed, unconfirmed },
    removedNames,
  };
}

/**
 * `hack data cleanup`'s removal under the record's rule. Every container
 * labeled with the nonce is removed (see {@link cleanupDataHelpers}). A
 * create the run recorded as unresolved (it timed out or was interrupted
 * and was never found) is resolved only when this cleanup found and removed
 * a container of that exact name with the nonce: Docker emits no event for
 * a create that fails or is abandoned, so an empty listing, or any quiet
 * time, never proves the container will not appear later. `settled` is
 * true only when every listed container's removal is confirmed and no
 * recorded create is left unresolved; only then may the record be removed.
 */
export async function resolveDataCleanup(opts: {
  readonly docker: DataBackupDocker;
  readonly nonce: string;
  readonly deadlines: DataBackupDeadlines;
  readonly unresolvedCreates: readonly string[];
}): Promise<{
  readonly result: DataCleanupResult;
  /** The recorded creates still unresolved after this cleanup, by name. */
  readonly unresolved: readonly string[];
  readonly settled: boolean;
}> {
  const { result, removedNames } = await removeLabeled(opts);
  const unresolved = opts.unresolvedCreates.filter(
    (name) => !removedNames.has(name)
  );
  return {
    result,
    unresolved,
    settled: result.unconfirmed.length === 0 && unresolved.length === 0,
  };
}

/**
 * `hack data cleanup` once the record's engine is proven: remove the
 * nonce's containers, then delete the record only if
 * {@link resolveDataCleanup} settled. Otherwise the record stays, narrowed
 * to the creates still unresolved (rewritten atomically), and a create left
 * unresolved throws the unknown outcome naming it. Returns the result for
 * the caller to report (including any unconfirmed removal).
 */
export async function cleanupRecordedRun(opts: {
  readonly hackHome: string;
  readonly record: DataCleanupRecord;
  readonly docker: DataBackupDocker;
  readonly deadlines: DataBackupDeadlines;
}): Promise<DataCleanupResult> {
  const { hackHome, record } = opts;
  const recorded = record.unresolvedCreates ?? [];
  const { result, unresolved, settled } = await resolveDataCleanup({
    docker: opts.docker,
    nonce: record.nonce,
    deadlines: opts.deadlines,
    unresolvedCreates: recorded,
  });
  if (settled) {
    await removeDataCleanupRecord({ hackHome, nonce: record.nonce });
  } else if (unresolved.length < recorded.length) {
    await writeDataCleanupRecord({
      hackHome,
      record: { ...record, unresolvedCreates: unresolved },
    });
  }
  if (unresolved.length > 0) {
    throw unresolvedCreatesError({ result, unresolved });
  }
  return result;
}

/**
 * A recorded create that timed out and that no cleanup has found yet: the
 * record stays, by container name and nonce label only.
 */
function unresolvedCreatesError(opts: {
  readonly result: DataCleanupResult;
  readonly unresolved: readonly string[];
}): HackCliError {
  const { result, unresolved } = opts;
  const removed =
    result.removed.length === 0
      ? ""
      : `Removed ${result.removed.length} container${result.removed.length === 1 ? "" : "s"} labeled ${result.label}. `;
  const unconfirmed =
    result.unconfirmed.length === 0
      ? ""
      : ` Hack also could not verify or confirm the removal of ${result.unconfirmed.length} labeled container${result.unconfirmed.length === 1 ? "" : "s"} (${result.unconfirmed.map((id) => id.slice(0, 12)).join(", ")}).`;
  return new HackCliError({
    code: "E_UNEXPECTED",
    message: `${removed}The ${unresolved.length === 1 ? "create" : "creates"} of ${unresolved.join(", ")} (label ${result.label}) timed out or was interrupted, and no container of ${unresolved.length === 1 ? "that name" : "those names"} with the label has been found. Docker reports no event for a create that fails, so Hack cannot prove the container will not appear later.${unconfirmed} The cleanup record stays until a later \`hack data cleanup --nonce ${result.nonce}\` finds and removes the container.`,
    detail: { ...result, outcome: "unknown", unresolvedCreates: unresolved },
  });
}
