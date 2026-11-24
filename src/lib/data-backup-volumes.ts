import { posix } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { dockerEngineFailureError } from "./compose-ps-result.ts";
import type {
  DataBackupDocker,
  DataBackupProcessResult,
} from "./data-backup-docker.ts";
import {
  DATA_BACKUP_VOLUME_NAME,
  type DataBackupSkipped,
} from "./data-backup-format.ts";
import { isRecord } from "./guards.ts";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_VOLUME_LABEL = "com.docker.compose.volume";
const PROJECT_LABEL = COMPOSE_PROJECT_LABEL;
const VOLUME_LABEL = COMPOSE_VOLUME_LABEL;
const VOLUME_FORMAT =
  '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"driver":{{json .Driver}},"mountpoint":{{json .Mountpoint}},"options":{{json .Options}},"labels":{{json .Labels}}}';
const NO_SUCH_VOLUME = /no such volume/i;

/** A declared, non-external volume of the resolved model, not yet inspected. */
export type DeclaredVolume = { readonly key: string; readonly name: string };

/** A declared volume whose Docker labels prove this Compose project owns it. */
export type OwnedVolume = DeclaredVolume & {
  /** The validated inspection every later read must match. */
  readonly identity: InspectedVolume;
  readonly driver: string;
  readonly labels: {
    readonly "com.docker.compose.project": string;
    readonly "com.docker.compose.volume": string;
  };
};

/** The declared volumes of a resolved Compose model, split before any engine read. */
export type DeclaredVolumePlan = {
  readonly composeProject: string;
  readonly declared: readonly DeclaredVolume[];
  /** External volumes: never inspected or read. */
  readonly external: readonly DataBackupSkipped[];
};

function invalidModel(why: string): never {
  throw new HackCliError({
    code: "E_COMPOSE_OUTPUT_INVALID",
    message: `docker compose config returned a model Hack cannot read: ${why}.`,
  });
}

/**
 * Split the top-level `volumes:` of `docker compose config --format json`
 * output. Keys are sorted so the manifest order is stable. Only names that
 * are safe file names are accepted; Compose itself enforces the same set.
 */
export function planDeclaredVolumes(model: unknown): DeclaredVolumePlan {
  if (!isRecord(model)) {
    return invalidModel("not an object");
  }
  const composeProject = model.name;
  if (
    typeof composeProject !== "string" ||
    !DATA_BACKUP_VOLUME_NAME.test(composeProject)
  ) {
    return invalidModel("no valid project name");
  }
  const volumes = model.volumes ?? {};
  if (!isRecord(volumes)) {
    return invalidModel("volumes is not an object");
  }
  const declared: DeclaredVolume[] = [];
  const external: DataBackupSkipped[] = [];
  for (const key of Object.keys(volumes).sort()) {
    const definition = volumes[key] ?? {};
    if (!(DATA_BACKUP_VOLUME_NAME.test(key) && isRecord(definition))) {
      return invalidModel("a volume key is not a plain name");
    }
    const rawName = definition.name ?? `${composeProject}_${key}`;
    const name =
      typeof rawName === "string" && DATA_BACKUP_VOLUME_NAME.test(rawName)
        ? rawName
        : null;
    if (definition.external === true || isRecord(definition.external)) {
      external.push({ key, reason: "external" });
      continue;
    }
    if (name === null) {
      return invalidModel("a volume name is not a plain name");
    }
    declared.push({ key, name });
  }
  return { composeProject, declared, external };
}

/** A failed Docker read, classified as an engine problem when it is one. */
export function dockerReadError(opts: {
  readonly result: DataBackupProcessResult;
  readonly command: string;
  /** The managed values to redact from a quoted engine line. */
  readonly redactValues: readonly string[];
}): HackCliError {
  return (
    dockerEngineFailureError({
      result: opts.result,
      command: opts.command,
      redactValues: opts.redactValues,
    }) ??
    new HackCliError({
      code: "E_UNEXPECTED",
      message: `${opts.command} failed (exit ${opts.result.exitCode}).`,
    })
  );
}

