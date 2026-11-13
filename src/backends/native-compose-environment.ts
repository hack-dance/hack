import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HACK_KEY_MATERIAL_VARIABLES } from "../lib/child-environment.ts";
import { isRecord } from "../lib/guards.ts";
import { nativeAwsCredentialMount } from "./native-aws-environment.ts";
import {
  composeEnvironmentReferences,
  interpolateComposeEnvironment,
  parseComposeEnvironmentFile,
} from "./native-compose-env-syntax.ts";
import {
  NativeEnvFileRefusal,
  nativeEnvFileSourceLocation,
  readNativeEnvFileSource,
} from "./native-env-file-source.ts";
import { nativeGcloudCredentialMount } from "./native-gcloud-environment.ts";
import { nativeServiceActive } from "./native-project-builds.ts";
import { shellVariableReadable } from "./native-shell-environment.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROLS = new Set([
  "COMPOSE_FILE",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_ENV_FILES",
  "COMPOSE_DISABLE_ENV_FILE",
]);
const UNSETS = "x-hack-unset-environment";
type Values = Readonly<Record<string, string>>;
export type NativeComposeEnvironmentService = {
  readonly document: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
};
type FileSpec = {
  readonly path: string;
  readonly required: boolean;
  readonly raw: boolean;
};
type Source = { readonly path: string; readonly text: string } | null;
type Options = {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly compose: Record<string, unknown>;
  readonly services: Readonly<Record<string, NativeComposeEnvironmentService>>;
  readonly managed: Readonly<Record<string, Values>>;
  readonly global: Values;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly profiles?: readonly string[];
  readonly selectedServices?: readonly string[];
};
type Sources = {
  readonly lookup: (name: string) => string | undefined;
  readonly read: (spec: FileSpec, service?: string) => Promise<Source>;
  readonly dotenv: ReadonlyMap<string, string>;
  readonly shellNames: Set<string>;
};
type Notice = { readonly service: string; readonly line: string };

function refused(
  source: string,
  reason: string,
  service?: string
): NativeEnvFileRefusal {
  return new NativeEnvFileRefusal({ source, reason, service });
}
function protectedName(name: string): boolean {
  return name.startsWith("HACK_") || HACK_KEY_MATERIAL_VARIABLES.has(name);
}
function ownValue(values: Values, name: string): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw refused(".env", "the interpolation source cannot be inspected");
  }
}

