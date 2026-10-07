import { isRecord } from "./guards.ts";
import {
  type ImportDocument,
  type ImportField,
  importPointer,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import { normalizeEnvConfigName } from "./project.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESTART = /^on-failure(?::([1-9]\d*))?$/;
const OVERLAY_INPUT = /^[A-Za-z0-9]+(?:[-_ ][A-Za-z0-9]+)*$/;
export type NativeImportReport = {
  readonly report_version: 1;
  readonly complete: boolean;
  readonly adoption: "not_performed";
  readonly fields: readonly ImportField[];
};
export type NativeImportPlan = {
  readonly report: NativeImportReport;
  /** Private authored static candidate, never a CLI report or a partially converted input. */
  readonly candidate?: Readonly<Record<string, unknown>>;
};

export function freezeImportValue(value: unknown): void {
  if (isRecord(value) || Array.isArray(value)) {
    for (const entry of Object.values(value)) {
      freezeImportValue(entry);
    }
    Object.freeze(value);
  }
}

/** JSON-safe wrapper; authored values require explicit private access. */
export function nativeImportResult(opts: {
  readonly fields: readonly ImportField[];
  readonly candidate?: Record<string, unknown>;
}): NativeImportPlan {
  const complete =
    opts.candidate !== undefined &&
    !opts.fields.some((item) => item.status === "refused");
  const result: NativeImportPlan = {
    report: {
      report_version: 1,
      complete,
      adoption: "not_performed",
      fields: [...opts.fields].sort(
        (a, b) =>
          a.document.localeCompare(b.document) ||
          a.pointer.localeCompare(b.pointer)
      ),
    },
  };
  if (complete) {
    freezeImportValue(opts.candidate);
    Object.defineProperty(result, "candidate", { value: opts.candidate });
  }
  freezeImportValue(result.report);
  return Object.freeze(result);
}

type MappingContext = {
  readonly config: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
  readonly mark: (
    document: ImportDocument,
    pointer: string,
    target: string,
    code?: string,
    descendants?: boolean
  ) => void;
  readonly refuse: (
    document: ImportDocument,
    pointer: string,
    code: string
  ) => void;
};

function mappingFields(
  fields: ImportField[]
): Pick<MappingContext, "mark" | "refuse"> {
  return {
    mark(document, pointer, target, code = "exact", descendants = false) {
      for (const [index, item] of fields.entries()) {
        if (
          item.document === document &&
          (item.pointer === pointer ||
            (descendants && item.pointer.startsWith(`${pointer}/`)))
        ) {
          fields[index] = {
            ...item,
            status: code === "exact" ? "exact" : "normalized",
            code,
            target,
          };
        }
      }
    },
    refuse(document, pointer, code) {
      let found = false;
      for (const [index, item] of fields.entries()) {
        if (item.document === document && item.pointer === pointer) {
          fields[index] = { ...item, status: "refused", code };
          found = true;
        }
      }
      if (!found) {
        fields.push({
          document,
          pointer,
          line: 1,
          column: 1,
          status: "refused",
          code,
        });
      }
    },
  };
}

/** Closed, pure conversion. Every raw field starts refused until explicitly mapped. */
export function mapLegacyNativeImport(opts: {
  readonly configText: string;
  readonly composeText: string;
}): NativeImportPlan {
  const config = parseImportDocument({
    text: opts.configText,
    document: "config",
  });
  const compose = parseImportDocument({
    text: opts.composeText,
    document: "compose",
  });
  const fields = [...config.fields, ...compose.fields];
  if (!(config.value && compose.value)) {
    return nativeImportResult({ fields });
  }
  const { mark, refuse } = mappingFields(fields);
  const candidate: Record<string, unknown> = { schema_version: 1 };
  const name = config.value.name;
  if (typeof name === "string" && NAME.test(name)) {
    candidate.name = name;
    mark("config", "/name", "/name");
  } else {
    refuse("config", "/name", "explicit_canonical_name_required");
  }
  if (
    Object.hasOwn(config.value, "$schema") &&
    typeof config.value.$schema === "string"
  ) {
    mark("config", "/$schema", "", "editor_metadata");
  }
  if (Object.hasOwn(compose.value, "name")) {
    if (compose.value.name === name && typeof name === "string") {
      mark("compose", "/name", "/name");
    } else {
      refuse("compose", "/name", "runtime_identity_conflict");
    }
  }
  const context = { config: config.value, candidate, mark, refuse };
  mapOverlay(context);
  mapWorktree(context);
  mapServices({ source: compose.value.services, candidate, mark, refuse });
  return nativeImportResult({ fields, candidate });
}

function overlayEntries(opts: MappingContext) {
  const entries: { pointer: string; raw: unknown }[] = [];
  for (const key of ["defaultEnvConfig", "default_env_config"]) {
    if (Object.hasOwn(opts.config, key)) {
      entries.push({ pointer: importPointer("", key), raw: opts.config[key] });
    }
  }
  if (Object.hasOwn(opts.config, "env")) {
    if (isRecord(opts.config.env)) {
      opts.mark("config", "/env", "/environment");
      for (const key of ["defaultOverlay", "default_overlay"]) {
        if (Object.hasOwn(opts.config.env, key)) {
          entries.push({
            pointer: importPointer("/env", key),
            raw: opts.config.env[key],
          });
        }
      }
    } else {
      opts.refuse("config", "/env", "invalid_environment_selection");
    }
  }
  return entries;
}

function mapOverlay(opts: MappingContext) {
  const entries = overlayEntries(opts);
  const names = entries.map((entry) =>
    typeof entry.raw === "string" && OVERLAY_INPUT.test(entry.raw.trim())
      ? normalizeEnvConfigName(entry.raw)
      : null
  );
  if (names.some((name) => name === null) || new Set(names).size > 1) {
    for (const entry of entries) {
      opts.refuse(
        "config",
        entry.pointer,
        "invalid_or_conflicting_overlay_alias"
      );
    }
    return;
  }
  const overlay = names[0];
  if (overlay) {
    opts.candidate.environment = { default_overlay: overlay };
    for (const entry of entries) {
      opts.mark(
        "config",
        entry.pointer,
        "/environment/default_overlay",
        entry.raw === overlay ? "exact" : "overlay_normalized"
      );
    }
  }
}

function mapWorktree(opts: MappingContext) {
  if (!Object.hasOwn(opts.config, "worktree")) {
    return;
  }
  if (!isRecord(opts.config.worktree)) {
    opts.refuse("config", "/worktree", "invalid_worktree_policy");
    return;
  }
  opts.mark("config", "/worktree", "/worktree");
  const source = opts.config.worktree;
  const worktree: Record<string, boolean> = {};
  for (const [canonical, alias] of [
    ["auto_branch", "autoBranch"],
    ["inherit_local", "inheritLocal"],
  ] as const) {
    const keys = [canonical, alias].filter((key) => Object.hasOwn(source, key));
    const values = keys.map((key) => source[key]);
    if (
      values.some((value) => typeof value !== "boolean") ||
      new Set(values).size > 1
    ) {
      for (const key of keys) {
        opts.refuse(
          "config",
          `/worktree/${key}`,
          "invalid_or_conflicting_worktree_alias"
        );
      }
    } else if (typeof values[0] === "boolean") {
      worktree[canonical] = values[0];
      for (const key of keys) {
        opts.mark("config", `/worktree/${key}`, `/worktree/${canonical}`);
      }
    }
  }
  opts.candidate.worktree = worktree;
}

function restartPolicy(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (["no", "always", "unless-stopped"].includes(value)) {
    return { kind: value };
  }
  const match = RESTART.exec(value);
  if (!match) {
    return undefined;
  }
  const retries = match[1] === undefined ? undefined : Number(match[1]);
  if (
    retries !== undefined &&
    (!Number.isInteger(retries) || retries > 4_294_967_295)
  ) {
    return undefined;
  }
  return {
    kind: "on-failure",
    ...(retries === undefined ? {} : { max_retries: retries }),
  };
}

function staticEnvironment(
  value: unknown
): Record<string, unknown> | undefined {
  const entries: [string, unknown][] = [];
  if (isRecord(value)) {
    entries.push(...Object.entries(value));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string" || !item.includes("=")) {
        return undefined;
      }
      const equal = item.indexOf("=");
      entries.push([item.slice(0, equal), item.slice(equal + 1)]);
    }
  } else {
    return undefined;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of entries) {
    if (
      !KEY.test(key) ||
      Object.hasOwn(result, key) ||
      typeof entry !== "string" ||
      entry.includes("$") ||
      entry.includes("\0")
    ) {
      return undefined;
    }
    result[key] = { default: entry };
  }
  return result;
}

