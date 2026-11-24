import { HELPER_NONCE_LABEL } from "./data-backup-cleanup-instruction.ts";
import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import { removeContainerConfirmed } from "./data-backup-held-volume.ts";
import { dockerReadError } from "./data-backup-volumes.ts";

/** What `hack data cleanup` found and removed, by full container ID. */
export type DataCleanupResult = {
  readonly nonce: string;
  readonly label: string;
  readonly removed: readonly string[];
  /** Containers whose removal Docker could not confirm. */
  readonly unconfirmed: readonly string[];
};

const CONTAINER_ID = /^[0-9a-f]{64}$/;

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
  // Only a container whose label holds exactly this nonce, read back by ID.
  const matching: string[] = [];
  for (const id of ids) {
    const read = await opts.docker.capture(
      [
        "docker",
        "container",
        "inspect",
        "--format",
        `{{index .Config.Labels "${HELPER_NONCE_LABEL}"}}`,
        id,
      ],
      { timeoutMs: opts.deadlines.commandMs }
    );
    if (read.exitCode === 0 && read.stdout.trim() === opts.nonce) {
      matching.push(id);
    }
  }
  const removed: string[] = [];
  const unconfirmed: string[] = [];
  for (const id of matching) {
    if (
      await removeContainerConfirmed({
        docker: opts.docker,
        container: id,
        deadlines: opts.deadlines,
      })
    ) {
      removed.push(id);
    } else {
      unconfirmed.push(id);
    }
  }
  return { nonce: opts.nonce, label, removed, unconfirmed };
}