/** Identity comparison also catches case aliases on case-insensitive filesystems. */
async function sameSource(a: string, b: string): Promise<boolean> {
  if (a === b) {
    return true;
  }
  try {
    const [left, right] = await Promise.all([lstat(a), lstat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw refused(".env", "the interpolation source cannot be inspected");
  }
}
function fileSpecs(value: unknown, service: string): FileSpec[] {
  if (value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if (typeof entry === "string") {
      return { path: entry, required: true, raw: false };
    }
    if (
      !(isRecord(entry) && typeof entry.path === "string") ||
      Object.keys(entry).some(
        (key) => !["path", "required", "format"].includes(key)
      ) ||
      (entry.required !== undefined && typeof entry.required !== "boolean") ||
      (entry.format !== undefined &&
        entry.format !== "" &&
        entry.format !== "raw")
    ) {
      throw refused(
        "env_file",
        "use a path or path/required/format entry with omitted, empty or raw format",
        service
      );
    }
    return {
      path: entry.path,
      required: entry.required !== false,
      raw: entry.format === "raw",
    };
  });
}

/** Reject private interpolation; optionally freeze defaults before file names gain ownership. */
function checkPublicFields(opts: {
  readonly value: unknown;
  readonly lookup: Sources["lookup"];
  readonly service?: string;
  readonly field?: string;
  readonly fileBindings?: ReadonlySet<string>;
  readonly managedNames?: ReadonlySet<string>;
}): unknown {
  if (typeof opts.value === "string") {
    try {
      const expanded = interpolateComposeEnvironment({
        text: opts.value,
        lookup: (name) => {
          if (opts.lookup(name) !== undefined) {
            throw new NativeEnvFileRefusal({
              source: "Compose public field",
              service: opts.service,
              field: opts.field,
              reason: `variable ${name} may only interpolate inside service environment or env-file values`,
            });
          }
          return undefined;
        },
      });
      const references = composeEnvironmentReferences(opts.value);
      if ([...references].some((name) => opts.fileBindings?.has(name))) {
        const runtimeName = [...references].find(
          (name) => !shellVariableReadable(name) || opts.managedNames?.has(name)
        );
        if (runtimeName !== undefined) {
          throw new NativeEnvFileRefusal({
            source: "Compose public field",
            service: opts.service,
            field: opts.field,
            reason: `variable ${runtimeName} cannot combine runtime-bound interpolation with a file-backed default`,
          });
        }
        return expanded.replaceAll("$", () => "$$");
      }
    } catch (error: unknown) {
      if (error instanceof NativeEnvFileRefusal) {
        throw error;
      }
      throw new NativeEnvFileRefusal({
        source: "Compose public field",
        service: opts.service,
        field: opts.field,
        reason: "invalid or over-budget interpolation",
      });
    }
  } else if (Array.isArray(opts.value)) {
    return opts.value.map((value) => {
      if (
        opts.field === "volumes" &&
        (nativeAwsCredentialMount(value) || nativeGcloudCredentialMount(value))
      ) {
        return value;
      }
      return checkPublicFields({ ...opts, value });
    });
  } else if (isRecord(opts.value)) {
    return Object.fromEntries(
      Object.entries(opts.value).map(([key, value]) => [
        key,
        checkPublicFields({ ...opts, value }),
      ])
    );
  }
  return opts.value;
}

function ignoredExtension(field: string): boolean {
  return field.startsWith("x-") && !field.startsWith("x-hack-");
}

/** The project selector may be a root alias; no links inside that root gain authority. */
async function canonicalSourceOptions(opts: Options): Promise<Options> {
  const member = relative(resolve(opts.projectRoot), resolve(opts.composeFile));
  if (member === ".." || member.startsWith(`..${sep}`) || isAbsolute(member)) {
    throw refused(
      "env_file",
      "the Compose file must stay inside the project root"
    );
  }
  const root = await realpath(opts.projectRoot);
  return { ...opts, projectRoot: root, composeFile: resolve(root, member) };
}

async function readAutomaticDotenv(opts: {
  readonly automatic: string;
  readonly read: Sources["read"];
  readonly lookup: Sources["lookup"];
}): Promise<ReadonlyMap<string, string>> {
  // An absent automatic input grants no file access and adds no new directory
  // admission to projects that use no env files. Explicit optional paths still
  // go through the complete source guard, including their existing parents.
  if (!(await present(opts.automatic))) {
    return new Map();
  }
  const source = await opts.read({ path: ".env", required: true, raw: false });
  if (source === null) {
    return new Map();
  }
  let dotenv: ReadonlyMap<string, string>;
  try {
    dotenv = parseComposeEnvironmentFile({
      text: source.text,
      lookup: opts.lookup,
      onUnresolved: (name) => {
        if (!shellVariableReadable(name)) {
          throw refused(
            ".env",
            `variable ${name} cannot be read from the caller's shell; use an explicit file value`
          );
        }
      },
    });
  } catch (error: unknown) {
    if (error instanceof NativeEnvFileRefusal) {
      throw error;
    }
    throw refused(
      ".env",
      "invalid dotenv syntax, unresolved required reference or source budget"
    );
  }
  for (const key of dotenv.keys()) {
    if (CONTROLS.has(key) || protectedName(key)) {
      throw refused(
        ".env",
        `control variable ${key} is not supported as a dotenv input`
      );
    }
  }
  return dotenv;
}

async function environmentSources(opts: Options): Promise<Sources> {
  const shellNames = new Set<string>();
  const cached = new Map<string, Source>();
  const automatic = join(dirname(opts.composeFile), ".env");
  const env = opts.env ?? {};
  let bytes = 0;
  let references = 0;
  const shell = (name: string): string | undefined => {
    if (!(shellVariableReadable(name) && Object.hasOwn(env, name))) {
      return undefined;
    }
    const value = env[name];
    if (typeof value === "string") {
      shellNames.add(name);
      return value;
    }
    return undefined;
  };
  const read: Sources["read"] = async (spec, service) => {
    references += 1;
    if (references > 64) {
      throw refused(
        spec.path,
        "more than 64 environment source references",
        service
      );
    }
    const { path } = nativeEnvFileSourceLocation({
      ...opts,
      path: spec.path,
      service,
    });
    if (
      (await present(`${automatic}.state.json`)) &&
      (await sameSource(path, automatic))
    ) {
      throw refused(
        spec.path,
        "possible Hack materialized output: use current Hack env layers and deliberately remove obsolete .env and .env.state.json before retrying",
        service
      );
    }
    // Cache one verified snapshot per literal path so repeated references and
    // different services cannot consume different versions during preparation.
    if (cached.has(path)) {
      const prior = cached.get(path) ?? null;
      if (prior === null && spec.required) {
        throw refused(spec.path, "the required source is missing", service);
      }
      return prior;
    }
    const source = await readNativeEnvFileSource({
      ...opts,
      path: spec.path,
      required: spec.required,
      service,
    });
    if (source !== null) {
      bytes += Buffer.byteLength(source.text);
    }
    if (bytes > 1024 * 1024) {
      throw refused(
        spec.path,
        "environment source text exceeds 1 MiB",
        service
      );
    }
    cached.set(path, source);
    return source;
  };
  const baseLookup = (name: string): string | undefined => {
    if (protectedName(name)) {
      throw refused(
        "environment",
        `protected variable ${name} cannot be interpolated`
      );
    }
    return ownValue(opts.global, name) ?? shell(name);
  };
  const dotenv = await readAutomaticDotenv({
    automatic,
    read,
    lookup: baseLookup,
  });
  return {
    shellNames,
    dotenv,
    read,
    lookup: (name) => baseLookup(name) ?? dotenv.get(name),
  };
}

type Resolution = {
  readonly environment: Record<string, unknown>;
  readonly resolved: Map<string, string>;
  readonly delivered: Record<string, string>;
  readonly unset: string[];
  readonly unbound: Set<string>;
  readonly references: Map<string, ReadonlySet<string>>;
  readonly changed: boolean;
};
type ServiceContext = {
  readonly name: string;
  readonly managed: Values;
  readonly global: Values;
  readonly lookup: Sources["lookup"];
  readonly notices: Notice[];
};
function missingNotice(opts: {
  readonly context: ServiceContext;
  readonly name: string;
  readonly key: string;
  readonly unset: boolean;
}): void {
  opts.context.notices.push({
    service: opts.context.name,
    line: `Service ${opts.context.name}: ${opts.key} is ${opts.unset ? "unset" : "empty"} because ${opts.name} is not set in the interpolation context.`,
  });
}
function expandServiceValue(opts: {
  readonly text: string;
  readonly key: string;
  readonly context: ServiceContext;
}): {
  readonly value: string;
  readonly private: boolean;
  readonly unbound: boolean;
} {
  const { context } = opts;
  let privateSource = false;
  let unbound = false;
  try {
    const value = interpolateComposeEnvironment({
      text: opts.text,
      onMissing: (name) => {
        if (!shellVariableReadable(name)) {
          unbound = true;
          return;
        }
        privateSource = true;
        missingNotice({ context, name, key: opts.key, unset: false });
      },
      lookup: (name) => {
        if (name === "COMPOSE_PROJECT_NAME") {
          unbound = true;
          return undefined;
        }
        if (
          Object.hasOwn(context.managed, name) &&
          !Object.hasOwn(context.global, name)
        ) {
          throw refused(
            "environment",
            `service-scoped variable ${name} is not an interpolation source`,
            context.name
          );
        }
        const found = context.lookup(name);
        privateSource ||= found !== undefined;
        return found;
      },
    });
    if (privateSource && unbound) {
      throw refused(
        "environment",
        "private interpolation cannot combine with unreadable or runtime-bound sources",
        context.name
      );
    }
    if (privateSource && !shellVariableReadable(opts.key)) {
      throw refused(
        "environment",
        "use an explicit literal env-file entry or the credential adapter for a reserved destination",
        context.name
      );
    }
    return { value, private: privateSource, unbound };
  } catch (error: unknown) {
    if (error instanceof NativeEnvFileRefusal) {
      throw error;
    }
    throw refused(
      "environment",
      "invalid interpolation, required reference or NUL value",
      context.name
    );
  }
}
function serviceScalar(opts: {
  readonly value: unknown;
  readonly service: string;
}): number | boolean {
  if (typeof opts.value === "number" || typeof opts.value === "boolean") {
    return opts.value;
  }
  throw refused(
    "environment",
    "environment values must be scalar",
    opts.service
  );
}

function resolveBareService(opts: {
  readonly context: ServiceContext;
  readonly key: string;
  readonly environment: Record<string, unknown>;
  readonly delivered: Record<string, string>;
  readonly resolved: Map<string, string>;
  readonly unset: string[];
}): void {
  const { key, context } = opts;
  const found = context.lookup(key);
  if (found !== undefined) {
    opts.environment[key] = null;
    opts.delivered[key] = found;
    opts.resolved.set(key, found);
    return;
  }
  if (!shellVariableReadable(key)) {
    opts.environment[key] = null;
    return;
  }
  opts.unset.push(key);
  missingNotice({ context, name: key, key, unset: true });
}
function resolveService(opts: {
  readonly context: ServiceContext;
  readonly environment: Record<string, unknown>;
}): Resolution {
  const environment: Record<string, unknown> = Object.create(null);
  const delivered: Record<string, string> = Object.create(null);
  const resolved = new Map<string, string>();
  const unset: string[] = [];
  const unbound = new Set<string>();
  const references = new Map<string, ReadonlySet<string>>();
  const { context } = opts;
  let changed = false;
  for (const [key, value] of Object.entries(opts.environment)) {
    if (!NAME.test(key)) {
      throw refused(
        "environment",
        "variable names must be valid identifiers",
        context.name
      );
    }
    const managed = ownValue(context.managed, key);
    if (managed !== undefined) {
      environment[key] = null;
      resolved.set(key, managed);
      continue;
    }
    if (HACK_KEY_MATERIAL_VARIABLES.has(key)) {
      throw refused(
        "environment",
        "Hack key material cannot be copied into services",
        context.name
      );
    }
    if (value === null) {
      changed = true;
      resolveBareService({
        key,
        context,
        environment,
        delivered,
        resolved,
        unset,
      });
      continue;
    }
    if (typeof value !== "string") {
      const literal = serviceScalar({ value, service: context.name });
      environment[key] = literal;
      resolved.set(key, String(literal));
      continue;
    }
    const expanded = expandServiceValue({ text: value, key, context });
    environment[key] = expanded.private ? null : value;
    if (expanded.unbound) {
      unbound.add(key);
    } else {
      resolved.set(key, expanded.value);
      if (!expanded.private) {
        references.set(key, composeEnvironmentReferences(value));
      }
    }
    if (expanded.private) {
      delivered[key] = expanded.value;
      changed = true;
    }
  }
  return {
    environment,
    resolved,
    delivered,
    unset,
    unbound,
    references,
    changed,
  };
}

async function serviceFiles(opts: {
  readonly context: ServiceContext;
  readonly sources: Sources;
  readonly specs: readonly FileSpec[];
  readonly resolution: Resolution;
}): Promise<ReadonlyMap<string, string>> {
  let files: ReadonlyMap<string, string> = new Map();
  for (const spec of opts.specs) {
    const source = await opts.sources.read(spec, opts.context.name);
    if (source === null) {
      continue;
    }
    try {
      files = parseComposeEnvironmentFile({
        text: source.text,
        raw: spec.raw,
        initial: files,
        onMissing: (key) =>
          missingNotice({
            context: opts.context,
            name: key,
            key,
            unset: false,
          }),
        lookup: (key) => {
          const project = opts.context.lookup(key);
          if (project !== undefined) {
            return project;
          }
          if (
            key === "COMPOSE_PROJECT_NAME" ||
            opts.resolution.unbound.has(key)
          ) {
            throw refused(
              spec.path,
              `runtime-dependent variable ${key} cannot interpolate private file values`,
              opts.context.name
            );
          }
          return opts.resolution.resolved.get(key);
        },
        onUnresolved: (key) => {
          if (!shellVariableReadable(key)) {
            throw refused(
              spec.path,
              `variable ${key} cannot be read from the caller's shell; use an explicit file value or credential adapter`,
              opts.context.name
            );
          }
        },
      });
    } catch (error: unknown) {
      if (error instanceof NativeEnvFileRefusal) {
        throw error;
      }
      throw refused(
        spec.path,
        "invalid dotenv syntax, unresolved required reference or source budget",
        opts.context.name
      );
    }
  }
  return files;
}

async function normalizeService(opts: {
  readonly context: ServiceContext;
  readonly sources: Sources;
  readonly service: NativeComposeEnvironmentService;
  readonly active: boolean;
}): Promise<Record<string, string>> {
  const { document, environment: authored } = opts.service;
  if (Object.hasOwn(document, UNSETS)) {
    throw refused(
      "environment",
      "the native unset metadata field is reserved",
      opts.context.name
    );
  }
  for (const [field, value] of Object.entries(document)) {
    if (
      field !== "environment" &&
      field !== "env_file" &&
      !ignoredExtension(field)
    ) {
      checkPublicFields({
        value,
        lookup: opts.context.lookup,
        service: opts.context.name,
        field,
      });
    }
  }
  const resolution = resolveService({
    context: opts.context,
    environment: authored,
  });
  const specs = fileSpecs(document.env_file, opts.context.name);
  const files = opts.active
    ? await serviceFiles({ ...opts, specs, resolution })
    : new Map<string, string>();
  const environment: Record<string, unknown> = Object.assign(
    Object.create(null),
    resolution.environment
  );
  const fileBindings = new Set<string>();
  for (const [key, value] of files) {
    if (protectedName(key)) {
      throw refused(
        "env_file",
        `protected variable ${key} cannot be delivered`,
        opts.context.name
      );
    }
    if (Object.hasOwn(authored, key)) {
      continue;
    }
    environment[key] = null;
    resolution.delivered[key] = value;
    fileBindings.add(key);
  }
  resolveFileBindingDefaults({ environment, resolution, fileBindings });
  resolvePublicFileBindingDefaults({
    document,
    context: opts.context,
    fileBindings,
  });
  if (specs.length > 0 || resolution.changed) {
    document.environment = environment;
  }
  if (resolution.unset.length > 0) {
    // Names are ASCII identifiers: default code-unit order equals Rust BTreeSet order.
    document[UNSETS] = resolution.unset.sort();
  }
  Reflect.deleteProperty(document, "env_file");
  return resolution.delivered;
}

/** Only executable fields consumed by the runtime get a frozen public default. */
function resolvePublicFileBindingDefaults(opts: {
  readonly document: Record<string, unknown>;
  readonly context: ServiceContext;
  readonly fileBindings: ReadonlySet<string>;
}): void {
  if (opts.fileBindings.size === 0) {
    return;
  }
  const managedNames = new Set(Object.keys(opts.context.managed));
  const prepare = (value: unknown, field: string) =>
    checkPublicFields({
      value,
      field,
      service: opts.context.name,
      lookup: opts.context.lookup,
      fileBindings: opts.fileBindings,
      managedNames,
    });
  for (const field of ["command", "entrypoint", "user", "extra_hosts"]) {
    if (Object.hasOwn(opts.document, field)) {
      opts.document[field] = prepare(opts.document[field], field);
    }
  }
  if (
    isRecord(opts.document.healthcheck) &&
    Object.hasOwn(opts.document.healthcheck, "test")
  ) {
    opts.document.healthcheck.test = prepare(
      opts.document.healthcheck.test,
      "healthcheck.test"
    );
  }
}

/**
 * YAML environment interpolation uses the project context, never env-file values.
 * Freeze a public default before a newly private file name becomes runtime-owned.
 * Re-escape dollars because the runtime still evaluates the public declarations.
 */
function resolveFileBindingDefaults(opts: {
  readonly environment: Record<string, unknown>;
  readonly resolution: Resolution;
  readonly fileBindings: ReadonlySet<string>;
}): void {
  for (const [key, references] of opts.resolution.references) {
    const value = opts.resolution.resolved.get(key);
    if (
      value !== undefined &&
      [...references].some((name) => opts.fileBindings.has(name))
    ) {
      opts.environment[key] = value.replaceAll("$", () => "$$");
    }
  }
}

/**
 * Native-only normalization. Public declarations contain names, never file or
 * shell values. Returned maps are private ephemeral inputs, not managed-env
 * fingerprints. Start and preflight call this same preparation path.
 */
export async function normalizeNativeComposeEnvironment(
  opts: Options
): Promise<{
  readonly shellEnvironment: Record<string, Record<string, string>>;
  readonly notices: Notice[];
  readonly forwardedNames: Record<string, readonly string[]>;
  readonly privateValues: readonly string[];
  readonly fileServices: Readonly<Record<string, boolean>>;
}> {
  const sources = await environmentSources(await canonicalSourceOptions(opts));
  const privateValues = new Set<string>();
  for (const [field, value] of Object.entries(opts.compose)) {
    if (field !== "services" && !ignoredExtension(field)) {
      checkPublicFields({ value, lookup: sources.lookup, field });
    }
  }
  const shellEnvironment: Record<
    string,
    Record<string, string>
  > = Object.create(null);
  const notices: Notice[] = [];
  const forwardedNames: Record<string, readonly string[]> = Object.create(null);
  const fileServices: Record<string, boolean> = Object.create(null);
  for (const [name, service] of Object.entries(opts.services)) {
    sources.shellNames.clear();
    const active =
      opts.selectedServices === undefined
        ? nativeServiceActive(service.document, opts.profiles ?? [])
        : opts.selectedServices.includes(name);
    if (Object.hasOwn(service.document, "env_file")) {
      fileServices[name] = active;
    }
    const delivered = await normalizeService({
      sources,
      service,
      active,
      context: {
        name,
        global: opts.global,
        managed: Object.hasOwn(opts.managed, name)
          ? (opts.managed[name] ?? {})
          : {},
        lookup: sources.lookup,
        notices,
      },
    });
    if (Object.keys(delivered).length > 0) {
      shellEnvironment[name] = delivered;
    }
    for (const value of Object.values(delivered)) {
      privateValues.add(value);
    }
    forwardedNames[name] = [...sources.shellNames].sort();
  }
  return {
    shellEnvironment,
    notices,
    forwardedNames,
    privateValues: [...privateValues].filter((value) => value !== ""),
    fileServices,
  };
}
