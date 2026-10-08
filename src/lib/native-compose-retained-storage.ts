import { isRecord } from "./guards.ts";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const STORAGE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const CREATED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const LIMIT = 4096;

/** Private engine provenance. Docker volume names alone do not identify a retained database. */
export type NativeComposeRetainedVolume = {
  readonly name: string;
  readonly storage: string;
  readonly createdAt: string;
};

export type NativeComposeVolumePolicy = {
  readonly name: string;
  readonly storage: string;
  readonly mustExist?: boolean;
  readonly createdAt?: string;
};

/** Keep historical storage fences even when a new declaration drops its mount. */
export function selectNativeComposeVolumePolicies(opts: {
  readonly declared: readonly {
    readonly name: string;
    readonly storage: string;
  }[];
  readonly retained: readonly NativeComposeRetainedVolume[];
  readonly legacyNames: ReadonlySet<string>;
}): readonly NativeComposeVolumePolicy[] {
  if (!nativeComposeRetainedVolumesValid(opts.retained)) {
    throw new Error("Invalid native retained storage facts; values omitted.");
  }
  const volumes = new Map<string, NativeComposeVolumePolicy>(
    opts.retained.map((volume) => [volume.name, { ...volume, mustExist: true }])
  );
  for (const volume of opts.declared) {
    const existing = volumes.get(volume.name);
    if (existing && existing.storage !== volume.storage) {
      throw new Error("Native retained storage changed; values omitted.");
    }
    if (!existing) {
      volumes.set(volume.name, {
        name: volume.name,
        storage: volume.storage,
        ...(opts.legacyNames.has(volume.name) ? { mustExist: true } : {}),
      });
    }
  }
  return [...volumes.values()];
}

export function nativeComposeVolumeCreatedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CREATED.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Validate bounded, unique facts without retaining untrusted values in errors. */
export function nativeComposeRetainedVolumesValid(
  value: unknown
): value is readonly NativeComposeRetainedVolume[] {
  if (!Array.isArray(value) || value.length > LIMIT) {
    return false;
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (
      !(
        isRecord(entry) &&
        Object.keys(entry).sort().join() === "createdAt,name,storage" &&
        typeof entry.name === "string" &&
        entry.name.length <= 256 &&
        NAME.test(entry.name) &&
        typeof entry.storage === "string" &&
        STORAGE.test(entry.storage) &&
        nativeComposeVolumeCreatedAt(entry.createdAt) &&
        !names.has(entry.name)
      )
    ) {
      return false;
    }
    names.add(entry.name);
  }
  return true;
}

/**
 * First observations may add facts; existing facts are never forgotten or rebound.
 * Missing or replaced volumes refuse before effects, including after a verified stop.
 * A birth timestamp is an engine-provided fence, not cryptographic proof against a
 * hostile daemon or an administrator able to recreate all volume metadata.
 */
export function mergeNativeComposeRetainedVolumes(opts: {
  readonly retained: readonly NativeComposeRetainedVolume[];
  readonly observed: readonly NativeComposeRetainedVolume[];
}): readonly NativeComposeRetainedVolume[] {
  if (
    !(
      nativeComposeRetainedVolumesValid(opts.retained) &&
      nativeComposeRetainedVolumesValid(opts.observed)
    )
  ) {
    throw new Error("Invalid native retained storage facts; values omitted.");
  }
  const observed = new Map(
    opts.observed.map((volume) => [volume.name, volume])
  );
  for (const previous of opts.retained) {
    const current = observed.get(previous.name);
    if (
      !current ||
      current.storage !== previous.storage ||
      current.createdAt !== previous.createdAt
    ) {
      throw new Error("Native retained storage changed; values omitted.");
    }
  }
  return Object.freeze(
    [...observed.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((volume) => Object.freeze({ ...volume }))
  );
}
