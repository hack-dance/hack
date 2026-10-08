import { isRecord } from "./guards.ts";
import { literalComposeArg } from "./native-config-import-argv.ts";
import { mapLegacyComposeBuild } from "./native-config-import-build.ts";
import {
  legacyComposeJobNames,
  legacyComposeOneShotMarker,
} from "./native-config-import-jobs.ts";
import {
  type ImportDocument,
  type ImportField,
  importPointer,
  parseImportDocument,
} from "./native-config-import-parser.ts";
import {
  legacyComposeCompletedJobTargets,
  legacyComposeMixedJobDependency,
  mapLegacyComposeDependencies,
  mapLegacyComposeHealthcheck,
} from "./native-config-import-readiness.ts";
import { mapLegacyComposeStorage } from "./native-config-import-storage.ts";
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

/**
 * Closed, pure conversion. Every raw field starts refused until explicitly mapped.
 * Completeness here describes mapping coverage; the preview owner separately requires
 * authoritative compiler validation before exposing a complete public preview.
 */
function mapLegacyNativeInput(opts: {
  readonly configText: string;
  readonly composeText: string;
  readonly purpose:
    | "preview"
    | "adoption-baseline"
    | "completed-job-adoption"
    | "storage-adoption";
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
  mapServices({
    source: compose.value.services,
    candidate,
    mark,
    refuse,
    buildPreview: opts.purpose === "preview",
    jobPreview: opts.purpose !== "adoption-baseline",
  });
  if (opts.purpose === "storage-adoption") {
    mapStorageCandidate({
      config: config.value,
      compose: compose.value,
      candidate,
      mark,
      refuse,
    });
  }
  return nativeImportResult({ fields, candidate });
}

function candidateWorkload(candidate: Record<string, unknown>, name: string) {
  for (const namespace of [candidate.services, candidate.jobs]) {
    if (isRecord(namespace) && Object.hasOwn(namespace, name)) {
      return namespace[name];
    }
  }
  return undefined;
}

/** Rebase only native workload pointers; original Compose source locations remain intact. */
function workloadTarget(
  candidate: Record<string, unknown>,
  target: string
): string {
  const prefix = "/services/";
  if (!target.startsWith(prefix)) {
    return target;
  }
  const name = target.slice(prefix.length).split("/")[0];
  return name && isRecord(candidate.jobs) && Object.hasOwn(candidate.jobs, name)
    ? target.replace(prefix, "/jobs/")
    : target;
}

/** Read-only preview keeps named storage refused until a separate verified adoption owner binds it. */
export function mapLegacyNativeImport(opts: {
  readonly configText: string;
  readonly composeText: string;
}): NativeImportPlan {
  return mapLegacyNativeInput({
    configText: opts.configText,
    composeText: opts.composeText,
    purpose: "preview",
  });
}

/** Retained resource planning must not inherit preview-only build or job authority. */
export function mapLegacyNativeAdoptionBaseline(opts: {
  readonly configText: string;
  readonly composeText: string;
}): NativeImportPlan {
  return mapLegacyNativeInput({ ...opts, purpose: "adoption-baseline" });
}

/** Pure v7 baseline used only after the retained owner has selected its closed static job family. */
export function mapLegacyNativeCompletedJobAdoptionBaseline(opts: {
  readonly configText: string;
  readonly composeText: string;
}): NativeImportPlan {
  return mapLegacyNativeInput({ ...opts, purpose: "completed-job-adoption" });
}

/** Private static candidate with the same closed mappings plus strictly qualified local named storage. No ownership grant. */
export function mapLegacyNativeStorageAdoption(opts: {
  readonly configText: string;
  readonly composeText: string;
}): NativeImportPlan {
  return mapLegacyNativeInput({
    configText: opts.configText,
    composeText: opts.composeText,
    purpose: "storage-adoption",
  });
}

function mapStorageCandidate(
  opts: MappingContext & { readonly compose: Record<string, unknown> }
) {
  const storage = mapLegacyComposeStorage({
    config: opts.config,
    compose: opts.compose,
  });
  if (!storage) {
    opts.refuse(
      "compose",
      "/volumes",
      "explicit_identity_and_owned_storage_required"
    );
    return;
  }
  opts.candidate.storage = Object.fromEntries(
    storage.intent.volumes.map((volume) => [
      volume.storage,
      { kind: "persistent", scope: "worktree" },
    ])
  );
  for (const [pointer, target] of storage.accepted) {
    const mapped =
      target
        .replace("/existing_storage", "/storage")
        .replace("/existing_mounts/", "/services/") +
      (target.startsWith("/existing_mounts/") ? "/mounts" : "");
    opts.mark(
      "compose",
      pointer,
      workloadTarget(opts.candidate, mapped),
      "exact",
      true
    );
  }
  for (const name of storage.intent.services) {
    const service = candidateWorkload(opts.candidate, name);
    if (!isRecord(service)) {
      continue;
    }
    const mounts = storage.mounts.filter((mount) => mount.service === name);
    if (mounts.length) {
      service.mounts = mounts.map((mount) => ({
        storage: mount.storage,
        target: mount.target,
        access: mount.readOnly ? "read-only" : "read-write",
      }));
    }
  }
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
function composeWordSpace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}
function composeWordQuote(character: string): character is "'" | '"' {
  return character === "'" || character === '"';
}
function composeWordControl(
  character: string,
  quote: string | undefined
): boolean {
  return quote === undefined && "&|;<>`()".includes(character);
}
function composeWordBoundary(
  character: string,
  quote: string | undefined
): boolean {
  return quote === undefined && composeWordSpace(character);
}
function composeWordEscape(
  character: string,
  quote: string | undefined
): boolean {
  return character === "\\" && quote !== "'";
}
function validComposeWordCharacter(
  character: string | undefined
): character is string {
  return character !== undefined && character !== "\0";
}
/** Finite Compose exec-word subset; unquoted shell operators refuse rather than truncate argv. */
function composeWord(
  value: string,
  start: number
): { readonly word: string; readonly next: number } | undefined {
  let word = "";
  let quote: "'" | '"' | undefined;
  let index = start;
  while (index < value.length) {
    const character = value[index];
    if (!validComposeWordCharacter(character)) {
      return undefined;
    }
    if (composeWordEscape(character, quote)) {
      const next = value[index + 1];
      if (!validComposeWordCharacter(next)) {
        return undefined;
      }
      word += next;
      index += 2;
      continue;
    }
    if (character === quote) {
      quote = undefined;
    } else if (quote === undefined && composeWordQuote(character)) {
      quote = character;
    } else if (composeWordBoundary(character, quote)) {
      return { word, next: index };
    } else if (composeWordControl(character, quote)) {
      return undefined;
    } else {
      word += character;
    }
    index++;
  }
  return quote ? undefined : { word, next: index };
}
function composeStringWords(value: string): string[] | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (composeWordSpace(value[index])) {
      index++;
      continue;
    }
    const parsed = composeWord(value, index);
    if (!parsed) {
      return undefined;
    }
    words.push(parsed.word);
    index = parsed.next;
  }
  return words;
}
function argv(value: unknown, empty: boolean): unknown {
  let parts = value;
  if (typeof value === "string") {
    if (literalComposeArg(value) === undefined) {
      return undefined;
    }
    parts = composeStringWords(value);
  }
  if (
    !Array.isArray(parts) ||
    (!empty && parts.length === 0) ||
    (parts.length > 0 && parts[0] === "")
  ) {
    return undefined;
  }
  const exec: string[] = [];
  for (const part of parts) {
    const decoded = literalComposeArg(part);
    if (decoded === undefined) {
      return undefined;
    }
    exec.push(decoded);
  }
  return { exec };
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

function serviceMappingCode(key: string, raw: unknown): string {
  if (key === "environment") {
    return "managed_fallback";
  }
  if ((key === "command" || key === "entrypoint") && typeof raw === "string") {
    return "compose_string_exec_argv";
  }
  if (
    (key === "command" || key === "entrypoint") &&
    Array.isArray(raw) &&
    raw.some((part) => typeof part === "string" && part.includes("$$"))
  ) {
    return "escaped_dollar_literal";
  }
  return "exact";
}

function markServiceValue(opts: {
  readonly mark: MappingContext["mark"];
  readonly key: string;
  readonly raw: unknown;
  readonly pointer: string;
  readonly target: string;
}): void {
  const code = serviceMappingCode(opts.key, opts.raw);
  opts.mark("compose", opts.pointer, opts.target, "exact", true);
  if (code === "exact") {
    return;
  }
  if (code === "managed_fallback") {
    opts.mark("compose", opts.pointer, opts.target, code, true);
    return;
  }
  opts.mark("compose", opts.pointer, opts.target, code);
  if (Array.isArray(opts.raw)) {
    for (const [index, part] of opts.raw.entries()) {
      if (typeof part === "string" && part.includes("$$")) {
        opts.mark(
          "compose",
          importPointer(opts.pointer, String(index)),
          `${opts.target}/exec/${index}`,
          code
        );
      }
    }
  }
}

function mapServiceReadiness(
  opts: Pick<MappingContext, "mark" | "refuse"> & {
    readonly service: Record<string, unknown>;
    readonly key: string;
    readonly raw: unknown;
    readonly servicePointer: string;
    readonly targetPointer: string;
    readonly jobs: ReadonlySet<string>;
    readonly job: boolean;
  }
): boolean {
  if (opts.key !== "depends_on" && opts.key !== "healthcheck") {
    return false;
  }
  const pointer = importPointer(opts.servicePointer, opts.key);
  if (opts.job && opts.key === "healthcheck") {
    opts.refuse("compose", pointer, "job_healthcheck_unsupported");
    return true;
  }
  const value =
    opts.key === "depends_on"
      ? mapLegacyComposeDependencies(opts.raw, opts.jobs)
      : mapLegacyComposeHealthcheck(opts.raw);
  if (value === undefined) {
    opts.refuse(
      "compose",
      pointer,
      opts.key === "depends_on" &&
        legacyComposeMixedJobDependency({ value: opts.raw, jobs: opts.jobs })
        ? "mixed_job_service_dependency"
        : "dependency_or_health_contract_unsupported"
    );
  } else {
    const property = opts.key === "depends_on" ? "depends_on" : "readiness";
    opts.service[property] = value;
    opts.mark(
      "compose",
      pointer,
      `${opts.targetPointer}/${property}`,
      "compose_readiness_contract",
      true
    );
  }
  return true;
}

function mapServiceReadinessFields(
  opts: Pick<MappingContext, "mark" | "refuse"> & {
    readonly source: Record<string, unknown>;
    readonly pointer: string;
    readonly service: Record<string, unknown>;
    readonly targetPointer: string;
    readonly jobs: ReadonlySet<string>;
    readonly job: boolean;
  }
) {
  for (const key of ["depends_on", "healthcheck"]) {
    if (Object.hasOwn(opts.source, key)) {
      mapServiceReadiness({
        ...opts,
        key,
        raw: opts.source[key],
        servicePointer: opts.pointer,
      });
    }
  }
}

function commandPresence(
  key: string,
  raw: unknown
): "image_default" | "empty_command_unrepresentable" | undefined {
  if (key !== "command" && key !== "entrypoint") {
    return undefined;
  }
  if (raw === null) {
    return "image_default";
  }
  if (
    key === "command" &&
    typeof raw === "string" &&
    composeStringWords(raw)?.length === 0
  ) {
    return "empty_command_unrepresentable";
  }
  return undefined;
}

type WorkloadMappingContext = Pick<MappingContext, "mark" | "refuse"> & {
  readonly source: Record<string, unknown>;
  readonly pointer: string;
  readonly profiles: Set<string>;
  readonly targetPointer: string;
  readonly jobs: ReadonlySet<string>;
  readonly job: boolean;
  readonly buildPreview: boolean;
};

function mapServiceRule(
  opts: WorkloadMappingContext & {
    readonly service: Record<string, unknown>;
    readonly key: string;
    readonly raw: unknown;
  }
) {
  const { key, raw, service } = opts;
  const pointer = importPointer(opts.pointer, key);
  if (opts.job && key === "restart" && raw !== "no") {
    opts.refuse("compose", pointer, "job_restart_policy_unsupported");
    return;
  }
  const presence = commandPresence(key, raw);
  if (presence === "image_default") {
    opts.mark("compose", pointer, "", "image_default");
    return;
  }
  if (presence === "empty_command_unrepresentable") {
    opts.refuse("compose", pointer, "empty_command_unrepresentable");
    return;
  }
  let value = SERVICE_RULES[key]?.(raw);
  if (
    key === "pull_policy" &&
    opts.buildPreview &&
    Object.hasOwn(opts.source, "build")
  ) {
    value = raw === "build" ? raw : undefined;
  }
  if (value === undefined) {
    opts.refuse("compose", pointer, "invalid_or_ambiguous_value");
    return;
  }
  const property = applyServiceValue(service, key, value);
  markServiceValue({
    mark: opts.mark,
    key,
    raw,
    pointer,
    target: `${opts.targetPointer}/${property}`,
  });
  if (key === "profiles" && Array.isArray(value)) {
    for (const name of value) {
      if (typeof name === "string") {
        opts.profiles.add(name);
      }
    }
  }
}

function mapService(opts: WorkloadMappingContext) {
  const service: Record<string, unknown> = {};
  const hasBuild = Object.hasOwn(opts.source, "build");
  opts.mark(
    "compose",
    opts.pointer,
    opts.targetPointer,
    opts.job ? "compose_completion_job" : "exact"
  );
  mapServiceReadinessFields({ ...opts, service });
  if (Object.hasOwn(opts.source, "labels")) {
    if (legacyComposeOneShotMarker(opts.source.labels)) {
      opts.mark(
        "compose",
        `${opts.pointer}/labels`,
        opts.targetPointer,
        "compose_one_shot_job",
        true
      );
    } else {
      opts.refuse(
        "compose",
        `${opts.pointer}/labels`,
        "one_shot_label_contract_unsupported"
      );
    }
  }
  for (const [key, raw] of Object.entries(opts.source)) {
    if (!Object.hasOwn(SERVICE_RULES, key)) {
      continue;
    }
    mapServiceRule({ ...opts, service, key, raw });
  }
  if (opts.buildPreview && hasBuild) {
    mapServiceBuild({ ...opts, service });
  }
  if (
    !(Object.hasOwn(opts.source, "image") || (opts.buildPreview && hasBuild))
  ) {
    opts.refuse(
      "compose",
      `${opts.pointer}/image`,
      "image_required_in_first_slice"
    );
  }
  return service;
}

function mapServiceBuild(
  opts: Pick<
    WorkloadMappingContext,
    "mark" | "refuse" | "source" | "pointer" | "targetPointer"
  > & {
    readonly service: Record<string, unknown>;
  }
): void {
  const pointer = importPointer(opts.pointer, "build");
  const targetPointer = importPointer(opts.targetPointer, "build");
  if (Object.hasOwn(opts.source, "image")) {
    opts.refuse("compose", pointer, "image_build_exclusive");
    opts.refuse(
      "compose",
      importPointer(opts.pointer, "image"),
      "image_build_exclusive"
    );
    return;
  }
  const mapped = mapLegacyComposeBuild(opts.source.build);
  if (!mapped) {
    opts.refuse("compose", pointer, "invalid_or_unsupported_build");
    return;
  }
  opts.service.build = mapped.build;
  for (const field of mapped.fields) {
    opts.mark(
      "compose",
      field.source === "" ? pointer : importPointer(pointer, field.source),
      field.target === ""
        ? targetPointer
        : importPointer(targetPointer, field.target),
      field.code
    );
  }
}

function refuseUndeclaredJobTargets(
  opts: Pick<MappingContext, "refuse"> & {
    readonly services: Record<string, unknown>;
    readonly source: Record<string, unknown>;
    readonly pointer: string;
  }
) {
  if (!Object.hasOwn(opts.source, "depends_on")) {
    return;
  }
  for (const target of legacyComposeCompletedJobTargets(
    opts.source.depends_on
  )) {
    if (!Object.hasOwn(opts.services, target)) {
      opts.refuse(
        "compose",
        importPointer(`${opts.pointer}/depends_on`, target),
        "undeclared_job_target"
      );
    }
  }
}

function refuseUnqualifiedJobAdoption(
  opts: Pick<MappingContext, "refuse"> & {
    readonly job: boolean;
    readonly jobPreview: boolean;
    readonly pointer: string;
  }
) {
  if (opts.job && !opts.jobPreview) {
    opts.refuse("compose", opts.pointer, "completed_job_adoption_unqualified");
  }
}

function mapServices(
  opts: Pick<MappingContext, "mark" | "refuse" | "candidate"> & {
    readonly source: unknown;
    readonly buildPreview: boolean;
    readonly jobPreview: boolean;
  }
) {
  if (!(isRecord(opts.source) && Object.keys(opts.source).length)) {
    opts.refuse("compose", "/services", "services_required");
    return;
  }
  opts.mark("compose", "/services", "/services");
  const services: Record<string, unknown> = Object.create(null);
  const jobs: Record<string, unknown> = Object.create(null);
  const jobNames = legacyComposeJobNames(opts.source);
  const profiles = new Set<string>();
  for (const [name, source] of Object.entries(opts.source)) {
    const pointer = importPointer("/services", name);
    if (isRecord(source)) {
      const job = jobNames.has(name);
      const targetPointer = importPointer(job ? "/jobs" : "/services", name);
      const workload = mapService({
        ...opts,
        source,
        pointer,
        targetPointer,
        profiles,
        job,
        jobs: jobNames,
      });
      (job ? jobs : services)[name] = workload;
      refuseUnqualifiedJobAdoption({
        job,
        jobPreview: opts.jobPreview,
        pointer,
        refuse: opts.refuse,
      });
      refuseUndeclaredJobTargets({
        ...opts,
        services: opts.source,
        source,
        pointer,
      });
      if (!NAME.test(name)) {
        opts.refuse("compose", pointer, "invalid_service_name_first_slice");
      }
    } else {
      opts.refuse("compose", pointer, "invalid_service");
    }
  }
  opts.candidate.services = services;
  if (Object.keys(jobs).length) {
    opts.candidate.jobs = jobs;
    opts.mark("compose", "/services", "", "compose_workload_namespaces");
  }
  if (profiles.size) {
    opts.candidate.profiles = [...profiles].sort();
  }
}
