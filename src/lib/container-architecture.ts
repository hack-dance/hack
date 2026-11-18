/**
 * Image architecture of Compose containers, compared with the engine's own
 * architecture (HACK-2323).
 *
 * A container runs emulated when its image's architecture differs from the
 * engine's. The Compose file alone cannot prove that: a removed `platform:`
 * pin still leaves a locally cached tag of the other architecture in use, so
 * these reads inspect the image each container was created from.
 *
 * Every read is best effort and bounded. A missing Docker CLI, a refused
 * socket, a timeout or unparsable output yields "unknown", never a guess;
 * callers omit the finding instead of reporting a false architecture.
 */

import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

/** Normalized CPU architecture names, as Docker image metadata spells them. */
export type ContainerArchitecture = "amd64" | "arm64" | (string & {});

/** The subset of a subprocess result these reads use. */
export type ArchitectureProbeResult = {
  readonly exitCode: number;
  readonly stdout: string;
};

/** Runs one Docker CLI argv (without the leading `docker`). Injected in tests. */
export type ArchitectureProbe = (
  args: readonly string[]
) => Promise<ArchitectureProbeResult>;

const PROBE_TIMEOUT_MS = 5000;
/** Total time `hack ps --json` spends on the `emulated` annotation. */
const PS_ANNOTATION_DEADLINE_MS = 3000;

/** The default probe: one bounded `docker` call, stdin closed. */
export const dockerArchitectureProbe: ArchitectureProbe = async (args) => {
  try {
    const res = await exec(["docker", ...args], {
      stdin: "ignore",
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { exitCode: res.exitCode, stdout: res.stdout };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
};

const ALIASES: Readonly<Record<string, string>> = {
  x86_64: "amd64",
  x64: "amd64",
  amd64: "amd64",
  aarch64: "arm64",
  arm64: "arm64",
};

/** `x86_64`/`x64` become `amd64`, `aarch64` becomes `arm64`; others pass lowercased. */
export function normalizeArchitecture(value: string): ContainerArchitecture {
  const lower = value.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
}

/**
 * The architecture a Compose `platform` value selects (`linux/amd64`,
 * `linux/arm64/v8`, `amd64`), or null when the value has none.
 */
export function platformArchitecture(
  platform: string
): ContainerArchitecture | null {
  const parts = platform.trim().split("/");
  const arch = parts.length >= 2 ? parts[1] : parts[0];
  return arch ? normalizeArchitecture(arch) : null;
}

/** This process's architecture, normalized; the fallback when Docker cannot answer. */
export function processArchitecture(): ContainerArchitecture {
  return normalizeArchitecture(process.arch);
}

/**
 * The engine's architecture (`docker version` server arch), else null. On
 * Docker Desktop and OrbStack this is the Linux VM's architecture, which is
 * what decides whether a container runs emulated.
 */
export async function readEngineArchitecture(
  probe: ArchitectureProbe = dockerArchitectureProbe
): Promise<ContainerArchitecture | null> {
  const res = await probe(["version", "--format", "{{json .Server.Arch}}"]);
  if (res.exitCode !== 0) {
    return null;
  }
  const value = parseJsonString(res.stdout.trim());
  return value ? normalizeArchitecture(value) : null;
}

/**
 * Image architecture per container id. Two bounded Docker reads: the
 * containers' image ids, then those images' architectures. Ids Docker cannot
 * resolve are absent from the result.
 */
export async function inspectContainerArchitectures(opts: {
  readonly ids: readonly string[];
  readonly probe?: ArchitectureProbe;
}): Promise<ReadonlyMap<string, ContainerArchitecture>> {
  const probe = opts.probe ?? dockerArchitectureProbe;
  const ids = [...new Set(opts.ids.filter((id) => id.length > 0))];
  const out = new Map<string, ContainerArchitecture>();
  if (ids.length === 0) {
    return out;
  }
  const containers = await probe([
    "inspect",
    "--type",
    "container",
    "--format",
    '{"id":{{json .Id}},"image":{{json .Image}}}',
    ...ids,
  ]);
  // A missing id makes `docker inspect` exit 1 but still print the others.
  const imageByContainer = new Map<string, string>();
  for (const row of parseJsonLines(containers.stdout)) {
    const id = row.id;
    const image = row.image;
    if (typeof id === "string" && typeof image === "string" && image) {
      imageByContainer.set(id, image);
    }
  }
  const imageIds = [...new Set(imageByContainer.values())];
  if (imageIds.length === 0) {
    return out;
  }
  const images = await probe([
    "image",
    "inspect",
    "--format",
    '{"id":{{json .Id}},"arch":{{json .Architecture}}}',
    ...imageIds,
  ]);
  const archByImage = new Map<string, ContainerArchitecture>();
  for (const row of parseJsonLines(images.stdout)) {
    if (
      typeof row.id === "string" &&
      typeof row.arch === "string" &&
      row.arch
    ) {
      archByImage.set(row.id, normalizeArchitecture(row.arch));
    }
  }
  for (const [containerId, imageId] of imageByContainer) {
    const arch = archByImage.get(imageId);
    if (!arch) {
      continue;
    }
    out.set(containerId, arch);
    // Callers may hold the short id `docker ps` prints.
    for (const requested of ids) {
      if (containerId.startsWith(requested)) {
        out.set(requested, arch);
      }
    }
  }
  return out;
}

function parseJsonString(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) {
        rows.push(value);
      }
    } catch {
      // Not ours to interpret; the id stays unknown.
    }
  }
  return rows;
}

/**
 * `hack ps --json` items with `emulated: true` added to each container whose
 * image architecture differs from the engine's (HACK-2323). Additive only:
 * native and unknown items are returned unchanged, and a failed read leaves
 * every item unchanged.
 */
export async function annotateEmulatedPsItems(opts: {
  readonly items: readonly Record<string, unknown>[];
  readonly probe?: ArchitectureProbe;
  readonly deadlineMs?: number;
}): Promise<Record<string, unknown>[]> {
  const probe = opts.probe ?? dockerArchitectureProbe;
  const ids = opts.items.flatMap((item) =>
    typeof item.ID === "string" && item.ID ? [item.ID] : []
  );
  if (ids.length === 0) {
    return [...opts.items];
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [engine, archs] = await Promise.race([
    Promise.all([
      readEngineArchitecture(probe),
      inspectContainerArchitectures({ ids, probe }),
    ]),
    // One budget for the annotation: a slow engine leaves items unchanged.
    new Promise<[null, ReadonlyMap<string, ContainerArchitecture>]>(
      (resolve) => {
        timer = setTimeout(
          () => resolve([null, new Map()]),
          opts.deadlineMs ?? PS_ANNOTATION_DEADLINE_MS
        );
      }
    ),
  ]).finally(() => clearTimeout(timer));
  if (!engine) {
    return [...opts.items];
  }
  return opts.items.map((item) => {
    const arch = typeof item.ID === "string" ? archs.get(item.ID) : undefined;
    return arch && arch !== engine ? { ...item, emulated: true } : item;
  });
}