function staticText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("$") &&
    !value.includes("\0")
  );
}
function argv(value: unknown, empty: boolean): unknown {
  return Array.isArray(value) &&
    (empty || value.length > 0) &&
    value.every(
      (part) =>
        typeof part === "string" && !part.includes("$") && !part.includes("\0")
    )
    ? { exec: [...value] }
    : undefined;
}
const SERVICE_RULES: Readonly<Record<string, (value: unknown) => unknown>> = {
  image: (value) => (staticText(value) ? value : undefined),
  working_dir: (value) => (staticText(value) ? value : undefined),
  command: (value) => argv(value, false),
  entrypoint: (value) => argv(value, true),
  init: (value) => (typeof value === "boolean" ? value : undefined),
  pull_policy: (value) =>
    typeof value === "string" && ["always", "never", "missing"].includes(value)
      ? value
      : undefined,
  restart: restartPolicy,
  stop_signal: (value) => (staticText(value) ? value : undefined),
  stop_grace_period: (value) => (staticText(value) ? value : undefined),
  environment: staticEnvironment,
  profiles: (value) =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((name) => typeof name === "string" && NAME.test(name))
      ? [...value]
      : undefined,
};

function applyServiceValue(
  service: Record<string, unknown>,
  key: string,
  value: unknown
): string {
  if (key === "stop_signal" || key === "stop_grace_period") {
    const field = key === "stop_signal" ? "signal" : "grace";
    const shutdown = isRecord(service.shutdown) ? service.shutdown : {};
    shutdown[field] = value;
    service.shutdown = shutdown;
    return `shutdown/${field}`;
  }
  const property = key === "working_dir" ? "working_directory" : key;
  service[property] = value;
  return property;
}

