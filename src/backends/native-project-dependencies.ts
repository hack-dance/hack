import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  isNativeDependencyOwnerRefusal,
  type NativeDependencyOwner,
  type NativeDependencyOwnerResolver,
  nativeDependencyOwnerMismatch,
} from "./native-dependency-owners.ts";
import {
  NativeSelectionSyntaxError,
  readNativeSelection,
} from "./native-project-selection.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BINDING = /^[a-z0-9._-]{1,128}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_HOST = /^[0-9.]+$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const FIELDS = new Set([
  "service",
  "binding",
  "guest_port",
  "aliases",
  "host_pid",
  "host_port",
  "host_executable",
  "host_supervisor_depth",
  "host_ancestor_pid",
  "host_ancestor_start_micros",
  "host_lifecycle",
  "host_shared_helper",
]);
/** Resolved authority; a selection file names an owner instead of these. */
const RESOLVED_OWNER_FIELDS = [
  "host_ancestor_pid",
  "host_ancestor_start_micros",
] as const;
const OWNER_AUTHORITY_FIELDS = [
  "host_pid",
  "host_executable",
  "host_supervisor_depth",
  ...RESOLVED_OWNER_FIELDS,
] as const;

/** Most bindings one selection may grant, counted after version 2 expansion. */
const LIMIT = 128;

export type NativeHostDependency = {
  readonly service: string;
  readonly binding: string;
  readonly slot: number;
  readonly guest_port: number;
  readonly aliases: readonly string[];
  readonly host_pid: number;
  readonly host_port: number;
  readonly host_executable?: string;
  readonly host_supervisor_depth?: number;
  /** Owner-scoped selections: the exact owner process native review must pin. */
  readonly host_ancestor_pid?: number;
  readonly host_ancestor_start_micros?: number;
};

/** The guest relay launcher requires a reaping init process; honor an explicit refusal. */
export function prepareNativeDependencyServices(opts: {
  readonly dependencies: readonly NativeHostDependency[];
  readonly services: Record<string, Record<string, unknown>>;
}): void {
  const selected: Record<string, unknown>[] = [];
  for (const dependency of opts.dependencies) {
    const service = opts.services[dependency.service];
    if (!service || (service.init !== undefined && service.init !== true)) {
      throw new HackCliError({
        code: "E_NATIVE_PROJECT_UNSUPPORTED",
        message:
          "Native host dependencies require init: true; explicit service settings were not overridden.",
      });
    }
    selected.push(service);
  }
  for (const service of selected) {
    service.init = true;
  }
}

const SAFE_FIELD = /^[A-Za-z0-9_]{1,64}$/;
const SAFE_NATIVE_CODE = /^[a-z0-9_]{1,80}$/;

const OWN_REFUSALS = new WeakSet<Error>();
/**
 * The private listener selection (or its discovery) did not validate. The
 * message names the problem and the public parts of the affected binding
 * (service, binding, aliases and ports) only after they validate; host PIDs,
 * executables and unrecognized field contents are never echoed.
 */
function refused(reason: string, context?: string): Error {
  const error = new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `Native host dependencies refused${context ? ` for ${context}` : ""}: ${reason}; listener values omitted.`,
  });
  OWN_REFUSALS.add(error);
  return error;
}
/** Discovery refusals keep their reason so a caller can add the binding context. */
const DISCOVERY_REASONS = new WeakMap<Error, string>();
function refusedDiscovery(reason: string): Error {
  const error = refused(reason);
  DISCOVERY_REASONS.set(error, reason);
  return error;
}
function discoveryReason(error: unknown): string | undefined {
  if (error instanceof Error && DISCOVERY_REASONS.has(error)) {
    return DISCOVERY_REASONS.get(error);
  }
  if (error instanceof NativeRuntimeRequestError) {
    return error.nativeCode && SAFE_NATIVE_CODE.test(error.nativeCode)
      ? `listener discovery failed (${error.nativeCode})`
      : "listener discovery request failed";
  }
  return undefined;
}
const FILE_REASON =
  "HACK_NATIVE_DEPENDENCIES must name an absolute path to a bounded, unchanged regular JSON file";
const MISSING_LISTENER_REASON =
  "no listener owned by host_executable answered on host_port before the discovery deadline";
const SHAPE_REASON =
  "the selection must be {version: 1, dependencies: [1..128 entries]} with no other fields";