function parseInspect(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

/** What `docker volume inspect` proves about one volume. */
export type InspectedVolume = {
  readonly name: string;
  /** Birth fact; with driver, mountpoint, options and labels, its identity. */
  readonly createdAt: string;
  readonly driver: string;
  readonly mountpoint: string;
  /** Driver options, canonical JSON (`null` when none). */
  readonly options: string;
  readonly labels: Readonly<Record<string, unknown>>;
};

/** Inspect one volume by exact name; null when Docker has no such volume. */
export async function inspectVolume(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
}): Promise<InspectedVolume | null> {
  const result = await opts.docker.capture([
    "docker",
    "volume",
    "inspect",
    "--format",
    VOLUME_FORMAT,
    opts.name,
  ]);
  if (result.exitCode !== 0) {
    if (result.exitCode === 1 && NO_SUCH_VOLUME.test(result.stderr)) {
      return null;
    }
    throw dockerReadError({
      result,
      command: "docker volume inspect",
      redactValues: opts.docker.redactValues,
    });
  }
  const value = parseInspect(result.stdout);
  if (
    !(
      isRecord(value) &&
      value.name === opts.name &&
      typeof value.createdAt === "string" &&
      typeof value.driver === "string" &&
      typeof value.mountpoint === "string"
    )
  ) {
    throw new HackCliError({
      code: "E_UNEXPECTED",
      message:
        "docker volume inspect returned unreadable output for a declared volume; nothing was changed.",
    });
  }
  return {
    name: opts.name,
    createdAt: value.createdAt,
    driver: value.driver,
    mountpoint: value.mountpoint,
    options: canonicalJson(value.options ?? null),
    labels: isRecord(value.labels) ? value.labels : {},
  };
}

function canonicalJson(value: unknown): string {
  if (isRecord(value)) {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key]])
      )
    );
  }
  return JSON.stringify(value);
}

/**
 * Whether two inspections describe the same volume: equal birth time,
 * driver, mountpoint, options and Compose ownership labels. A volume that
 * was removed and recreated under the same name differs in CreatedAt.
 */
/**
 * Inspect `name` again and refuse unless it is still the volume `identity`
 * describes (same CreatedAt, driver, Mountpoint, options and Compose
 * labels). Docker cannot pin a volume against removal: a bind of its
 * Mountpoint is no volume reference, so `docker volume rm` succeeds while a
 * helper holds it and leaves the helper an empty tree. A data command
 * therefore rechecks identity at each point that matters. Only reads: it
 * never creates a volume.
 */
export async function requireUnchangedVolume(opts: {
  readonly docker: DataBackupDocker;
  readonly name: string;
  /** The Compose key, used in messages. */
  readonly key: string;
  readonly identity: InspectedVolume;
  /** When the check runs, as a phrase ("after it was copied"). */
  readonly when: string;
  /** What the refusal leaves behind, as a sentence. */
  readonly consequence: string;
}): Promise<void> {
  const now = await inspectVolume({ docker: opts.docker, name: opts.name });
  if (now !== null && sameVolumeIdentity(opts.identity, now)) {
    return;
  }
  throw new HackCliError({
    code: "E_PROJECT_RUNNING",
    message: `The volume for ${opts.key} was ${now === null ? "removed" : "removed, replaced or relabeled"} ${opts.when}, so what was read may not be its data; ${opts.consequence} Make sure nothing removes or recreates the project's volumes, then retry.`,
    detail: { key: opts.key, reason: "volume_changed" },
  });
}

export function sameVolumeIdentity(
  left: InspectedVolume,
  right: InspectedVolume
): boolean {
  return (
    left.name === right.name &&
    left.createdAt === right.createdAt &&
    left.driver === right.driver &&
    left.mountpoint === right.mountpoint &&
    left.options === right.options &&
    left.labels[PROJECT_LABEL] === right.labels[PROJECT_LABEL] &&
    left.labels[VOLUME_LABEL] === right.labels[VOLUME_LABEL]
  );
}

