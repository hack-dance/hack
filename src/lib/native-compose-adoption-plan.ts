import { posix } from "node:path";
import { isRecord } from "./guards.ts";
import {
  type ImportField,
  importPointer,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeImport,
} from "./native-config-import-plan.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const TARGET = /^\/[a-zA-Z0-9_./-]+$/;

export type LegacyComposeStorageIntent = {
  readonly composeProject: string;
  readonly services: readonly string[];
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
export type LegacyComposeAdoptionPlan = {
  readonly report: {
    readonly report_version: 1;
    readonly supported: boolean;
    readonly adoption: "not_performed";
    readonly fields: readonly ImportField[];
  };
  /** Private authored identity intent, not resource ownership or a converted config. */
  readonly intent?: LegacyComposeStorageIntent;
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
function storageFields(
  fields: readonly ImportField[],
  mapping: StorageMapping
): ImportField[] {
  if (!mapping.supported) {
    return [...fields];
  }
  return fields.map((field) => {
    if (field.document !== "compose") {
      return field;
    }
    const match = [...mapping.accepted].find(
      ([pointer]) =>
        field.pointer === pointer || field.pointer.startsWith(`${pointer}/`)
    );
    return match
      ? {
          ...field,
          status: "exact",
          code: "existing_storage_binding",
          target: match[1],
        }
      : field;
  });
}

/**
 * Closed authored prerequisite for existing local named volumes. Reuses the
 * import field report for all other fields, including inactive profiles. This
 * never produces a native candidate or claims complete conversion/adoption.
 * Unknown options and ambiguous identity/path mappings remain refused.
 */
export function planLegacyComposeAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeAdoptionPlan {
  const baseline = mapLegacyNativeImport(opts);
  const config = parseImportDocument({
    text: opts.configText,
    document: "config",
  }).value;
  const compose = parseImportDocument({
    text: opts.composeText,
    document: "compose",
  }).value;
  const mapping: StorageMapping = {
    supported: false,
    accepted: new Map(),
    volumes: [],
    mounts: [],
  };
  let intent: LegacyComposeStorageIntent | undefined;
  if (
    config &&
    compose &&
    typeof config.name === "string" &&
    NAME.test(config.name) &&
    compose.name === config.name &&
    isRecord(compose.services)
  ) {
    mapping.supported = true;
    mapVolumes(compose.volumes, config.name, mapping);
    mapMounts(compose.services, mapping);
    intent = {
      composeProject: config.name,
      services: Object.keys(compose.services).sort(),
      volumes: mapping.volumes.sort((a, b) =>
        a.storage.localeCompare(b.storage)
      ),
      mounts: mapping.mounts.sort(
        (a, b) =>
          a.service.localeCompare(b.service) || a.target.localeCompare(b.target)
      ),
    };
  }
  const fields = storageFields(baseline.report.fields, mapping);
  const supported =
    mapping.supported && !fields.some((field) => field.status === "refused");
  if (!(supported || fields.some((field) => field.status === "refused"))) {
    fields.push({
      document: "compose",
      pointer: "",
      line: 1,
      column: 1,
      status: "refused",
      code: "explicit_identity_and_owned_storage_required",
    });
  }
  const result: LegacyComposeAdoptionPlan = {
    report: { report_version: 1, supported, adoption: "not_performed", fields },
  };
  if (supported && intent) {
    freezeImportValue(intent);
    Object.defineProperty(result, "intent", { value: intent });
  }
  freezeImportValue(result.report);
  return Object.freeze(result);
}
