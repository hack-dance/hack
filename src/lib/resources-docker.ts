import { dockerHelperRunEnvironment } from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

export const COMPOSE_PROJECT = "com.docker.compose.project";
export const COMPOSE_DIRECTORY = "com.docker.compose.project.working_dir";
export const COMPOSE_VOLUME = "com.docker.compose.volume";
export const COMPOSE_SERVICE = "com.docker.compose.service";
export const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
export const CONTAINER_ID = /^[a-f0-9]{64}$/;
const SIZE = /^(\d+(?:\.\d+)?)\s*(B|kB|KB|MB|GB|TB|PB)$/;
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export type DockerRead = (args: readonly string[]) => Promise<string | null>;

export function dockerResourceReader(opts: {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
}): DockerRead {
  return async (args) => {
    const result = await exec(["docker", ...args], {
      cwd: opts.cwd,
      ...dockerHelperRunEnvironment(opts.env),
      stdin: "ignore",
      timeoutMs: 5000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024,
    }).catch(() => null);
    return result?.exitCode === 0 ? result.stdout.trim() : null;
  };
}

export function readObject(raw: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function dockerDiskBytes(size: string | undefined): number | null {
  const match = SIZE.exec(size ?? "");
  if (!(match?.[1] && match[2])) {
    return null;
  }
  const value = Math.round(
    Number(match[1]) * 1000 ** UNITS.indexOf(match[2].toUpperCase())
  );
  return Number.isSafeInteger(value) ? value : null;
}

export function dockerNames(
  raw: string | null,
  pattern: RegExp
): string[] | null {
  if (raw === null) {
    return null;
  }
  const names = raw ? raw.split("\n") : [];
  return names.length <= 1000 && names.every((name) => pattern.test(name))
    ? names
    : null;
}

export function composeLabel(
  row: Record<string, unknown>,
  key: string
): string | null {
  return isRecord(row.labels) ? (getString(row.labels, key) ?? null) : null;
}

const CONTAINER_INSPECT =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"state":{{json .State.Status}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}}}';
const VOLUME_INSPECT =
  '{"id":{{json .Name}},"created":{{json .CreatedAt}},"driver":{{json .Driver}},"scope":{{json .Scope}},"options":{{json .Options}},"labels":{{json .Labels}}}';

/** Inspect only resource metadata. Container commands and environment are omitted. */
export async function inspectDockerResource(
  read: DockerRead,
  kind: "container" | "volume",
  id: string
) {
  if (!(kind === "container" ? CONTAINER_ID : RESOURCE_NAME).test(id)) {
    return null;
  }
  const row = readObject(
    await read([
      kind,
      "inspect",
      "--format",
      kind === "container" ? CONTAINER_INSPECT : VOLUME_INSPECT,
      id,
    ])
  );
  return row?.id === id ? row : null;
}
