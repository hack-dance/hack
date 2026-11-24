import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { HELPER_NONCE_PATTERN } from "./data-backup-cleanup-instruction.ts";
import type { DataBackupDocker } from "./data-backup-docker.ts";
import {
  engineUnreachableError,
  isEngineUnreachable,
} from "./data-backup-volumes.ts";
import { isRecord } from "./guards.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Under Hack's home: one record per data command run, keyed by nonce. */
export const DATA_CLEANUP_RECORDS_DIR = "data-cleanup";

/**
 * Which setting selected the engine a data command ran on. A context is
 * recorded by name; a DOCKER_HOST only as the fact that the managed env set
 * it, and from which env selection (the overlay); never its value.
 */
export type DataCleanupEngineSource =
  | { readonly kind: "managed-context"; readonly context: string }
  | { readonly kind: "managed-host"; readonly overlay: string | null }
  | { readonly kind: "caller" };

/**
 * The durable record of one data command run, written (and fsynced) before
 * the run creates its first container and removed once every container of
 * the run is confirmed removed. `hack data cleanup --nonce` reads it to
 * reach the same engine: the same project, instance and env selection, and
 * an engine whose endpoint identity hashes the same. It holds no endpoint
 * value and no managed value.
 */
export type DataCleanupRecord = {
  readonly version: 1;
  readonly nonce: string;
  readonly command: "export" | "import";
  /** Hack's project name and branch, never the resolved Compose project. */
  readonly project: string;
  readonly branch: string | null;
  /** The env selection: an overlay name, `null` for base layers. */
  readonly envName: string | null;
  /** True when the run used the configured default (no selection). */
  readonly envDefault: boolean;
  readonly engine: DataCleanupEngineSource;
  /** sha256 of the resolved engine endpoint identity (never the value). */
  readonly endpointSha256: string;
  /**
   * The daemon's own ID (`docker info --format {{.ID}}`) as the run reached
   * it: the positive proof that cleanup reaches the same engine.
   */
  readonly daemonId: string;
  /**
   * Names of this run's creates whose outcome stayed unknown (a timed-out
   * create that never settled). While any are listed, an empty listing
   * proves nothing: cleanup runs the settle check first.
   */
  readonly unresolvedCreates?: readonly string[];
  readonly createdAt: string;
};

export function dataCleanupRecordPath(opts: {
  readonly hackHome: string;
  readonly nonce: string;
}): string {
  return join(opts.hackHome, DATA_CLEANUP_RECORDS_DIR, `${opts.nonce}.json`);
}

/** The engine source the client's managed env selects. */
export function engineSource(opts: {
  readonly docker: DataBackupDocker;
  readonly envName: string | null;
}): DataCleanupEngineSource {
  const engine = opts.docker.engine;
  if (engine?.host) {
    return { kind: "managed-host", overlay: opts.envName };
  }
  if (engine?.context) {
    return { kind: "managed-context", context: engine.context };
  }
  return { kind: "caller" };
}

/**
 * sha256 of the endpoint the client reaches: the effective DOCKER_HOST
 * value (managed over the caller's), else the effective context (managed,
 * the caller's DOCKER_CONTEXT, or the CLI's current one) with its endpoints
 * as `docker context inspect` reports them. Context reads are local CLI
 * reads, not engine calls. Only the digest leaves this function.
 */
export async function endpointDigest(
  docker: DataBackupDocker
): Promise<string> {
  const host = docker.engine?.host ?? process.env.DOCKER_HOST ?? "";
  let identity: string;
  if (host !== "") {
    identity = `host\n${host}`;
  } else {
    let context = docker.engine?.context ?? process.env.DOCKER_CONTEXT ?? "";
    if (context === "") {
      const shown = await docker.capture(["docker", "context", "show"]);
      context = shown.exitCode === 0 ? shown.stdout.trim() : "";
    }
    const inspected = await docker.capture([
      "docker",
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints}}",
      context === "" ? "default" : context,
    ]);
    identity = `context\n${context}\n${inspected.exitCode}\n${inspected.stdout.trim()}`;
  }
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Write the record durably (a new 0600 file, fsynced, renamed into place,
 * the directory fsynced) before the run's first container create.
 */
