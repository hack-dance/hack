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

const PROJECT_LABEL = "com.docker.compose.project";
const VOLUME_LABEL = "com.docker.compose.volume";
const VOLUME_FORMAT =
  '{"name":{{json .Name}},"driver":{{json .Driver}},"labels":{{json .Labels}}}';
const NO_SUCH_VOLUME = /no such volume/i;

/** A declared, non-external volume of the resolved model, not yet inspected. */
export type DeclaredVolume = { readonly key: string; readonly name: string };

/** A declared volume whose Docker labels prove this Compose project owns it. */
export type OwnedVolume = DeclaredVolume & {
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
      external.push({ key, name, reason: "external" });
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
}): HackCliError {
  return (
    dockerEngineFailureError({
      result: opts.result,
      command: opts.command,
    }) ??
    new HackCliError({
      code: "E_UNEXPECTED",
      message: `${opts.command} failed (exit ${opts.result.exitCode}); nothing was backed up from that step on.`,
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
    const result = await opts.docker.capture([
      "docker",
      "volume",
      "inspect",
      "--format",
      VOLUME_FORMAT,
      volume.name,
    ]);
    if (result.exitCode !== 0) {
      if (result.exitCode === 1 && NO_SUCH_VOLUME.test(result.stderr)) {
        skipped.push({ ...volume, reason: "absent" });
        continue;
      }
      throw dockerReadError({ result, command: "docker volume inspect" });
    }
    const value = parseInspect(result.stdout);
    if (
      !(
        isRecord(value) &&
        value.name === volume.name &&
        typeof value.driver === "string"
      )
    ) {
      throw new HackCliError({
        code: "E_UNEXPECTED",
        message: `docker volume inspect returned unreadable output for ${volume.name}; nothing was backed up.`,
      });
    }
    const labels = isRecord(value.labels) ? value.labels : {};
    if (
      labels[PROJECT_LABEL] !== opts.plan.composeProject ||
      labels[VOLUME_LABEL] !== volume.key
    ) {
      skipped.push({ ...volume, reason: "foreign" });
      continue;
    }
    owned.push({
      ...volume,
      driver: value.driver,
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
 * Running containers that make a copy inconsistent: any of the Compose
 * project's, and any other container that mounts one of the owned volumes.
 */
export async function runningContainers(opts: {
  readonly docker: DataBackupDocker;
  readonly composeProject: string;
  readonly volumes: readonly OwnedVolume[];
}): Promise<readonly string[]> {
  const filters = [
    `label=${PROJECT_LABEL}=${opts.composeProject}`,
    ...opts.volumes.map((volume) => `volume=${volume.name}`),
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