/**
 * Whether an inspected volume is a plain `local` volume (no driver options),
 * whose data is its Mountpoint directory. A local volume with options (an
 * NFS or bind mount, say) is only mounted there while a container uses it
 * by name, so binding its Mountpoint would read an empty directory.
 */
export function plainLocalInspected(volume: InspectedVolume): boolean {
  return (
    volume.driver === "local" &&
    (volume.options === "null" || volume.options === "{}")
  );
}

/** Whether Compose's own labels name this project and key. */
export function composeOwnsVolume(opts: {
  readonly volume: InspectedVolume;
  readonly composeProject: string;
  readonly key: string;
}): boolean {
  return (
    opts.volume.labels[PROJECT_LABEL] === opts.composeProject &&
    opts.volume.labels[VOLUME_LABEL] === opts.key
  );
}

/**
 * Inspect each declared volume and keep only those labeled for this Compose
 * project and key. A missing volume is "absent"; a volume with other labels
 * is "foreign" and is never mounted.
 */
export async function classifyDeclaredVolumes(opts: {
  readonly docker: DataBackupDocker;
  readonly plan: DeclaredVolumePlan;
}): Promise<{
  readonly owned: readonly OwnedVolume[];
  readonly skipped: readonly DataBackupSkipped[];
}> {
  const owned: OwnedVolume[] = [];
  const skipped: DataBackupSkipped[] = [...opts.plan.external];
  for (const volume of opts.plan.declared) {
    const inspected = await inspectVolume({
      docker: opts.docker,
      name: volume.name,
    });
    if (inspected === null) {
      skipped.push({ key: volume.key, reason: "absent" });
      continue;
    }
    if (
      !composeOwnsVolume({
        volume: inspected,
        composeProject: opts.plan.composeProject,
        key: volume.key,
      })
    ) {
      skipped.push({ key: volume.key, reason: "foreign" });
      continue;
    }
    owned.push({
      ...volume,
      identity: inspected,
      driver: inspected.driver,
      labels: {
        [PROJECT_LABEL]: opts.plan.composeProject,
        [VOLUME_LABEL]: volume.key,
      },
    });
  }
  skipped.sort((a, b) =>
    Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))
  );
  return { owned, skipped };
}

function names(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].sort();
}

/**
 * Running containers that make a copy or restore inconsistent: any of the
 * Compose project's, and any other container that mounts one of the volumes,
 * as short IDs (never names, which can carry interpolated values).
 */
export async function runningContainers(opts: {
  readonly docker: DataBackupDocker;
  readonly composeProject: string;
  readonly volumeNames: readonly string[];
}): Promise<readonly string[]> {
  const filters = [
    `label=${PROJECT_LABEL}=${opts.composeProject}`,
    ...opts.volumeNames.map((name) => `volume=${name}`),
  ];
  const found = new Set<string>();
  for (const filter of filters) {
    const result = await opts.docker.capture([
      "docker",
      "ps",
      "--filter",
      filter,
      "--format",
      "{{.ID}}",
    ]);
    if (result.exitCode !== 0) {
      throw dockerReadError({
        result,
        command: "docker ps",
        redactValues: opts.docker.redactValues,
      });
    }
    for (const name of names(result.stdout)) {
      found.add(name);
    }
  }
  return [...found].sort();
}

/** A volume a data command protects: its Docker name and inspected Mountpoint. */
export type WatchedVolume = {
  readonly name: string;
  readonly mountpoint: string;
};

/** A Docker-side path, lexically normalized without a trailing slash. */
function normalizedDaemonPath(path: string): string {
  const normal = posix.normalize(path);
  return normal.length > 1 && normal.endsWith("/")
    ? normal.slice(0, -1)
    : normal;
}

