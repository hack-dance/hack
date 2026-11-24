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
export type DeclaredVolume = {
  readonly key: string;
  readonly name: string;
  /** The declared driver; `local` when the model names none. */
  readonly driver: string;
  /** Whether the model declares `driver_opts` (for example an NFS mount). */
  readonly driverOpts: boolean;
};

/** Whether a declared or inspected volume is a plain `local` volume. */
export function plainLocalVolume(opts: {
  readonly driver: string;
  readonly driverOpts: boolean;
}): boolean {
  return opts.driver === "local" && !opts.driverOpts;
}

function hasEntries(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function declaredDriver(definition: Record<string, unknown>): {
  readonly driver: string;
  readonly driverOpts: boolean;
} {
  return {
    driver: typeof definition.driver === "string" ? definition.driver : "local",
    driverOpts: hasEntries(definition.driver_opts),
  };
}

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
    declared.push({ key, name, ...declaredDriver(definition) });
  }
  return { composeProject, declared, external };
}

/** A failed Docker read, classified as an engine problem when it is one. */
export function dockerReadError(opts: {
  readonly result: DataBackupProcessResult;
  readonly command: string;
}): HackCliError {
  return (
    dockerEngineFailureError({
      result: opts.result,
      command: opts.command,
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
  /** Whether the volume was created with driver options. */
  readonly driverOpts: boolean;
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
    throw dockerReadError({ result, command: "docker volume inspect" });
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
    driverOpts: hasEntries(value.options),
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
 * Compose project's, and any other container that mounts one of the volumes.
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
      "{{.Names}}",
    ]);
    if (result.exitCode !== 0) {
      throw dockerReadError({ result, command: "docker ps" });
    }
    for (const name of names(result.stdout)) {
      found.add(name);
    }
  }
  return [...found].sort();
}
