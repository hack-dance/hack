import { isAbsolute } from "node:path";
import { isRecord } from "../lib/guards.ts";

import { readNativeSelection } from "./native-project-selection.ts";
import {
  invokeNativeRuntime,
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
      throw new Error(
        "Native host dependencies require init: true; explicit service settings were not overridden."
      );
    }
    selected.push(service);
  }
  for (const service of selected) {
    service.init = true;
  }
}

function refused(): Error {
  return new Error(
    "Native host dependencies require a bounded explicit listener selection; values omitted."
  );
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
      ...(entry.host_executable === undefined
        ? {}
        : { host_executable: entry.host_executable }),
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
    const value = await readNativeSelection(opts.path);
    if (!(isRecord(value) && Array.isArray(value.dependencies))) {
      throw refused();
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
    for (const entry of value.dependencies) {
      if (!isRecord(entry) || entry.host_executable === undefined) {
        dependencies.push(entry);
        continue;
      }
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
          !Number.isSafeInteger(discovered.host_pid) ||
          discovered.host_pid <= 1 ||
          discovered.host_pid > 2_147_483_647 ||
          !FINGERPRINT.test(discovered.endpoint_fingerprint)
        ) {
          throw refused();
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
  } catch {
    throw refused();
  }
}

/** The native backend binds the discovered PID to an exact process/listener generation. */
export async function discoverNativeHostDependency(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly hostPort: number;
  readonly executable: string;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<{
  readonly host_pid: number;
  readonly endpoint_fingerprint: string;
}> {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
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
}
