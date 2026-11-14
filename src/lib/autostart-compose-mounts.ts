import { isRecord } from "./guards.ts";

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CONTAINER_PATH = /^\/[^$:]*$/;
const VOLUME_MODES = new Set(["ro", "rw", "nocopy", "volume-nocopy"]);

/**
 * Unattended starts trust prepared images and engine-managed storage, never host
 * file content supplied through Compose mounts. Named storage must use the
 * project's default local volume, without external aliases or driver options.
 */
export function hasOnlyEngineManagedMounts(
  compose: Record<string, unknown>
): boolean {
  if (
    !isRecord(compose.services) ||
    nonempty(compose.configs) ||
    nonempty(compose.secrets)
  ) {
    return false;
  }
  const names = declaredLocalVolumes(compose.volumes);
  if (names === null) {
    return false;
  }
  return Object.values(compose.services).every((service) =>
    supportedServiceMounts(service, names)
  );
}

function nonempty(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !(isRecord(value) && Object.keys(value).length === 0)
  );
}

function declaredLocalVolumes(value: unknown): ReadonlySet<string> | null {
  if (value === undefined || value === null) {
    return new Set();
  }
  if (!isRecord(value)) {
    return null;
  }
  const names = new Set<string>();
  for (const [name, definition] of Object.entries(value)) {
    if (!VOLUME_NAME.test(name)) {
      return null;
    }
    if (
      definition !== null &&
      (!isRecord(definition) ||
        Object.keys(definition).some(
          (key) => !["driver", "labels"].includes(key)
        ) ||
        (definition.driver !== undefined && definition.driver !== "local"))
    ) {
      return null;
    }
    names.add(name);
  }
  return names;
}

function supportedServiceMounts(
  service: unknown,
  names: ReadonlySet<string>
): boolean {
  if (!isRecord(service)) {
    return false;
  }
  if (
    [
      "configs",
      "secrets",
      "volumes_from",
      "label_file",
      "credential_spec",
    ].some((key) => service[key] !== undefined)
  ) {
    return false;
  }
  if (service.volumes === undefined) {
    return true;
  }
  return (
    Array.isArray(service.volumes) &&
    service.volumes.every((mount) => supportedMount(mount, names))
  );
}

function supportedMount(mount: unknown, names: ReadonlySet<string>): boolean {
  if (typeof mount === "string") {
    const parts = mount.split(":");
    if (parts.length === 1) {
      return CONTAINER_PATH.test(mount);
    }
    const [source, target, mode] = parts;
    return (
      parts.length <= 3 &&
      typeof source === "string" &&
      names.has(source) &&
      typeof target === "string" &&
      CONTAINER_PATH.test(target) &&
      (mode === undefined ||
        mode.split(",").every((entry) => VOLUME_MODES.has(entry)))
    );
  }
  if (
    !isRecord(mount) ||
    typeof mount.target !== "string" ||
    !CONTAINER_PATH.test(mount.target) ||
    mount.bind !== undefined ||
    mount.image !== undefined
  ) {
    return false;
  }
  if (mount.type === "tmpfs") {
    return mount.source === undefined;
  }
  return (
    mount.type === "volume" &&
    (mount.source === undefined ||
      (typeof mount.source === "string" && names.has(mount.source)))
  );
}
