import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { resolveGlobalHackDir } from "./config-paths.ts";
import { writeTextFileAtomicIfChanged } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import {
  ensurePrivateDirectory,
  readBoundedPrivateFile,
} from "./private-file.ts";
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
  readonly fingerprint?: string;
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
        container.labels[COMPOSE_SERVICE_LABEL] !== service.service ||
        container.workingDir === null ||
        canonicalPath(container.workingDir) !==
          canonicalPath(opts.project.workingDir ?? "")
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
  readonly kept?: CacheVolumeKept[];
}): Promise<readonly DisposableCacheVolumeCandidate[]> {
  const verified: DisposableCacheVolumeCandidate[] = [];

  for (const candidate of opts.candidates) {
    const proof = await inspectVolume(candidate.name);
    if (proof === false) {
      continue;
    }
    const labels = proof?.labels;
    if (
      labels?.[COMPOSE_PROJECT_LABEL] !== opts.composeProject ||
      (getString(labels, COMPOSE_VOLUME_LABEL) ?? "").trim().length === 0 ||
      (candidate.fingerprint && candidate.fingerprint !== proof?.fingerprint)
    ) {
      opts.kept?.push({ name: candidate.name, reason: "ownership-unverified" });
      continue;
    }
    const explicitlyDisposable =
      getString(labels, DISPOSABLE_CACHE_LABEL)?.trim().toLowerCase() ===
      "true";
    const nextDestinationOnly =
      candidate.destinations.length > 0 &&
      candidate.destinations.every(isNextCacheDestination);
    if (!(explicitlyDisposable || nextDestinationOnly)) {
      opts.kept?.push({ name: candidate.name, reason: "not-disposable" });
      continue;
    }
    verified.push({
      ...candidate,
      fingerprint: proof?.fingerprint,
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
    if (
      candidate.fingerprint &&
      (await volumeFingerprint(candidate.name)) !== candidate.fingerprint
    ) {
      failed.push({
        name: candidate.name,
        error: "Volume identity changed after preview.",
      });
      continue;
    }
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

export type CacheVolumeKept = {
  readonly name: string;
  readonly reason:
    | "ownership-unverified"
    | "not-disposable"
    | "mounted-elsewhere";
};

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const RECEIPT_LIMIT = 128 * 1024;
const fingerprint = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function inspectVolume(name: string) {
  if (!VOLUME_NAME.test(name)) {
    return null;
  }
  const result = await exec(["docker", "volume", "inspect", name], {
    stdin: "ignore",
    timeoutMs: 2000,
  });
  if (result.exitCode !== 0) {
    return result.stderr.includes(`get ${name}: no such volume`) ? false : null;
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !(
        Array.isArray(parsed) &&
        parsed.length === 1 &&
        isRecord(parsed[0]) &&
        parsed[0].Name === name &&
        isRecord(parsed[0].Labels)
      )
    ) {
      return null;
    }
    return {
      labels: parsed[0].Labels,
      fingerprint: getString(parsed[0], "CreatedAt")
        ? fingerprint(
            JSON.stringify([
              parsed[0].Name,
              parsed[0].CreatedAt,
              parsed[0].Driver,
              parsed[0].Labels,
              parsed[0].Options,
              parsed[0].Mountpoint,
              parsed[0].Scope,
            ])
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

async function volumeFingerprint(name: string): Promise<string | undefined> {
  const proof = await inspectVolume(name);
  return proof ? proof.fingerprint : undefined;
}

async function cacheReceipt(opts: {
  composeProject: string;
  currentProjectDir: string;
}) {
  const id = await exec(["docker", "info", "--format", "{{.ID}}"], {
    stdin: "ignore",
    timeoutMs: 2000,
  });
  if (id.exitCode !== 0 || !id.stdout.trim()) {
    return null;
  }
  const directory = resolve(resolveGlobalHackDir(), "compose-cache-receipts");
  const key = fingerprint(
    JSON.stringify([id.stdout.trim(), opts.composeProject])
  );
  return {
    directory,
    path: resolve(directory, `${key}.json`),
    checkout: canonicalPath(opts.currentProjectDir),
  };
}

function isRecordedMount(value: unknown): value is MountedNamedVolumeCandidate {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    VOLUME_NAME.test(value.name) &&
    typeof value.fingerprint === "string" &&
    [value.services, value.destinations].every(
      (list) =>
        Array.isArray(list) && list.every((item) => typeof item === "string")
    )
  );
}

/** Persist fresh mounted-volume observations before Compose removes their containers. */
export async function retainDownCacheMounts(
  opts: Parameters<typeof findMountedNamedVolumeCandidates>[0]
): Promise<void> {
  const mounts = findMountedNamedVolumeCandidates(opts);
  if (!mounts.length) {
    return;
  }
  const receipt = await cacheReceipt(opts);
  if (!receipt) {
    return;
  }
  const recorded: MountedNamedVolumeCandidate[] = [];
  for (const mount of mounts) {
    const identity = await volumeFingerprint(mount.name);
    if (identity) {
      recorded.push({ ...mount, fingerprint: identity });
    }
  }
  const text = JSON.stringify({ checkout: receipt.checkout, mounts: recorded });
  if (Buffer.byteLength(text) <= RECEIPT_LIMIT) {
    await ensurePrivateDirectory(receipt.directory);
    await writeTextFileAtomicIfChanged(receipt.path, text, {
      createMode: 0o600,
      noFollowTarget: true,
      tightenExisting: true,
    });
  }
}

export async function readDownCacheMounts(
  opts: Parameters<typeof cacheReceipt>[0]
): Promise<readonly MountedNamedVolumeCandidate[]> {
  try {
    const receipt = await cacheReceipt(opts);
    if (!receipt) {
      return [];
    }
    const text = await readBoundedPrivateFile({
      path: receipt.path,
      directories: [receipt.directory],
      canonical: false,
      maxBytes: RECEIPT_LIMIT,
      refusal: () => new Error("Cache receipt could not be verified."),
    });
    const recorded: unknown = text ? JSON.parse(text) : null;
    return isRecord(recorded) &&
      recorded.checkout === receipt.checkout &&
      Array.isArray(recorded.mounts)
      ? recorded.mounts.filter(isRecordedMount)
      : [];
  } catch {
    return [];
  }
}

export function foreignCacheMounts(
  opts: Parameters<typeof findMountedNamedVolumeCandidates>[0]
): Set<string> {
  const checkout = canonicalPath(opts.currentProjectDir);
  return new Set(
    opts.runtime.flatMap((project) =>
      [...project.services.values()].flatMap((service) =>
        service.containers
          .filter(
            (container) =>
              container.project !== opts.composeProject ||
              !container.workingDir ||
              canonicalPath(container.workingDir) !== checkout
          )
          .flatMap((container) =>
            container.mounts
              .filter((mount) => mount.type === "volume")
              .map((mount) => mount.name?.trim() || mount.source.trim())
          )
      )
    )
  );
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
