import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { HackCliError } from "./cli-result.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_TREE_DIGEST,
  dataBackupHelperImage,
} from "./data-backup-format.ts";
import { dockerReadError, runningContainers } from "./data-backup-volumes.ts";
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
 * A unique helper container name, `hack-data-<purpose>-<24 hex>`. Volume
 * mount events name containers by ID only; the container start events of the
 * same window map each ID to this name, so the mount check can exclude
 * exactly the helpers this run started.
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
 * or any container mounting one of `volumeNames`, runs. Never stops anything.
 */
export async function refuseRunning(opts: {
  readonly docker: DataBackupDocker;
  readonly composeProject: string;
  readonly volumeNames: readonly string[];
  readonly stopCommand: string;
  /** First sentence: what the refusal means for this command. */
  readonly lead: string;
  readonly command: "export" | "import";
  /** Redacts interpolated identifiers from reported container names. */
  readonly redact?: (text: string) => string;
}): Promise<void> {
  const redact = opts.redact ?? ((text: string) => text);
  const running = (await runningContainers(opts)).map(redact);
  if (running.length === 0) {
    return;
  }
  throw new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `${opts.lead} Stop it with \`${opts.stopCommand}\`, then retry. Hack never stops containers for an ${opts.command}.`,
    detail: { running },
  });
}