function mapService(
  opts: Pick<MappingContext, "mark" | "refuse"> & {
    readonly source: Record<string, unknown>;
    readonly pointer: string;
    readonly profiles: Set<string>;
  }
) {
  const service: Record<string, unknown> = {};
  opts.mark("compose", opts.pointer, opts.pointer);
  for (const [key, raw] of Object.entries(opts.source)) {
    if (!Object.hasOwn(SERVICE_RULES, key)) {
      continue;
    }
    const pointer = importPointer(opts.pointer, key);
    const value = SERVICE_RULES[key]?.(raw);
    if (value === undefined) {
      opts.refuse("compose", pointer, "invalid_or_ambiguous_value");
      continue;
    }
    const property = applyServiceValue(service, key, value);
    opts.mark(
      "compose",
      pointer,
      `${opts.pointer}/${property}`,
      key === "environment" ? "managed_fallback" : "exact",
      true
    );
    if (key === "profiles" && Array.isArray(value)) {
      for (const name of value) {
        if (typeof name === "string") {
          opts.profiles.add(name);
        }
      }
    }
  }
  if (!Object.hasOwn(opts.source, "image")) {
    opts.refuse(
      "compose",
      `${opts.pointer}/image`,
      "image_required_in_first_slice"
    );
  }
  return service;
}
function mapServices(
  opts: Pick<MappingContext, "mark" | "refuse" | "candidate"> & {
    readonly source: unknown;
  }
) {
  if (!(isRecord(opts.source) && Object.keys(opts.source).length)) {
    opts.refuse("compose", "/services", "services_required");
    return;
  }
  opts.mark("compose", "/services", "/services");
  const services: Record<string, unknown> = Object.create(null);
  const profiles = new Set<string>();
  for (const [name, source] of Object.entries(opts.source)) {
    const pointer = importPointer("/services", name);
    if (isRecord(source)) {
      services[name] = mapService({ ...opts, source, pointer, profiles });
    } else {
      opts.refuse("compose", pointer, "invalid_service");
    }
  }
  opts.candidate.services = services;
  if (profiles.size) {
    opts.candidate.profiles = [...profiles].sort();
  }
}