export async function writeDataCleanupRecord(opts: {
  readonly hackHome: string;
  readonly record: DataCleanupRecord;
}): Promise<void> {
  const dir = join(opts.hackHome, DATA_CLEANUP_RECORDS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = dataCleanupRecordPath({
    hackHome: opts.hackHome,
    nonce: opts.record.nonce,
  });
  const temp = `${path}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(opts.record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/** Remove the record once nothing of the run can be left behind. */
export async function removeDataCleanupRecord(opts: {
  readonly hackHome: string;
  readonly nonce: string;
}): Promise<void> {
  await rm(dataCleanupRecordPath(opts), { force: true });
}

/**
 * The ID of the daemon the client reaches (`docker info --format {{.ID}}`),
 * bounded: an engine it cannot reach, or an empty ID, an error or a
 * timeout, is not an ID.
 */
export async function readDaemonId(opts: {
  readonly docker: DataBackupDocker;
  readonly timeoutMs: number;
}): Promise<
  | { readonly kind: "read"; readonly id: string }
  | { readonly kind: "unreachable" | "unreadable" }
> {
  const info = await opts.docker
    .capture(["docker", "info", "--format", "{{.ID}}"], {
      timeoutMs: opts.timeoutMs,
    })
    .catch(() => null);
  if (info === null) {
    return { kind: "unreadable" };
  }
  if (info.exitCode !== 0) {
    return isEngineUnreachable(info)
      ? { kind: "unreachable" }
      : { kind: "unreadable" };
  }
  const id = info.stdout.trim();
  return id === "" || id.includes("\n")
    ? { kind: "unreadable" }
    : { kind: "read", id };
}

/** The refusal for a cleanup whose record cannot vouch for the engine. */
export function cleanupRecordError(opts: {
  readonly nonce: string;
  readonly why: string;
}): HackCliError {
  return new HackCliError({
    code: "E_DATA_CLEANUP_RECORD",
    message: `hack data cleanup cannot use the cleanup record for nonce ${opts.nonce}: ${opts.why}. Nothing was listed or removed, and no engine was contacted.`,
    detail: { nonce: opts.nonce },
  });
}

/** Read and validate a record; refuses when it is missing or unreadable. */
export async function readDataCleanupRecord(opts: {
  readonly hackHome: string;
  readonly nonce: string;
}): Promise<DataCleanupRecord> {
  const path = dataCleanupRecordPath(opts);
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) {
    throw cleanupRecordError({
      nonce: opts.nonce,
      why: `there is no record under $HACK_HOME/${DATA_CLEANUP_RECORDS_DIR}/ (a data command writes one before it creates any container, and removes it once they are all removed)`,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (
    isRecord(value) &&
    value.daemonId === undefined &&
    isDataCleanupRecord({ ...value, daemonId: "-" }) &&
    value.nonce === opts.nonce
  ) {
    throw cleanupRecordError({
      nonce: opts.nonce,
      why: "the record holds no Docker engine ID (an older Hack wrote it), so it cannot prove which engine the run used",
    });
  }
  if (!isDataCleanupRecord(value) || value.nonce !== opts.nonce) {
    throw cleanupRecordError({
      nonce: opts.nonce,
      why: "the record is unreadable or malformed",
    });
  }
  return value;
}

function isDataCleanupRecord(value: unknown): value is DataCleanupRecord {
  if (!isRecord(value) || value.version !== 1) {
    return false;
  }
  const engine = value.engine;
  const engineOk =
    isRecord(engine) &&
    ((engine.kind === "managed-context" &&
      typeof engine.context === "string") ||
      (engine.kind === "managed-host" &&
        (engine.overlay === null || typeof engine.overlay === "string")) ||
      engine.kind === "caller");
  return (
    typeof value.nonce === "string" &&
    HELPER_NONCE_PATTERN.test(value.nonce) &&
    (value.command === "export" || value.command === "import") &&
    typeof value.project === "string" &&
    (value.branch === null || typeof value.branch === "string") &&
    (value.envName === null || typeof value.envName === "string") &&
    typeof value.envDefault === "boolean" &&
    engineOk &&
    typeof value.daemonId === "string" &&
    value.daemonId !== "" &&
    (value.unresolvedCreates === undefined ||
      (Array.isArray(value.unresolvedCreates) &&
        value.unresolvedCreates.every((name) => typeof name === "string"))) &&
    typeof value.endpointSha256 === "string" &&
    SHA256_HEX.test(value.endpointSha256) &&
    typeof value.createdAt === "string"
  );
}

/**
 * Run `work` under a cleanup record for `helpers.nonce`: written durably
 * before `work` (which creates the run's containers), and removed afterwards
 * only when the run is settled (every container confirmed removed, no
 * create unknown). Otherwise it stays for `hack data cleanup --nonce`.
 */
export async function withDataCleanupRecord<T>(
  opts: {
    readonly hackHome: string;
    readonly command: "export" | "import";
    readonly project: string;
    readonly branch: string | null;
    /** As the model resolved it; `undefined` is the configured default. */
    readonly envSelection: string | null | undefined;
    readonly docker: DataBackupDocker;
    readonly helpers: {
      readonly nonce: string;
      readonly settled: boolean;
      readonly unresolved: ReadonlySet<string>;
    };
    readonly now: Date;
    /** Bound for reading the daemon's ID. */
    readonly commandMs: number;
  },
  work: () => Promise<T>
): Promise<T> {
  const envName = opts.envSelection ?? null;
  // Before any create: the run must know which daemon it reaches.
  const daemonId = await readDaemonId({
    docker: opts.docker,
    timeoutMs: opts.commandMs,
  });
  if (daemonId.kind !== "read") {
    throw daemonId.kind === "unreachable"
      ? engineUnreachableError("docker info")
      : new HackCliError({
          code: "E_DOCKER_UNAVAILABLE",
          message:
            "Hack could not read the selected Docker engine's ID (docker info), so it cannot record which engine this run uses; nothing was created. Check `docker info`, then retry.",
          detail: { reason: "daemon_id_unreadable" },
        });
  }
  const record: DataCleanupRecord = {
    version: 1,
    nonce: opts.helpers.nonce,
    command: opts.command,
    project: opts.project,
    branch: opts.branch,
    envName,
    envDefault: opts.envSelection === undefined,
    engine: engineSource({ docker: opts.docker, envName }),
    endpointSha256: await endpointDigest(opts.docker),
    daemonId: daemonId.id,
    createdAt: opts.now.toISOString(),
  };
  await writeDataCleanupRecord({ hackHome: opts.hackHome, record });
  try {
    return await work();
  } finally {
    if (opts.helpers.settled) {
      await removeDataCleanupRecord({
        hackHome: opts.hackHome,
        nonce: opts.helpers.nonce,
      });
    } else if (opts.helpers.unresolved.size > 0) {
      // Cleanup must not trust an empty listing for these creates. The
      // rename replaces the record atomically: it is never absent.
      await writeDataCleanupRecord({
        hackHome: opts.hackHome,
        record: {
          ...record,
          unresolvedCreates: [...opts.helpers.unresolved].sort(),
        },
      });
    }
  }
}
