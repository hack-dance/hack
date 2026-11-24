import { HELPER_NONCE_LABEL } from "./data-backup-cleanup-instruction.ts";
import type { DataBackupDeadlines } from "./data-backup-deadlines.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import { removeContainerConfirmed } from "./data-backup-held-volume.ts";
import { dockerReadError } from "./data-backup-volumes.ts";

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
  // One Docker listed but Hack cannot read back is not settled: unconfirmed.
  const matching: string[] = [];
  const unconfirmed: string[] = [];
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
    if (read.exitCode !== 0) {
      unconfirmed.push(id);
    } else if (read.stdout.trim() === opts.nonce) {
      matching.push(id);
    }
  }
  const removed: string[] = [];
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
  return { nonce: opts.nonce, label, listed: ids, removed, unconfirmed };
}

/**
 * `hack data cleanup`'s removal under the record's settle rule. When the
 * listing is empty and the record names creates whose outcome stayed
 * unknown (a timed-out create), the empty listing proves nothing on its
 * own: watch a label-filtered `docker events` subscription for a container
 * `create` with the nonce for `settleMs`, then list once more. A container
 * that shows up is removed as usual. `settled` is true only when the list
 * is empty and, if the record had unresolved creates, the watch stayed live
 * through the window, saw no create, and the final listing was empty; only
 * then may the record be removed.
 */
export async function cleanupWithSettle(opts: {
  readonly docker: DataBackupDocker;
  readonly nonce: string;
  readonly deadlines: DataBackupDeadlines;
  readonly unresolvedCreates: readonly string[];
  readonly settleMs: number;
}): Promise<{ readonly result: DataCleanupResult; readonly settled: boolean }> {
  const first = await cleanupDataHelpers(opts);
  if (first.listed.length > 0 || opts.unresolvedCreates.length === 0) {
    return { result: first, settled: first.unconfirmed.length === 0 };
  }
  const quiet = await watchForNonceCreates({
    docker: opts.docker,
    nonce: opts.nonce,
    settleMs: opts.settleMs,
  });
  const again = await cleanupDataHelpers(opts);
  if (again.listed.length > 0) {
    return { result: again, settled: again.unconfirmed.length === 0 };
  }
  return { result: again, settled: quiet };
}

/**
 * Watch `docker events` for a container `create` labeled with `nonce` for
 * `settleMs`; true when the subscription stayed live and saw none.
 */
async function watchForNonceCreates(opts: {
  readonly docker: DataBackupDocker;
  readonly nonce: string;
  readonly settleMs: number;
}): Promise<boolean> {
  let seen = false;
  let ended = false;
  const watch = opts.docker.watch(
    [
      "docker",
      "events",
      "--filter",
      "type=container",
      "--filter",
      "event=create",
      "--filter",
      `label=${HELPER_NONCE_LABEL}=${opts.nonce}`,
      "--format",
      "{{json .}}",
    ],
    (line) => {
      if (line.trim() !== "") {
        seen = true;
      }
    }
  );
  void watch.done.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    }
  );
  await Bun.sleep(opts.settleMs);
  const live = !ended;
  await watch.stop();
  return live && !seen;
}
