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
import { readNativeSelection } from "./native-project-selection.ts";
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

/** The private listener selection (or its discovery) did not validate. */
function refused(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native host dependencies require a bounded explicit listener selection; values omitted.",
  });
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
    throw refused();
  }
  const owners = new Map<unknown, string>();
  const dependencies = value.dependencies.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const owner = ownerSelector(entry);
    if (
      owner === null ||
      RESOLVED_OWNER_FIELDS.some((field) => entry[field] !== undefined)
    ) {
      throw refused();
    }
    const selected = JSON.stringify(owner ?? null);
    const prior = owners.get(entry.host_port);
    if (prior !== undefined && prior !== selected) {
      throw refused();
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
    throw refused();
  }
  opts.policies.set(opts.endpoint, policy);
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
      value.dependencies.length <= 128
    )
  ) {
    throw refused();
  }
  const keys = new Set<string>();
  const aliases = new Set<string>();
  const transports = new Map<
    string,
    { slot: number; services: Set<string> }[]
  >();
  const endpointPolicies = new Map<string, string>();
  let nextSlot = 0;
  return value.dependencies.map((entry) => {
    if (
      !(
        isRecord(entry) &&
        Object.keys(entry).every((key) => FIELDS.has(key)) &&
        typeof entry.service === "string" &&
        SERVICE.test(entry.service) &&
        opts.services.includes(entry.service) &&
        typeof entry.binding === "string" &&
        BINDING.test(entry.binding) &&
        port(entry.guest_port) &&
        port(entry.host_port) &&
        typeof entry.host_pid === "number" &&
        Number.isSafeInteger(entry.host_pid) &&
        entry.host_pid > 1 &&
        entry.host_pid <= 2_147_483_647 &&
        (entry.host_executable === undefined ||
          (typeof entry.host_executable === "string" &&
            isAbsolute(entry.host_executable) &&
            entry.host_executable.length <= 1024 &&
            !entry.host_executable.includes("\0"))) &&
        validSupervisorDepth(entry) &&
        validAncestor(entry) &&
        ownerSelector(entry) !== null &&
        Array.isArray(entry.aliases) &&
        entry.aliases.length > 0 &&
        entry.aliases.length <= 8 &&
        entry.aliases.every(hostname)
      )
    ) {
      throw refused();
    }
    const key = `${entry.service}:${entry.binding}`;
    if (keys.has(key)) {
      throw refused();
    }
    keys.add(key);
    for (const alias of entry.aliases) {
      const selected = `${entry.service}:${alias}`;
      if (aliases.has(selected)) {
        throw refused();
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
    });
    const selectedService = entry.service;
    const available = transports.get(endpoint) ?? [];
    let transport = available.find(
      (item) => !item.services.has(selectedService)
    );
    if (!transport) {
      if (nextSlot >= 32) {
        throw refused();
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
    throw refused();
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

/** One live discovery per owner (or executable) and host port, in entry order. */
function createDependencyResolution(opts: NativeDependencyDiscovery) {
  const resolved = new Map<string, number>();
  const owned = new Map<string, Record<string, unknown>>();
  const ownedEntry = async (
    entry: Record<string, unknown>,
    owner: NativeDependencyOwner
  ) => {
    if (!(opts.owners && opts.discoverOwned)) {
      throw refused();
    }
    const hostPort = Number(entry.host_port);
    const key = `${owner.kind}\0${owner.name}\0${hostPort}`;
    let authority = owned.get(key);
    if (authority === undefined) {
      const proof = await opts.owners(owner);
      const found = await opts.discoverOwned({
        hostPort,
        ancestorPid: proof.pid,
      });
      authority = ownedAuthority({ found, ownerPid: proof.pid });
      // The owner must still be the same live process after discovery.
      await proof.confirm();
      owned.set(key, authority);
    }
    const { host_lifecycle, host_shared_helper, ...rest } = entry;
    return { ...rest, ...authority };
  };
  const executableEntry = async (entry: Record<string, unknown>) => {
    if (!opts.discover) {
      throw refused();
    }
    const executable = String(entry.host_executable);
    const hostPort = Number(entry.host_port);
    const key = `${executable}\0${hostPort}`;
    let hostPid = resolved.get(key);
    if (hostPid === undefined) {
      const discovered = await opts.discover({ executable, hostPort });
      if (
        !(
          validPid(discovered.host_pid) &&
          FINGERPRINT.test(discovered.endpoint_fingerprint)
        )
      ) {
        throw refused();
      }
      hostPid = discovered.host_pid;
      resolved.set(key, hostPid);
    }
    return { ...entry, host_pid: hostPid };
  };
  return async (entry: unknown): Promise<unknown> => {
    if (!isRecord(entry)) {
      return entry;
    }
    const owner = ownerSelector(entry);
    if (owner) {
      return await ownedEntry(entry, owner);
    }
    return entry.host_executable === undefined
      ? entry
      : await executableEntry(entry);
  };
}

/** Closed refusal for discovery failures; owner refusals keep their own text. */
function dependencyRefusal(error: unknown): Error {
  if (isNativeDependencyOwnerRefusal(error) && error instanceof Error) {
    return error;
  }
  if (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "host_endpoint_owner"
  ) {
    return nativeDependencyOwnerMismatch();
  }
  return refused();
}

/** Read after lifecycle hooks so a hook can supply current listener PIDs; never persist authority. */
export async function readNativeHostDependencies(
  opts: NativeDependencyDiscovery & {
    readonly path?: string;
    readonly services: readonly string[];
  }
): Promise<NativeHostDependency[]> {
  if (opts.path === undefined) {
    return [];
  }
  try {
    const value = await readNativeSelection(opts.path);
    // Validate the complete intent before invoking native process discovery.
    provisionalNativeHostDependencies({ value, services: opts.services });
    if (!(isRecord(value) && Array.isArray(value.dependencies))) {
      throw refused();
    }
    const resolve = createDependencyResolution(opts);
    const dependencies: unknown[] = [];
    for (const entry of value.dependencies) {
      dependencies.push(await resolve(entry));
    }
    return parseNativeHostDependencies({
      value: { ...value, dependencies },
      services: opts.services,
    });
  } catch (error) {
    throw dependencyRefusal(error);
  }
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
  if (wait.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) {
    throw refused();
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
    throw refused();
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
        throw refused();
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
        throw refused();
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
