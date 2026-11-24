import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { HackCliError } from "./cli-result.ts";
import type { BackingProver } from "./data-backup-backing-proof.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_TREE_DIGEST,
  dataBackupHelperImage,
} from "./data-backup-format.ts";
import {
  containersReachingVolumes,
  dockerReadError,
  runningContainerIds,
  runningContainers,
  uncheckedBackingError,
  type WatchedVolume,
} from "./data-backup-volumes.ts";
import { closedFileWriteError, type FileWriteOperation } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * Shared pieces of `hack data export` and `hack data import`: helper names
 * and failures, the tree-digest parser, the running refusal and the closed
 * filesystem step wrapper. The held helper container is in
 * data-backup-held-volume.ts.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Run one filesystem step; a classified errno becomes a closed refusal. */
export async function fsStep<T>(
  opts: { readonly path: string; readonly operation: FileWriteOperation },
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    throw closedFileWriteError({ error, ...opts });
  }
}

export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type HelperPurpose = "export" | "import";

/**
 * A unique helper container name, `hack-data-<purpose>-<24 hex>`, for
 * `docker ps` readability only: Hack tracks and removes its containers by
 * the ID their create returned, never by this name.
 */
export function helperContainerName(purpose: HelperPurpose): string {
  return `hack-data-${purpose}-${randomBytes(12).toString("hex")}`;
}

/**
 * A failed helper run, classified as an engine problem when it is one.
 * `volume` is the Compose key: resolved Docker names are never printed.
 */
export function helperFailure(opts: {
  readonly volume: string;
  readonly action: string;
  readonly result: { readonly exitCode: number; readonly stderr: string };
  readonly consequence: string;
  /** The managed values to redact from a quoted engine line. */
  readonly redactValues: readonly string[];
}): HackCliError {
  const engine = dockerReadError({
    result: { ...opts.result, stdout: "" },
    command: "docker run",
    redactValues: opts.redactValues,
  });
  if (engine.code !== "E_UNEXPECTED") {
    return engine;
  }
  return new HackCliError({
    code: "E_UNEXPECTED",
    message: `The backup helper failed to ${opts.action} volume ${opts.volume} (exit ${opts.result.exitCode}); ${opts.consequence} The helper image is ${dataBackupHelperImage()}; check that Docker can run it.`,
  });
}

export type TreeDigest = {
  readonly entries: number;
  readonly excludedSockets: number;
  readonly digest: string;
};

/** Parse a helper's {@link DATA_BACKUP_TREE_DIGEST} output, closed. */
export function parseTreeDigest(opts: {
  readonly stdout: string;
  /** The Compose key, used in messages instead of the Docker name. */
  readonly label: string;
  readonly consequence: string;
}): TreeDigest {
  const tree = parseJsonText(opts.stdout.trim());
  if (
    !(
      isRecord(tree) &&
      tree.algorithm === DATA_BACKUP_TREE_DIGEST &&
      typeof tree.entries === "number" &&
      Number.isSafeInteger(tree.entries) &&
      tree.entries > 0 &&
      typeof tree.excludedSockets === "number" &&
      Number.isSafeInteger(tree.excludedSockets) &&
      tree.excludedSockets >= 0 &&
      typeof tree.digest === "string" &&
      SHA256_HEX.test(tree.digest)
    )
  ) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message: `The backup helper returned an unreadable digest for volume ${opts.label}; ${opts.consequence}`,
    });
  }
  return {
    entries: tree.entries,
    excludedSockets: tree.excludedSockets,
    digest: tree.digest,
  };
}

/**
 * Refuse with `E_PROJECT_RUNNING` while a container of the Compose project,
 * or any container using one of `volumes`, runs. Never stops anything.
 *
 * `docker ps --filter volume=` sees only volume mounts by name, so every
 * other running container (except this run's own, by ID) is inspected too,
 * in one bounded call: a bind whose Source is a watched Mountpoint, a path
 * inside it or a directory above it uses that volume as surely as a volume
 * mount does (Hack's own helpers use exactly that technique). A running
 * container that cannot be inspected refuses closed
 * (`detail.reason: unchecked_running`).
 *
 * `detail.running` lists short container IDs, never names: a name can carry
 * interpolated env values (`container_name: db-${TOKEN}`).
 */
export async function refuseRunning(opts: {
  readonly docker: DataBackupDocker;
  readonly composeProject: string;
  readonly volumes: readonly WatchedVolume[];
  /** IDs of the containers this run created: never inspected or refused. */
  readonly exclude: ReadonlySet<string>;
  /** Bound for the batched inspect. */
  readonly timeoutMs: number;
  /** Daemon-side proof for bind sources and alias devices; see the volume reach check. */
  readonly prove?: BackingProver;
  readonly stopCommand: string;
  /** First sentence: what the refusal means for this command. */
  readonly lead: string;
  readonly command: "export" | "import";
}): Promise<void> {
  const listed = await runningContainers({
    docker: opts.docker,
    composeProject: opts.composeProject,
    volumeNames: opts.volumes.map((volume) => volume.name),
  });
  const reach = await containersReachingVolumes({
    docker: opts.docker,
    containers: await runningContainerIds({
      docker: opts.docker,
      exclude: opts.exclude,
    }),
    volumes: opts.volumes,
    timeoutMs: opts.timeoutMs,
    prove: opts.prove,
  });
  const running = [
    ...new Set([...listed, ...reach.mounts.map((mount) => mount.container)]),
  ].sort();
  const stop = `Stop it with \`${opts.stopCommand}\`, then retry. Hack never stops containers for an ${opts.command}.`;
  if (running.length > 0) {
    throw new HackCliError({
      code: "E_PROJECT_RUNNING",
      message: `${opts.lead} ${stop}`,
      detail: { running },
    });
  }
  if (reach.unchecked.length > 0) {
    throw new HackCliError({
      code: "E_PROJECT_RUNNING",
      message: `A running container (${reach.unchecked.join(", ")}) could not be checked (it was gone or could not be inspected), so Hack cannot prove it does not use the project's volumes; nothing was ${opts.command === "export" ? "published" : "marked complete"}. If nothing else should be using them, retry.`,
      detail: { unchecked: reach.unchecked, reason: "unchecked_running" },
    });
  }
  if (reach.uncheckedBacking.length > 0) {
    throw uncheckedBackingError({
      containers: reach.uncheckedBacking,
      consequence: `nothing was ${opts.command === "export" ? "published" : "marked complete"}.`,
    });
  }
}
