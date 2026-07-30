import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { getString, isRecord } from "./guards.ts";
import type { RuntimeProject } from "./runtime-projects.ts";
import { exec } from "./shell.ts";

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_VOLUME_LABEL = "com.docker.compose.volume";
const DISPOSABLE_CACHE_LABEL = "hack.cache.disposable";

export type MountedNamedVolumeCandidate = {
  readonly name: string;
  readonly destinations: readonly string[];
  readonly services: readonly string[];
};

export type DisposableCacheVolumeCandidate = MountedNamedVolumeCandidate & {
  readonly reason: "explicit-label" | "next-destination";
};

export type DisposableCacheVolumeRemoval = {
  readonly removed: readonly string[];
  readonly failed: readonly { readonly name: string; readonly error: string }[];
};

/**
 * Find named volumes mounted by containers owned by one exact Compose project
 * and checkout. Disposable status is verified independently from the volume.
 */
export function findMountedNamedVolumeCandidates(opts: {
  readonly composeProject: string;
  readonly currentProjectDir: string;
  readonly runtime: readonly RuntimeProject[];
}): readonly MountedNamedVolumeCandidate[] {
  const currentProjectDir = canonicalPath(opts.currentProjectDir);
  const byName = new Map<
    string,
    { readonly destinations: Set<string>; readonly services: Set<string> }
  >();

  for (const project of opts.runtime) {
    if (
      project.project !== opts.composeProject ||
      project.workingDir === null ||
      canonicalPath(project.workingDir) !== currentProjectDir
    ) {
      continue;
    }
    collectProjectCacheVolumes({
      byName,
      composeProject: opts.composeProject,
      project,
    });
  }

  return [...byName.entries()]
    .map(([name, evidence]) => ({
      name,
      destinations: [...evidence.destinations].sort((left, right) =>
        left.localeCompare(right)
      ),
      services: [...evidence.services].sort((left, right) =>
        left.localeCompare(right)
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function collectProjectCacheVolumes(opts: {
  readonly byName: Map<
    string,
    { readonly destinations: Set<string>; readonly services: Set<string> }
  >;
  readonly composeProject: string;
  readonly project: RuntimeProject;
}): void {
  for (const service of opts.project.services.values()) {
    for (const container of service.containers) {
      if (
        container.labels?.[COMPOSE_PROJECT_LABEL] !== opts.composeProject ||
        container.labels[COMPOSE_SERVICE_LABEL] !== service.service
      ) {
        continue;
      }

      for (const mount of container.mounts) {
        const volumeName = mount.name?.trim() || mount.source.trim();
        if (mount.type.toLowerCase() !== "volume" || volumeName.length === 0) {
          continue;
        }
        const current = opts.byName.get(volumeName) ?? {
          destinations: new Set<string>(),
          services: new Set<string>(),
        };
        current.destinations.add(mount.destination);
        current.services.add(service.service);
        opts.byName.set(volumeName, current);
      }
    }
  }
}

/**
 * Independently verify exact Docker Compose ownership, then require either a
 * built-in .next destination or an explicit disposable-cache volume label.
 */
export async function verifyDisposableCacheVolumes(opts: {
  readonly composeProject: string;
  readonly candidates: readonly MountedNamedVolumeCandidate[];
}): Promise<readonly DisposableCacheVolumeCandidate[]> {
  const verified: DisposableCacheVolumeCandidate[] = [];

  for (const candidate of opts.candidates) {
    const result = await exec(["docker", "volume", "inspect", candidate.name], {
      stdin: "ignore",
    });
    if (result.exitCode !== 0) {
      continue;
    }

    const labels = parseVolumeLabels(result.stdout);
    if (
      labels?.[COMPOSE_PROJECT_LABEL] !== opts.composeProject ||
      (labels[COMPOSE_VOLUME_LABEL] ?? "").trim().length === 0
    ) {
      continue;
    }
    const explicitlyDisposable =
      labels[DISPOSABLE_CACHE_LABEL]?.trim().toLowerCase() === "true";
    const nextDestinationOnly =
      candidate.destinations.length > 0 &&
      candidate.destinations.every(isNextCacheDestination);
    if (!(explicitlyDisposable || nextDestinationOnly)) {
      continue;
    }
    verified.push({
      ...candidate,
      reason: explicitlyDisposable ? "explicit-label" : "next-destination",
    });
  }

  return verified;
}

/** Remove only the exact verified volume names and report every failure. */
export async function removeDisposableCacheVolumes(opts: {
  readonly candidates: readonly DisposableCacheVolumeCandidate[];
}): Promise<DisposableCacheVolumeRemoval> {
  const removed: string[] = [];
  const failed: Array<{ readonly name: string; readonly error: string }> = [];

  for (const candidate of opts.candidates) {
    const result = await exec(["docker", "volume", "rm", candidate.name], {
      stdin: "ignore",
    });
    if (result.exitCode === 0) {
      removed.push(candidate.name);
      continue;
    }
    failed.push({
      name: candidate.name,
      error:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `docker volume rm exited ${result.exitCode}`,
    });
  }

  return { removed, failed };
}

function isNextCacheDestination(destination: string): boolean {
  const normalized = destination.replaceAll(/\/+$/g, "");
  return normalized === ".next" || normalized.endsWith("/.next");
}

function parseVolumeLabels(stdout: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!(Array.isArray(parsed) && isRecord(parsed[0]))) {
    return null;
  }
  const labels = parsed[0].Labels;
  if (!isRecord(labels)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const key of [
    COMPOSE_PROJECT_LABEL,
    COMPOSE_VOLUME_LABEL,
    DISPOSABLE_CACHE_LABEL,
  ]) {
    const value = getString(labels, key);
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