const INVALID_DISCOVERY_REASON = "listener discovery returned an invalid reply";
const OWNER_SELECTOR_REASON =
  "host_lifecycle or host_shared_helper must name exactly one owner (1..128 printable characters, no surrounding spaces) without host_pid, host_executable, host_supervisor_depth or resolved owner fields";
const RESOLVED_OWNER_REASON =
  "host_ancestor_pid and host_ancestor_start_micros are resolved from a named owner and cannot be selected";
const SHARED_OWNER_REASON =
  "bindings on one host_port must name the same host_lifecycle or host_shared_helper owner";

/** Value-free label of one selection entry: only validated public fields. */
function describeEntry(entry: unknown, index: number): string {
  const parts: string[] = [];
  if (isRecord(entry)) {
    if (typeof entry.service === "string" && SERVICE.test(entry.service)) {
      parts.push(`service ${entry.service}`);
    }
    if (typeof entry.binding === "string" && BINDING.test(entry.binding)) {
      parts.push(`binding ${entry.binding}`);
    }
    if (Array.isArray(entry.aliases)) {
      const aliases = entry.aliases.filter(hostname).slice(0, 8);
      if (aliases.length > 0) {
        parts.push(`aliases ${aliases.join(",")}`);
      }
    }
    if (port(entry.guest_port)) {
      parts.push(`guest port ${entry.guest_port}`);
    }
    if (port(entry.host_port)) {
      parts.push(`host port ${entry.host_port}`);
    }
  }
  return `dependency #${index + 1}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

function hostPidProblem(entry: Record<string, unknown>): string | undefined {
  if (
    typeof entry.host_pid === "number" &&
    Number.isSafeInteger(entry.host_pid) &&
    entry.host_pid > 1 &&
    entry.host_pid <= 2_147_483_647
  ) {
    return undefined;
  }
  return entry.host_pid === undefined
    ? "host_pid or host_executable is required"
    : "host_pid must be a process ID greater than 1";
}

function hostExecutableProblem(
  entry: Record<string, unknown>
): string | undefined {
  if (
    entry.host_executable !== undefined &&
    !(
      typeof entry.host_executable === "string" &&
      isAbsolute(entry.host_executable) &&
      entry.host_executable.length <= 1024 &&
      !entry.host_executable.includes("\0")
    )
  ) {
    return "host_executable must be an absolute path of at most 1024 bytes";
  }
  if (!validSupervisorDepth(entry)) {
    return "host_supervisor_depth must be an integer 1..8 and requires host_executable";
  }
  if (!validAncestor(entry)) {
    return "host_ancestor_pid and host_ancestor_start_micros must be set together with host_executable";
  }
  return undefined;
}

/** First structural problem of one entry, in declaration order, or undefined. */
function entryProblem(
  entry: unknown,
  services: readonly string[]
): string | undefined {
  if (!isRecord(entry)) {
    return "each dependency must be an object";
  }
  const unknown = Object.keys(entry).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) {
    return SAFE_FIELD.test(unknown)
      ? `unsupported field ${unknown}`
      : "unsupported field";
  }
  if (typeof entry.service !== "string" || !SERVICE.test(entry.service)) {
    return "service must name a Compose service";
  }
  if (!services.includes(entry.service)) {
    return "service is not declared in the Compose file";
  }
  if (typeof entry.binding !== "string" || !BINDING.test(entry.binding)) {
    return "binding must be 1..128 characters of a-z, 0-9, '.', '_' or '-'";
  }
  if (!port(entry.guest_port)) {
    return "guest_port must be an integer 1..65535";
  }
  if (!port(entry.host_port)) {
    return "host_port must be an integer 1..65535";
  }
  if (ownerSelector(entry) === null) {
    return OWNER_SELECTOR_REASON;
  }
  const host = hostPidProblem(entry) ?? hostExecutableProblem(entry);
  if (host !== undefined) {
    return host;
  }
  if (
    !(
      Array.isArray(entry.aliases) &&
      entry.aliases.length > 0 &&
      entry.aliases.length <= 8 &&
      entry.aliases.every(hostname)
    )
  ) {
    return "aliases must list 1..8 lowercase DNS hostnames that are not localhost or numeric";
  }
  return undefined;
}
function port(value: unknown): value is number {
  return (
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535
  );
}
function hostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value !== "localhost" &&
    !value.endsWith(".localhost") &&
    value !== "localhost.localdomain" &&
    !NUMERIC_HOST.test(value) &&
    value.split(".").every((part) => LABEL.test(part))
  );
}

function validSupervisorDepth(entry: Record<string, unknown>): boolean {
  return (
    entry.host_supervisor_depth === undefined ||
    (entry.host_executable !== undefined &&
      typeof entry.host_supervisor_depth === "number" &&
      Number.isInteger(entry.host_supervisor_depth) &&
      entry.host_supervisor_depth >= 1 &&
      entry.host_supervisor_depth <= 8)
  );
}

function validAncestor(entry: Record<string, unknown>): boolean {
  if (
    entry.host_ancestor_pid === undefined &&
    entry.host_ancestor_start_micros === undefined
  ) {
    return true;
  }
  return (
    entry.host_executable !== undefined &&
    typeof entry.host_ancestor_pid === "number" &&
    Number.isSafeInteger(entry.host_ancestor_pid) &&
    entry.host_ancestor_pid > 1 &&
    entry.host_ancestor_pid <= 2_147_483_647 &&
    typeof entry.host_ancestor_start_micros === "number" &&
    Number.isSafeInteger(entry.host_ancestor_start_micros) &&
    entry.host_ancestor_start_micros > 0
  );
}

function hostAuthority(entry: Record<string, unknown>) {
  return {
    ...(typeof entry.host_executable === "string"
      ? { host_executable: entry.host_executable }
      : {}),
    ...(typeof entry.host_supervisor_depth === "number"
      ? { host_supervisor_depth: entry.host_supervisor_depth }
      : {}),
    ...(typeof entry.host_ancestor_pid === "number" &&
    typeof entry.host_ancestor_start_micros === "number"
      ? {
          host_ancestor_pid: entry.host_ancestor_pid,
          host_ancestor_start_micros: entry.host_ancestor_start_micros,
        }
      : {}),
  };
}

const OWNER_NAME = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,126}[^\s\p{Cc}])?$/u;

/**
 * The owner selector a selection entry names, `undefined` when it names none,
 * or `null` when the entry is invalid: both selectors, an empty or control-
 * character name, or an owner combined with explicit or resolved authority.
 */
function ownerSelector(
  entry: Record<string, unknown>
): NativeDependencyOwner | undefined | null {
  const lifecycle = entry.host_lifecycle;
  const helper = entry.host_shared_helper;
  if (lifecycle === undefined && helper === undefined) {
    return undefined;
  }
  const name = lifecycle ?? helper;
  if (
    (lifecycle !== undefined && helper !== undefined) ||
    typeof name !== "string" ||
    !OWNER_NAME.test(name) ||
    OWNER_AUTHORITY_FIELDS.some((field) => entry[field] !== undefined)
  ) {
    return null;
  }
  return { kind: lifecycle === undefined ? "sharedHelper" : "lifecycle", name };
}

/**
 * Validate a selection file's complete public intent without live authority:
 * owner and executable entries receive a provisional PID that never reaches
 * native review. Resolved owner fields are refused here: only owner
 * resolution and native discovery may supply them. Entries sharing a host
 * port must name the same owner selector.
 */
export function provisionalNativeHostDependencies(opts: {
  readonly value: unknown;
  readonly services: readonly string[];
}): NativeHostDependency[] {
  const value = opts.value;
  if (!(isRecord(value) && Array.isArray(value.dependencies))) {
    throw refused(SHAPE_REASON);
  }
  const owners = new Map<unknown, string>();
  const dependencies = value.dependencies.map((entry: unknown, index) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const owner = ownerSelector(entry);
    if (owner === null) {
      throw refused(OWNER_SELECTOR_REASON, describeEntry(entry, index));
    }
    if (RESOLVED_OWNER_FIELDS.some((field) => entry[field] !== undefined)) {
      throw refused(RESOLVED_OWNER_REASON, describeEntry(entry, index));
    }
    const selected = JSON.stringify(owner ?? null);
    const prior = owners.get(entry.host_port);
    if (prior !== undefined && prior !== selected) {
      throw refused(SHARED_OWNER_REASON, describeEntry(entry, index));
    }
    owners.set(entry.host_port, selected);
    if (owner) {
      const { host_lifecycle, host_shared_helper, ...rest } = entry;
      return { ...rest, host_pid: 2 };
    }
    return entry.host_executable === undefined
      ? entry
      : { ...entry, host_pid: entry.host_pid ?? 2 };
  });
  return parseNativeHostDependencies({
    value: { ...value, dependencies },
    services: opts.services,
  });
}

function requireSameEndpointPolicy(opts: {
  readonly policies: Map<string, string>;
  readonly endpoint: string;
  readonly authority: ReturnType<typeof hostAuthority>;
  readonly context: string;
}): void {
  const policy = JSON.stringify(
    opts.authority.host_executable === undefined
      ? null
      : [
          opts.authority.host_executable,
          opts.authority.host_supervisor_depth ?? 1,
          opts.authority.host_ancestor_pid ?? null,
          opts.authority.host_ancestor_start_micros ?? null,
        ]
  );
  const prior = opts.policies.get(opts.endpoint);
  if (prior !== undefined && prior !== policy) {
    throw refused(
      "the same host listener is selected with different host_executable policies",
      opts.context
    );
  }
  opts.policies.set(opts.endpoint, policy);
}

const DECLARATIVE_FIELDS = new Set([
  "binding",
  "service",
  "services",
  "guest_port",
  "aliases",
  "host_pid",
  "host_port",
  "host_executable",
  "host_supervisor_depth",
]);

/**
 * The services a version 2 entry selects: `service` is shorthand for a
 * one-element `services` list, and naming neither selects every profile-active
 * service. Listed services must be distinct and profile-active.
 */
function declaredServices(opts: {
  readonly entry: Record<string, unknown>;
  readonly hostAliases: Readonly<Record<string, readonly string[]>>;
}): readonly string[] {
  const { service, services } = opts.entry;
  if (service !== undefined && services !== undefined) {
    throw refused(
      "a version 2 entry sets at most one of service and services",
      `binding ${opts.entry.binding}`
    );
  }
  if (service !== undefined) {
    if (
      !(typeof service === "string" && Object.hasOwn(opts.hostAliases, service))
    ) {
      throw refused(
        "service must name a profile-active service",
        `binding ${opts.entry.binding}`
      );
    }
    return [service];
  }
  if (services === undefined) {
    return Object.keys(opts.hostAliases);
  }
  if (
    !(
      Array.isArray(services) &&
      services.length > 0 &&
      services.length <= LIMIT &&
      new Set(services).size === services.length &&
      services.every(
        (selected) =>
          typeof selected === "string" &&
          Object.hasOwn(opts.hostAliases, selected)
      )
    )
  ) {
    throw refused(
      "services must list 1..128 distinct profile-active services",
      `binding ${opts.entry.binding}`
    );
  }
  return services as string[];
}

type DeclarativeEntry = Record<string, unknown> & {
  readonly binding: string;
  readonly aliases: string[];
};
function declarativeEntry(entry: unknown): entry is DeclarativeEntry {
  return (
    isRecord(entry) &&
    Object.keys(entry).every((key) => DECLARATIVE_FIELDS.has(key)) &&
    typeof entry.binding === "string" &&
    Array.isArray(entry.aliases) &&
    entry.aliases.length > 0 &&
    entry.aliases.length <= 8 &&
    entry.aliases.every((alias) => typeof alias === "string") &&
    new Set(entry.aliases).size === entry.aliases.length
  );
}
function expandDeclarativeEntry(opts: {
  readonly entry: DeclarativeEntry;
  readonly hostAliases: Readonly<Record<string, readonly string[]>>;
}): Record<string, unknown>[] {
  const { service: _service, services: _services, ...authority } = opts.entry;
  const listed =
    opts.entry.service !== undefined || opts.entry.services !== undefined;
  const used = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const service of declaredServices(opts)) {
    const declared = new Set(opts.hostAliases[service]);
    const aliases = opts.entry.aliases.filter((alias) => declared.has(alias));
    if (aliases.length === 0) {
      if (listed) {
        throw refused(
          "a listed service declares none of the binding's aliases as a host-gateway extra host",
          `binding ${opts.entry.binding}`
        );
      }
      continue;
    }
    for (const alias of aliases) {
      used.add(alias);
    }
    result.push({ ...authority, service, aliases });
  }
  if (used.size !== opts.entry.aliases.length) {
    throw refused(
      "an alias is not declared as a host-gateway extra host by any selected service",
      `binding ${opts.entry.binding}`
    );
  }
  return result;
}

/**
 * Expand a version 2 selection into version 1 bindings.
 *
 * A version 2 entry names one binding once. It applies to the listed
 * `services` (in list order), to one `service` (shorthand for a one-element
 * list), or, when neither is set, to every profile-active service that
 * declares one of its aliases as a host-gateway extra host (including
 * project-wide internal aliases). An entry sets at most one of `service` and
 * `services`. Each expanded binding carries the same ports and listener
 * authority and only the aliases that service declares; native review accepts
 * no other aliases, so when every selected service declares every alias the
 * result equals repeating the entry per service in version 1. A listed service
 * that declares none of the aliases, an alias no selected service declares, a
 * repeated binding name, or more than 128 expanded bindings refuses. Endpoint
 * sharing and the 32-transport limit are enforced after expansion by
 * {@link parseNativeHostDependencies}. Version 1 values pass through unchanged.
 */
export function compileNativeHostDependencySelection(opts: {
  readonly value: unknown;
  readonly hostAliases?: Readonly<Record<string, readonly string[]>>;
}): unknown {
  const value = opts.value;
  if (!(isRecord(value) && value.version === 2)) {
    return value;
  }
  const hostAliases = opts.hostAliases;
  if (!hostAliases) {
    throw refused(
      "a version 2 selection needs the services' declared host-gateway aliases, which this command does not read"
    );
  }
  if (
    !(
      Object.keys(value).every((key) =>
        ["version", "dependencies"].includes(key)
      ) &&
      Array.isArray(value.dependencies) &&
      value.dependencies.length > 0 &&
      value.dependencies.length <= LIMIT
    )
  ) {
    throw refused(
      "a version 2 selection must be {version: 2, dependencies: [1..128 entries]} with no other fields"
    );
  }
  const bindings = new Set<string>();
  const dependencies: Record<string, unknown>[] = [];
  for (const entry of value.dependencies) {
    if (!declarativeEntry(entry) || bindings.has(entry.binding)) {
      throw refused(
        "each version 2 entry must be a valid declarative binding with a unique binding name"
      );
    }
    bindings.add(entry.binding);
    dependencies.push(...expandDeclarativeEntry({ entry, hostAliases }));
    if (dependencies.length > LIMIT) {
      throw refused(
        "the version 2 selection expands to more than 128 bindings"
      );
    }
  }
  return { version: 1, dependencies };
}

/** Native dependency-plan pins the live process/listener identity after this structural check. */
export function parseNativeHostDependencies(opts: {
  readonly value: unknown;
  readonly services: readonly string[];
}): NativeHostDependency[] {
  const value = opts.value;
  if (
    !(
      isRecord(value) &&
      value.version === 1 &&
      Object.keys(value).every((key) =>
        ["version", "dependencies"].includes(key)
      ) &&
      Array.isArray(value.dependencies) &&
      value.dependencies.length > 0 &&
      value.dependencies.length <= LIMIT
    )
  ) {
    throw refused(SHAPE_REASON);
  }
  const keys = new Set<string>();
  const aliases = new Set<string>();
  const transports = new Map<
    string,
    { slot: number; services: Set<string> }[]
  >();
  const endpointPolicies = new Map<string, string>();
  let nextSlot = 0;
  return value.dependencies.map((candidate: unknown, index) => {
    const context = describeEntry(candidate, index);
    const problem = entryProblem(candidate, opts.services);
    if (problem !== undefined) {
      throw refused(problem, context);
    }
    const entry = candidate as Record<string, unknown> & {
      readonly service: string;
      readonly binding: string;
      readonly guest_port: number;
      readonly host_port: number;
      readonly host_pid: number;
      readonly aliases: string[];
    };
    const key = `${entry.service}:${entry.binding}`;
    if (keys.has(key)) {
      throw refused("the binding is declared twice for this service", context);
    }
    keys.add(key);
    for (const alias of entry.aliases) {
      const selected = `${entry.service}:${alias}`;
      if (aliases.has(selected)) {
        throw refused("an alias is declared twice for this service", context);
      }
      aliases.add(selected);
    }
    // Share only the listening transport across services, never their grants.
    // Native review still pins and compares the complete endpoint generation.
    const endpoint = `${entry.host_pid}:${entry.host_port}`;
    const authority = hostAuthority(entry);
    requireSameEndpointPolicy({
      policies: endpointPolicies,
      endpoint,
      authority,
      context,
    });
    const selectedService = entry.service;
    const available = transports.get(endpoint) ?? [];
    let transport = available.find(
      (item) => !item.services.has(selectedService)
    );
    if (!transport) {
      if (nextSlot >= 32) {
        throw refused(
          "the selection needs more than 32 distinct host listener slots",
          context
        );
      }
      transport = { slot: nextSlot++, services: new Set() };
      available.push(transport);
      transports.set(endpoint, available);
    }
    transport.services.add(entry.service);
    return {
      service: entry.service,
      binding: entry.binding,
      slot: transport.slot,
      guest_port: entry.guest_port,
      host_port: entry.host_port,
      host_pid: entry.host_pid,
      ...authority,
      aliases: entry.aliases,
    };
  });
}

/** Live owner-scoped discovery evidence; native review pins it again. */
export type NativeOwnedDiscovery = {
  readonly host_pid: number;
  readonly endpoint_fingerprint: string;
  readonly executable: string;
  readonly supervisor_depth: number;
  readonly ancestor_pid: number;
  readonly ancestor_start_micros: number;
};

function validPid(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 1 &&
    value <= 2_147_483_647
  );
}

/**
 * Turn one owner's live discovery into explicit authority. A listener deeper
 * than the owner follows replacement beneath exactly that owner process (its
 * PID and native start time are pinned); the owner itself listening is a fixed
 * PID selection with no replacement authority.
 */
function ownedAuthority(opts: {
  readonly found: NativeOwnedDiscovery;
  readonly ownerPid: number;
  readonly context: string;
}): Record<string, unknown> {
  const found = opts.found;
  if (
    !(
      validPid(found.host_pid) &&
      FINGERPRINT.test(found.endpoint_fingerprint) &&
      typeof found.executable === "string" &&
      isAbsolute(found.executable) &&
      found.executable.length <= 1024 &&
      !found.executable.includes("\0") &&
      Number.isInteger(found.supervisor_depth) &&
      found.supervisor_depth >= 0 &&
      found.supervisor_depth <= 8 &&
      found.ancestor_pid === opts.ownerPid &&
      Number.isSafeInteger(found.ancestor_start_micros) &&
      found.ancestor_start_micros > 0 &&
      (found.supervisor_depth === 0) === (found.host_pid === opts.ownerPid)
    )
  ) {
    throw refused(INVALID_DISCOVERY_REASON, opts.context);
  }
  if (found.supervisor_depth === 0) {
    return { host_pid: found.host_pid };
  }
  return {
    host_pid: found.host_pid,
    host_executable: found.executable,
    host_supervisor_depth: found.supervisor_depth,
    host_ancestor_pid: opts.ownerPid,
    host_ancestor_start_micros: found.ancestor_start_micros,
  };
}

type NativeDependencyDiscovery = {
  /** Read-only exact-PID observation before VM boot; execution pins it again. */
  readonly checkPinned?: (selection: {
    readonly hostPid: number;
    readonly hostPort: number;
  }) => Promise<void>;
  readonly discover?: (selection: {
    readonly hostPort: number;
    readonly executable: string;
  }) => Promise<{
    readonly host_pid: number;
    readonly endpoint_fingerprint: string;
  }>;
  /** Resolves `host_lifecycle` / `host_shared_helper` owners; absent refuses them. */
  readonly owners?: NativeDependencyOwnerResolver;
  readonly discoverOwned?: (selection: {
    readonly hostPort: number;
    readonly ancestorPid: number;
  }) => Promise<NativeOwnedDiscovery>;
};

/**
 * Owned discovery failure: a listener outside the owner's tree keeps the
 * closed owner-mismatch text; anything else names a value-free reason.
 */
function ownedDiscoveryRefusal(error: unknown, context: string): Error {
  if (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "host_endpoint_owner"
  ) {
    return nativeDependencyOwnerMismatch();
  }
  const reason = discoveryReason(error);
  return refused(
    reason === MISSING_LISTENER_REASON
      ? "no listener beneath the selected owner answered on host_port before the discovery deadline"
      : (reason ?? "listener discovery failed"),
    context
  );
}

/** One live discovery per owner (or executable) and host port, in entry order. */
function createDependencyResolution(opts: NativeDependencyDiscovery) {
  const resolved = new Map<string, number>();
  const owned = new Map<string, Record<string, unknown>>();
  const ownedEntry = async (
    entry: Record<string, unknown>,
    owner: NativeDependencyOwner,
    context: string
  ) => {
    if (!(opts.owners && opts.discoverOwned)) {
      throw refused(
        "host_lifecycle and host_shared_helper selections need owner resolution, which this command does not perform",
        context
      );
    }
    const hostPort = Number(entry.host_port);
    const key = `${owner.kind}\0${owner.name}\0${hostPort}`;
    let authority = owned.get(key);
    if (authority === undefined) {
      // Owner refusals keep their own closed text.
      const proof = await opts.owners(owner);
      let found: NativeOwnedDiscovery;
      try {
        found = await opts.discoverOwned({
          hostPort,
          ancestorPid: proof.pid,
        });
      } catch (error) {
        throw ownedDiscoveryRefusal(error, context);
      }
      authority = ownedAuthority({ found, ownerPid: proof.pid, context });
      // The owner must still be the same live process after discovery.
      await proof.confirm();
      owned.set(key, authority);
    }
    const {
      host_lifecycle: _lifecycle,
      host_shared_helper: _helper,
      ...rest
    } = entry;
    return { ...rest, ...authority };
  };
  const executableEntry = async (
    entry: Record<string, unknown>,
    context: string
  ) => {
    if (!opts.discover) {
      throw refused(
        "host_executable selection needs listener discovery, which this command does not perform; select host_pid instead",
        context
      );
    }
    const executable = String(entry.host_executable);
    const hostPort = Number(entry.host_port);
    const key = `${executable}\0${hostPort}`;
    let hostPid = resolved.get(key);
    if (hostPid === undefined) {
      let discovered: Awaited<ReturnType<NonNullable<typeof opts.discover>>>;
      try {
        discovered = await opts.discover({ executable, hostPort });
      } catch (error) {
        throw refused(
          discoveryReason(error) ?? "listener discovery failed",
          context
        );
      }
      if (
        !(
          validPid(discovered.host_pid) &&
          FINGERPRINT.test(discovered.endpoint_fingerprint)
        )
      ) {
        throw refused(INVALID_DISCOVERY_REASON, context);
      }
      hostPid = discovered.host_pid;
      resolved.set(key, hostPid);
    }
    return { ...entry, host_pid: hostPid };
  };
  return async (entry: unknown, index: number): Promise<unknown> => {
    if (!isRecord(entry)) {
      return entry;
    }
    const owner = ownerSelector(entry);
    if (owner) {
      return await ownedEntry(entry, owner, describeEntry(entry, index));
    }
    if (entry.host_executable !== undefined) {
      return await executableEntry(entry, describeEntry(entry, index));
    }
    if (opts.checkPinned) {
      try {
        await opts.checkPinned({
          hostPid: Number(entry.host_pid),
          hostPort: Number(entry.host_port),
        });
      } catch (error) {
        throw refused(
          discoveryReason(error) ??
            "the selected host_pid does not own an exclusive loopback listener on host_port",
          describeEntry(entry, index)
        );
      }
    }
    return entry;
  };
}

/** Read after lifecycle hooks so a hook can supply current listener PIDs; never persist authority. */
export async function readNativeHostDependencies(
  opts: NativeDependencyDiscovery & {
    readonly path?: string;
    readonly services: readonly string[];
    /** Host-gateway aliases per profile-active service, for version 2 selections. */
    readonly hostAliases?: Readonly<Record<string, readonly string[]>>;
  }
): Promise<NativeHostDependency[]> {
  if (opts.path === undefined) {
    return [];
  }
  try {
    return await readSelectedHostDependencies({ ...opts, path: opts.path });
  } catch (error) {
    // Own and owner refusals keep their closed, value-free text.
    if (
      error instanceof Error &&
      (OWN_REFUSALS.has(error) || isNativeDependencyOwnerRefusal(error))
    ) {
      throw error;
    }
    if (
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "host_endpoint_owner"
    ) {
      throw nativeDependencyOwnerMismatch();
    }
    throw refused("the selection could not be validated");
  }
}

async function readSelectedHostDependencies(
  opts: Parameters<typeof readNativeHostDependencies>[0] & {
    readonly path: string;
  }
): Promise<NativeHostDependency[]> {
  let selection: unknown;
  try {
    selection = await readNativeSelection(opts.path);
  } catch (error) {
    throw refused(
      error instanceof NativeSelectionSyntaxError ? error.message : FILE_REASON
    );
  }
  const value = compileNativeHostDependencySelection({
    value: selection,
    hostAliases: opts.hostAliases,
  });
  if (!(isRecord(value) && Array.isArray(value.dependencies))) {
    throw refused(SHAPE_REASON);
  }
  // Validate the complete intent before resolving owners or invoking native
  // process discovery.
  provisionalNativeHostDependencies({ value, services: opts.services });
  const resolve = createDependencyResolution(opts);
  const dependencies: unknown[] = [];
  for (const [index, entry] of value.dependencies.entries()) {
    dependencies.push(await resolve(entry, index));
  }
  return parseNativeHostDependencies({
    value: { ...value, dependencies },
    services: opts.services,
  });
}

type NativeDependencyWait = {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
};

function remainingDiscoveryTime(
  wait?: NativeDependencyWait
): number | undefined {
  if (!wait) {
    return undefined;
  }
  const remaining = wait.deadlineMs - performance.now();
  if (wait.signal.aborted) {
    throw refusedDiscovery("listener discovery was cancelled");
  }
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw refusedDiscovery(MISSING_LISTENER_REASON);
  }
  return remaining;
}

async function waitForNextDiscovery(opts: {
  readonly wait?: NativeDependencyWait;
  readonly error: unknown;
}): Promise<boolean> {
  if (
    !opts.wait ||
    opts.wait.signal.aborted ||
    !(opts.error instanceof NativeRuntimeRequestError) ||
    opts.error.nativeCode !== "host_endpoint_identity"
  ) {
    return false;
  }
  const remaining = remainingDiscoveryTime(opts.wait);
  try {
    await delay(Math.min(500, remaining ?? 0), undefined, {
      signal: opts.wait.signal,
    });
  } catch {
    throw refusedDiscovery("listener discovery was cancelled");
  }
  return true;
}

/**
 * Discover a pinned listener, optionally waiting for a persistent startup hook.
 * Only read-only endpoint identity refusals retry; all bindings share the caller's
 * deadline. A successful discovery still needs dependency-plan/admission review.
 */
export async function discoverNativeHostDependency(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly hostPort: number;
  readonly executable: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly wait?: NativeDependencyWait;
}): Promise<{
  readonly host_pid: number;
  readonly endpoint_fingerprint: string;
}> {
  while (true) {
    const remaining = remainingDiscoveryTime(opts.wait);
    try {
      const result = await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        ...(remaining === undefined
          ? {}
          : { timeoutMs: Math.max(1, Math.min(2000, Math.ceil(remaining))) }),
        args: [
          "graph",
          "dependency-discover",
          "--host-port",
          String(opts.hostPort),
          "--executable",
          opts.executable,
          "--json",
        ],
      });
      remainingDiscoveryTime(opts.wait);
      if (
        !isRecord(result) ||
        typeof result.host_pid !== "number" ||
        typeof result.endpoint_fingerprint !== "string"
      ) {
        throw refusedDiscovery(INVALID_DISCOVERY_REASON);
      }
      return {
        host_pid: result.host_pid,
        endpoint_fingerprint: result.endpoint_fingerprint,
      };
    } catch (error) {
      if (!(await waitForNextDiscovery({ wait: opts.wait, error }))) {
        throw error;
      }
    }
  }
}

/**
 * Discover the listener on `hostPort` beneath a resolved owner process. Like
 * executable discovery it waits only on endpoint-identity refusals (the owner
 * may still be starting its listener); a listener outside the owner's tree
 * refuses immediately. The caller re-proves ownership after this returns.
 */
export async function discoverNativeOwnedHostDependency(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly hostPort: number;
  readonly ancestorPid: number;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly wait?: NativeDependencyWait;
}): Promise<NativeOwnedDiscovery> {
  while (true) {
    const remaining = remainingDiscoveryTime(opts.wait);
    try {
      const result = await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        ...(remaining === undefined
          ? {}
          : { timeoutMs: Math.max(1, Math.min(2000, Math.ceil(remaining))) }),
        args: [
          "graph",
          "dependency-discover",
          "--host-port",
          String(opts.hostPort),
          "--ancestor-pid",
          String(opts.ancestorPid),
          "--json",
        ],
      });
      remainingDiscoveryTime(opts.wait);
      if (
        !isRecord(result) ||
        typeof result.host_pid !== "number" ||
        typeof result.endpoint_fingerprint !== "string" ||
        typeof result.executable !== "string" ||
        typeof result.supervisor_depth !== "number" ||
        typeof result.ancestor_pid !== "number" ||
        typeof result.ancestor_start_micros !== "number"
      ) {
        throw refusedDiscovery(INVALID_DISCOVERY_REASON);
      }
      return {
        host_pid: result.host_pid,
        endpoint_fingerprint: result.endpoint_fingerprint,
        executable: result.executable,
        supervisor_depth: result.supervisor_depth,
        ancestor_pid: result.ancestor_pid,
        ancestor_start_micros: result.ancestor_start_micros,
      };
    } catch (error) {
      if (!(await waitForNextDiscovery({ wait: opts.wait, error }))) {
        throw error;
      }
    }
  }
}
