import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

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
]);

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

function hostAuthority(entry: Record<string, unknown>) {
  return {
    ...(typeof entry.host_executable === "string"
      ? { host_executable: entry.host_executable }
      : {}),
    ...(typeof entry.host_supervisor_depth === "number"
      ? { host_supervisor_depth: entry.host_supervisor_depth }
      : {}),
  };
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

/** Read after lifecycle hooks so a hook can supply current listener PIDs; never persist authority. */
export async function readNativeHostDependencies(opts: {
  readonly path?: string;
  readonly services: readonly string[];
  readonly discover?: (selection: {
    readonly hostPort: number;
    readonly executable: string;
  }) => Promise<{
    readonly host_pid: number;
    readonly endpoint_fingerprint: string;
  }>;
}): Promise<NativeHostDependency[]> {
  if (opts.path === undefined) {
    return [];
  }
  try {
    return await readSelectedHostDependencies({ ...opts, path: opts.path });
  } catch (error) {
    if (error instanceof Error && OWN_REFUSALS.has(error)) {
      throw error;
    }
    throw refused("the selection could not be validated");
  }
}

async function readSelectedHostDependencies(opts: {
  readonly path: string;
  readonly services: readonly string[];
  readonly discover?: Parameters<
    typeof readNativeHostDependencies
  >[0]["discover"];
}): Promise<NativeHostDependency[]> {
  let value: unknown;
  try {
    value = await readNativeSelection(opts.path);
  } catch {
    throw refused(FILE_REASON);
  }
  if (!(isRecord(value) && Array.isArray(value.dependencies))) {
    throw refused(SHAPE_REASON);
  }
  // Validate the complete intent before invoking native process discovery.
  const provisional = {
    ...value,
    dependencies: value.dependencies.map((entry) =>
      isRecord(entry) && entry.host_executable !== undefined
        ? { ...entry, host_pid: entry.host_pid ?? 2 }
        : entry
    ),
  };
  parseNativeHostDependencies({
    value: provisional,
    services: opts.services,
  });
  const resolved = new Map<string, number>();
  const dependencies: unknown[] = [];
  for (const [index, entry] of value.dependencies.entries()) {
    if (!isRecord(entry) || entry.host_executable === undefined) {
      dependencies.push(entry);
      continue;
    }
    const context = describeEntry(entry, index);
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
        !Number.isSafeInteger(discovered.host_pid) ||
        discovered.host_pid <= 1 ||
        discovered.host_pid > 2_147_483_647 ||
        !FINGERPRINT.test(discovered.endpoint_fingerprint)
      ) {
        throw refused("listener discovery returned an invalid reply", context);
      }
      hostPid = discovered.host_pid;
      resolved.set(key, hostPid);
    }
    dependencies.push({ ...entry, host_pid: hostPid });
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
        throw refusedDiscovery("listener discovery returned an invalid reply");
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
