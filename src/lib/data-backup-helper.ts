import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { HackCliError } from "./cli-result.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  DATA_BACKUP_DIGEST_SCRIPT,
  DATA_BACKUP_TREE_DIGEST,
  dataBackupHelperImage,
} from "./data-backup-format.ts";
import { dockerReadError, runningContainers } from "./data-backup-volumes.ts";
import { closedFileWriteError, type FileWriteOperation } from "./fs.ts";
import { isRecord } from "./guards.ts";

/**
 * Shared pieces of `hack data export` and `hack data import`: the helper
 * container argv, the in-helper tree digest, the running refusal and the
 * closed filesystem step wrapper.
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
 * `docker run` of the pinned helper with one volume at `/v`: removed on exit,
 * no network, read-only root file system, no privilege gain. `readOnly`
 * mounts the volume read-only; `stdin` keeps stdin open for a tar stream.
 * `name` comes from {@link helperContainerName}.
 */
export function dataBackupHelperArgv(opts: {
  readonly name: string;
  readonly volume: string;
  readonly readOnly: boolean;
  readonly entrypoint: string;
  readonly purpose: HelperPurpose;
  readonly stdin?: boolean;
  readonly extra?: readonly string[];
}): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    opts.name,
    "--network",
    "none",
    "--pull",
    "missing",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--label",
    `io.hack.data-backup=${opts.purpose}`,
    ...(opts.stdin ? ["--interactive"] : []),
    ...(opts.extra ?? []),
    "--volume",
    `${opts.volume}:/v${opts.readOnly ? ":ro" : ""}`,
    "--entrypoint",
    opts.entrypoint,
    dataBackupHelperImage(),
  ];
}

/** A failed helper run, classified as an engine problem when it is one. */
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

/** The {@link DATA_BACKUP_TREE_DIGEST} of one volume, read-only in the helper. */
export async function treeDigest(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  readonly volume: string;
  readonly purpose: HelperPurpose;
  readonly consequence: string;
}): Promise<TreeDigest> {
  const result = await opts.docker.capture(
    [
      ...dataBackupHelperArgv({
        name: opts.name,
        volume: opts.volume,
        readOnly: true,
        entrypoint: "bun",
        purpose: opts.purpose,
        extra: [
          "--tmpfs",
          "/tmp",
          "--env",
          "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
        ],
      }),
      "-e",
      DATA_BACKUP_DIGEST_SCRIPT,
    ],
    { unbounded: true }
  );
  if (result.exitCode !== 0) {
    throw helperFailure({
      volume: opts.volume,
      action: "digest",
      result,
      consequence: opts.consequence,
    });
  }
  const tree = parseJsonText(result.stdout.trim());
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
      message: `The backup helper returned an unreadable digest for volume ${opts.volume}; ${opts.consequence}`,
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
}): Promise<void> {
  const running = await runningContainers(opts);
  if (running.length === 0) {
    return;
  }
  throw new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `${opts.lead} Stop it with \`${opts.stopCommand}\`, then retry. Hack never stops containers for an ${opts.command}.`,
    detail: { running },
  });
}

/** Docker's `--since`/`--until` form: Unix seconds with millisecond precision. */
export function dockerEventTime(date: Date): string {
  return (date.getTime() / 1000).toFixed(3);
}

export type ForeignMount = {
  readonly volume: string;
  readonly container: string;
  /** The container's name from its start event, or null when none was seen. */
  readonly name: string | null;
};

/**
 * Mounts of `volumeNames` between `since` and `until` by any container other
 * than this run's helpers. Two `docker ps` snapshots miss a short-lived
 * writer that starts and exits between them (a `--rm` container leaves no
 * trace); the engine's event log does not. Volume mount events carry the
 * container ID (`Actor.Attributes.container`); container start events of the
 * same window carry its name, which identifies our helpers. A mount whose
 * container has no start event in the window counts as foreign. The read is
 * bounded: `--until` makes Docker return instead of following.
 */
export async function foreignVolumeMounts(opts: {
  readonly docker: DataBackupDocker;
  readonly since: Date;
  readonly until: Date;
  readonly volumeNames: readonly string[];
  readonly helperNames: ReadonlySet<string>;
}): Promise<readonly ForeignMount[]> {
  if (opts.volumeNames.length === 0) {
    return [];
  }
  const result = await opts.docker.capture([
    "docker",
    "events",
    "--since",
    dockerEventTime(opts.since),
    "--until",
    dockerEventTime(opts.until),
    "--filter",
    "type=volume",
    "--filter",
    "type=container",
    "--filter",
    "event=mount",
    "--filter",
    "event=start",
    "--format",
    "{{json .}}",
  ]);
  if (result.exitCode !== 0) {
    throw dockerReadError({ result, command: "docker events" });
  }
  const names = new Map<string, string>();
  const mounts: { volume: string; container: string }[] = [];
  const watched = new Set(opts.volumeNames);
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const event = parseJsonText(line);
    const actor = isRecord(event) && isRecord(event.Actor) ? event.Actor : null;
    const attributes =
      actor && isRecord(actor.Attributes) ? actor.Attributes : null;
    if (!(isRecord(event) && actor && attributes)) {
      throw new HackCliError({
        code: "E_UNEXPECTED",
        message: "docker events returned a line Hack cannot read.",
      });
    }
    if (
      event.Type === "container" &&
      event.Action === "start" &&
      typeof actor.ID === "string" &&
      typeof attributes.name === "string"
    ) {
      names.set(actor.ID, attributes.name);
    } else if (
      event.Type === "volume" &&
      event.Action === "mount" &&
      typeof actor.ID === "string" &&
      watched.has(actor.ID) &&
      typeof attributes.container === "string"
    ) {
      mounts.push({ volume: actor.ID, container: attributes.container });
    }
  }
  return mounts
    .map((mount) => ({ ...mount, name: names.get(mount.container) ?? null }))
    .filter((mount) => !(mount.name && opts.helperNames.has(mount.name)));
}
