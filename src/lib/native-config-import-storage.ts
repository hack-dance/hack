import { posix } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type LegacyOwnedNetworkIntent,
  type LegacyOwnedNetworksIntent,
  mapLegacyOwnedNetwork,
} from "./native-config-import-network.ts";
import { importPointer } from "./native-config-import-parser.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SELECTED_PROJECT = /^[a-z0-9]+(?:-+[a-z0-9]+)*$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const TARGET = /^\/[a-zA-Z0-9_./-]+$/;

export type LegacyComposeStorageIntent = {
  readonly composeProject: string;
  readonly services: readonly string[];
  readonly ownedNetwork?: LegacyOwnedNetworkIntent;
  readonly ownedNetworks?: LegacyOwnedNetworksIntent;
  readonly volumes: readonly {
    readonly storage: string;
    readonly name: string;
  }[];
  readonly mounts: readonly {
    readonly service: string;
    readonly storage: string;
    readonly target: string;
    readonly readOnly: boolean;
  }[];
};
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function mount(raw: unknown) {
  let source: unknown;
  let target: unknown;
  let readOnly: unknown = false;
  if (typeof raw === "string") {
    const parts = raw.split(":");
    if (parts.length !== 2 && parts.length !== 3) {
      return undefined;
    }
    [source, target] = parts;
    if (parts.length === 3) {
      if (parts[2] !== "ro" && parts[2] !== "rw") {
        return undefined;
      }
      readOnly = parts[2] === "ro";
    }
  } else if (
    isRecord(raw) &&
    keys(raw, ["type", "source", "target", "read_only"]) &&
    raw.type === "volume"
  ) {
    source = raw.source;
    target = raw.target;
    readOnly = Object.hasOwn(raw, "read_only") ? raw.read_only : false;
  } else {
    return undefined;
  }
  if (
    typeof source !== "string" ||
    !NAME.test(source) ||
    typeof target !== "string" ||
    !TARGET.test(target) ||
    posix.normalize(target) !== target ||
    target.endsWith("/") ||
    typeof readOnly !== "boolean"
  ) {
    return undefined;
  }
  return { storage: source, target, readOnly };
}

type StorageMapping = {
  readonly accepted: Map<string, string>;
  readonly volumes: { storage: string; name: string }[];
  readonly mounts: {
    service: string;
    storage: string;
    target: string;
    readOnly: boolean;
  }[];
  supported: boolean;
};
function mapVolumes(source: unknown, project: string, mapping: StorageMapping) {
  if (!(isRecord(source) && Object.keys(source).length)) {
    mapping.supported = false;
    return;
  }
  for (const [storage, declaration] of Object.entries(source)) {
    const valid =
      NAME.test(storage) &&
      (declaration === null ||
        (isRecord(declaration) && keys(declaration, ["name"])));
    const name =
      isRecord(declaration) && Object.hasOwn(declaration, "name")
        ? declaration.name
        : `${project}_${storage}`;
    if (
      !valid ||
      typeof name !== "string" ||
      !VOLUME_NAME.test(name) ||
      mapping.volumes.some((volume) => volume.name === name)
    ) {
      mapping.supported = false;
      continue;
    }
    mapping.volumes.push({ storage, name });
    mapping.accepted.set(
      importPointer("/volumes", storage),
      `/existing_storage/${storage}`
    );
  }
  mapping.accepted.set("/volumes", "/existing_storage");
}
function serviceMounts(
  service: string,
  source: unknown,
  mapping: StorageMapping
) {
  if (!(Array.isArray(source) && source.length)) {
    mapping.supported = false;
    return;
  }
  const targets = new Set<string>();
  for (const raw of source) {
    const mapped = mount(raw);
    if (
      !(
        mapped &&
        mapping.volumes.some((volume) => volume.storage === mapped.storage)
      ) ||
      targets.has(mapped.target)
    ) {
      mapping.supported = false;
      continue;
    }
    targets.add(mapped.target);
    mapping.mounts.push({ service, ...mapped });
  }
  mapping.accepted.set(
    importPointer(importPointer("/services", service), "volumes"),
    `/existing_mounts/${service}`
  );
}
function mapMounts(source: Record<string, unknown>, mapping: StorageMapping) {
  for (const [service, declaration] of Object.entries(source)) {
    if (!(isRecord(declaration) && NAME.test(service))) {
      mapping.supported = false;
      continue;
    }
    if (Object.hasOwn(declaration, "volumes")) {
      serviceMounts(service, declaration.volumes, mapping);
    }
  }
  if (
    mapping.volumes.some(
      (volume) =>
        !mapping.mounts.some((entry) => entry.storage === volume.storage)
    )
  ) {
    mapping.supported = false;
  }
}

/** Closed local named-storage mapping. This pure intent does not grant resource ownership. */
export function mapLegacyComposeStorage(opts: {
  readonly config: Record<string, unknown> | undefined;
  readonly compose: Record<string, unknown> | undefined;
  /** Adoption-only physical identity; authored names remain the base project. */
  readonly selectedComposeProject?: string;
}):
  | {
      readonly intent: LegacyComposeStorageIntent;
      readonly accepted: ReadonlyMap<string, string>;
      readonly mounts: LegacyComposeStorageIntent["mounts"];
    }
  | undefined {
  const { config, compose } = opts;
  if (
    !(
      config &&
      compose &&
      typeof config.name === "string" &&
      NAME.test(config.name) &&
      compose.name === config.name &&
      isRecord(compose.services)
    )
  ) {
    return undefined;
  }
  const mapping: StorageMapping = {
    supported: true,
    accepted: new Map(),
    volumes: [],
    mounts: [],
  };
  const composeProject = opts.selectedComposeProject ?? config.name;
  if (
    !(opts.selectedComposeProject ? SELECTED_PROJECT : NAME).test(
      composeProject
    )
  ) {
    return undefined;
  }
  mapVolumes(compose.volumes, composeProject, mapping);
  mapMounts(compose.services, mapping);
  if (!mapping.supported) {
    return undefined;
  }
  const network = mapLegacyOwnedNetwork({
    project: composeProject,
    compose,
  });
  if (network.kind === "refused") {
    return undefined;
  }
  return {
    accepted: mapping.accepted,
    mounts: [...mapping.mounts],
    intent: {
      composeProject,
      services: Object.keys(compose.services).sort(),
      ...(network.kind === "owned" ? { ownedNetwork: network.intent } : {}),
      ...(network.kind === "multiple" ? { ownedNetworks: network.intent } : {}),
      volumes: mapping.volumes.sort((a, b) =>
        a.storage.localeCompare(b.storage)
      ),
      mounts: mapping.mounts.sort(
        (a, b) =>
          a.service.localeCompare(b.service) || a.target.localeCompare(b.target)
      ),
    },
  };
}
