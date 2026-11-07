import { isRecord } from "./guards.ts";
import { readNativeComposeDocument } from "./native-compose-backend-features.ts";

/**
 * Advisory (warning-only) findings about data services on the native backend.
 * They never block `up`: native review and runtime admission stay the
 * authority. Doctor reports them so a data service that is likely to fail, or
 * to strand its retained data, is visible before startup.
 *
 * - `native_data_owner_handoff_unqualified`: the service runs a published
 *   image's own entrypoint (no `build` and no `entrypoint:` override), keeps
 *   data in a named volume and declares no `user:`. Native containers drop
 *   every capability, so an image entrypoint that starts as root, changes the
 *   data directory owner and then switches user (as many database images do)
 *   fails. An explicit `user:` matching the image's data user avoids that
 *   handoff; it also acknowledges a service that really runs as root. Image
 *   metadata is not read here, so this is advice, not a verdict.
 * - `native_retained_data_mutable_image`: the service keeps data in a named
 *   volume and names its image by a mutable tag (`latest`, or no tag at all)
 *   without a digest. Restoring retained data requires the same image content
 *   ID, so a refreshed tag can strand that data until it is reverted or
 *   explicitly removed.
 *
 * The set is closed and ordered. Reports name only these codes and service
 * names; never an image reference, volume name, path or other authored value.
 */
export const NATIVE_DATA_ADVISORIES = [
  "native_data_owner_handoff_unqualified",
  "native_retained_data_mutable_image",
] as const;

/** One advisory code from {@link NATIVE_DATA_ADVISORIES}. */
export type NativeDataAdvisoryCode = (typeof NATIVE_DATA_ADVISORIES)[number];

/** One advisory with the sorted service names it applies to. */
export type NativeDataAdvisory = {
  readonly code: NativeDataAdvisoryCode;
  readonly services: readonly string[];
};

/** Doctor check id for the native data-service advisories. */
export const NATIVE_DATA_CHECK = "native data services";

/** Value-free JSON payload: closed codes and service names only. */
export type NativeDataReport = {
  readonly advisories: readonly NativeDataAdvisory[];
};

const DEPENDENCY_CACHE_LABEL = "hack.dependencies.cache-volume";

/** Compose reads a source starting with `.`, `/` or `~` as a host path. */
const HOST_PATH_SOURCE = /^[./~]/;

function labelValue(labels: unknown, key: string): string | undefined {
  if (isRecord(labels)) {
    const value = labels[key];
    return typeof value === "string" ? value : undefined;
  }
  if (Array.isArray(labels)) {
    for (const label of labels) {
      if (typeof label === "string" && label.startsWith(`${key}=`)) {
        return label.slice(key.length + 1);
      }
    }
  }
  return;
}

/**
 * Compose named-volume sources: a short-syntax source without a path prefix,
 * or a long-syntax `type: volume` source. Bind paths, anonymous volumes and
 * interpolated values are not named volumes here.
 */
function namedVolumeSources(service: Record<string, unknown>): string[] {
  const mounts = Array.isArray(service.volumes) ? service.volumes : [];
  const names: string[] = [];
  for (const mount of mounts) {
    let source: unknown;
    if (typeof mount === "string") {
      const separator = mount.indexOf(":");
      source = separator > 0 ? mount.slice(0, separator) : undefined;
    } else if (isRecord(mount) && mount.type === "volume") {
      source = mount.source;
    }
    if (
      typeof source === "string" &&
      source.length > 0 &&
      !HOST_PATH_SOURCE.test(source) &&
      !source.includes("/") &&
      !source.includes("$")
    ) {
      names.push(source);
    }
  }
  return names;
}

/**
 * Volumes that hold shared dependency content, not service data: every volume
 * a service selects with the `hack.dependencies.cache-volume` label. A volume
 * that declares `x-hack-disposable-cache` stays data: that extension names
 * regenerable directories inside the volume (possibly none), and everything
 * outside them is retained.
 */
function cacheVolumes(
  services: readonly Record<string, unknown>[]
): Set<string> {
  const caches = new Set<string>();
  for (const service of services) {
    const cache = labelValue(service.labels, DEPENDENCY_CACHE_LABEL);
    if (cache !== undefined) {
      caches.add(cache);
    }
  }
  return caches;
}