/** Whether `path` is `root` or inside it. */
function within(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/**
 * Watched volumes a container's mounts reach: a volume mount by name, or
 * any mount whose Source is a watched Mountpoint, inside one or above one.
 * Paths are the daemon's own (they may live in a VM), so they are compared
 * lexically after normalization.
 */
export function mountsReachingVolumes(opts: {
  readonly mounts: readonly unknown[];
  readonly volumes: readonly WatchedVolume[];
}): string[] {
  const reached = new Set<string>();
  for (const mount of opts.mounts) {
    if (!isRecord(mount)) {
      continue;
    }
    for (const volume of opts.volumes) {
      if (mount.Type === "volume" && mount.Name === volume.name) {
        reached.add(volume.name);
        continue;
      }
      if (typeof mount.Source !== "string" || mount.Source === "") {
        continue;
      }
      const source = normalizedDaemonPath(mount.Source);
      const mountpoint = normalizedDaemonPath(volume.mountpoint);
      if (within(source, mountpoint) || within(mountpoint, source)) {
        reached.add(volume.name);
      }
    }
  }
  return [...reached].sort();
}

/** Format of one batched inspect line: the full ID, then the Mounts JSON. */
const ID_AND_MOUNTS = "{{.Id}} {{json .Mounts}}";

/**
 * Inspect `containers` (full IDs) in one bounded call and report which
 * watched volumes each reaches (see {@link mountsReachingVolumes}), by
 * short ID. A container Docker does not answer for (it is gone, or the
 * inspect failed) is `unchecked`: what it mounts is unknown, and callers
 * refuse closed. An engine failure is thrown as one.
 */
export async function containersReachingVolumes(opts: {
  readonly docker: DataBackupDocker;
  readonly containers: readonly string[];
  readonly volumes: readonly WatchedVolume[];
  readonly timeoutMs: number;
}): Promise<{
  readonly mounts: readonly { volume: string; container: string }[];
  readonly unchecked: readonly string[];
}> {
  if (opts.containers.length === 0) {
    return { mounts: [], unchecked: [] };
  }
  const result = await opts.docker.capture(
    [
      "docker",
      "container",
      "inspect",
      "--format",
      ID_AND_MOUNTS,
      ...opts.containers,
    ],
    { timeoutMs: opts.timeoutMs }
  );
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    const engine = dockerEngineFailureError({
      result,
      command: "docker container inspect",
      redactValues: opts.docker.redactValues,
    });
    if (engine) {
      throw engine;
    }
  }
  const answered = new Map<string, readonly unknown[]>();
  for (const line of result.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) {
      continue;
    }
    let mounts: unknown;
    try {
      mounts = JSON.parse(line.slice(space + 1));
    } catch {
      continue;
    }
    if (Array.isArray(mounts)) {
      answered.set(line.slice(0, space), mounts);
    }
  }
  const mounts: { volume: string; container: string }[] = [];
  const unchecked: string[] = [];
  for (const container of opts.containers) {
    const seen = answered.get(container);
    if (seen === undefined) {
      unchecked.push(container.slice(0, 12));
      continue;
    }
    for (const volume of mountsReachingVolumes({
      mounts: seen,
      volumes: opts.volumes,
    })) {
      mounts.push({ volume, container: container.slice(0, 12) });
    }
  }
  return { mounts, unchecked };
}

/**
 * Every running container's full ID, except `exclude` (this run's own),
 * from `docker ps --quiet --no-trunc`.
 */
export async function runningContainerIds(opts: {
  readonly docker: DataBackupDocker;
  readonly exclude: ReadonlySet<string>;
}): Promise<readonly string[]> {
  const result = await opts.docker.capture([
    "docker",
    "ps",
    "--quiet",
    "--no-trunc",
  ]);
  if (result.exitCode !== 0) {
    throw dockerReadError({
      result,
      command: "docker ps",
      redactValues: opts.docker.redactValues,
    });
  }
  return names(result.stdout).filter((id) => !opts.exclude.has(id));
}