/**
 * A tag is mutable here when the reference has no digest and its tag is
 * `latest` or absent. Content IDs and interpolated references are not judged.
 */
function isMutableImage(image: unknown): boolean {
  if (typeof image !== "string" || image.length === 0) {
    return false;
  }
  if (
    image.includes("$") ||
    image.includes("@") ||
    image.startsWith("sha256:")
  ) {
    return false;
  }
  const name = image.slice(image.lastIndexOf("/") + 1);
  const separator = name.lastIndexOf(":");
  return separator < 0 || name.slice(separator + 1) === "latest";
}

function hasExplicitUser(service: Record<string, unknown>): boolean {
  const user = service.user;
  return (
    (typeof user === "string" && user.trim().length > 0) ||
    typeof user === "number"
  );
}

/**
 * Classifies a parsed Compose document. Every service is inspected, including
 * services outside the selected profiles, as native review does. A service
 * that is built locally (`build`) is judged for neither advisory. Returns
 * only advisories with at least one service, in
 * {@link NATIVE_DATA_ADVISORIES} order, with sorted unique service names.
 */
export function findNativeDataAdvisories(
  compose: unknown
): NativeDataAdvisory[] {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [];
  }
  const entries = Object.entries(compose.services).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
  );
  const declared = isRecord(compose.volumes) ? compose.volumes : {};
  const caches = cacheVolumes(entries.map(([, service]) => service));
  const found: Record<NativeDataAdvisoryCode, Set<string>> = {
    native_data_owner_handoff_unqualified: new Set(),
    native_retained_data_mutable_image: new Set(),
  };
  for (const [name, service] of entries) {
    const data = namedVolumeSources(service).some(
      (source) => Object.hasOwn(declared, source) && !caches.has(source)
    );
    if (!data) {
      continue;
    }
    const imageEntrypoint =
      !Object.hasOwn(service, "build") &&
      (service.entrypoint === undefined || service.entrypoint === null);
    if (imageEntrypoint && !hasExplicitUser(service)) {
      found.native_data_owner_handoff_unqualified.add(name);
    }
    if (!Object.hasOwn(service, "build") && isMutableImage(service.image)) {
      found.native_retained_data_mutable_image.add(name);
    }
  }
  return NATIVE_DATA_ADVISORIES.filter((code) => found[code].size > 0).map(
    (code) => ({ code, services: [...found[code]].sort() })
  );
}

/**
 * Reads and classifies one Compose file with the bounds native start uses.
 * Read-only: no lock, write or runtime request. A missing, oversized,
 * symlinked or unparseable file has no advisories; native start still reports
 * it.
 */
export async function readNativeDataAdvisories(
  composeFile: string
): Promise<NativeDataAdvisory[]> {
  return findNativeDataAdvisories(await readNativeComposeDocument(composeFile));
}

const ADVICE: Readonly<Record<NativeDataAdvisoryCode, string>> = {
  native_data_owner_handoff_unqualified:
    "named data volume with no explicit user:. Native containers drop all capabilities, so an image entrypoint that starts as root and hands the data directory to another user fails; set user: to the image's numeric data UID:GID, or 0:0 for a service that really runs as root",
  native_retained_data_mutable_image:
    "named data volume on an image tag that can change (latest or no tag). Retained data restores only with the same image, so pin a digest (image@sha256:...) or a fixed version tag",
};

/**
 * Doctor result for the native data-service advisories. Warning when any
 * advisory applies, otherwise ok. Read-only and value-free apart from service
 * names.
 */
export function nativeDataCheckResult(
  advisories: readonly NativeDataAdvisory[]
): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly nativeData: NativeDataReport;
} {
  const nativeData = {
    advisories: advisories.map((advisory) => ({
      code: advisory.code,
      services: [...advisory.services],
    })),
  };
  if (advisories.length === 0) {
    return {
      name: NATIVE_DATA_CHECK,
      status: "ok",
      message:
        "No data-service advisories; native up still reviews images and volumes when it starts.",
      nativeData,
    };
  }
  const lines = advisories.map(
    (advisory) =>
      `${advisory.code} (${advisory.services.join(", ")}): ${ADVICE[advisory.code]}`
  );
  return {
    name: NATIVE_DATA_CHECK,
    status: "warn",
    message: `${lines.join(". ")}.`,
    nativeData,
  };
}
