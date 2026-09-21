import { isRecord } from "../lib/guards.ts";

import { readNativeSelection } from "./native-project-selection.ts";

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BINDING = /^[a-z0-9._-]{1,128}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_HOST = /^[0-9.]+$/;
const FIELDS = new Set([
  "service",
  "binding",
  "guest_port",
  "aliases",
  "host_pid",
  "host_port",
]);

export type NativeHostDependency = {
  readonly service: string;
  readonly binding: string;
  readonly slot: number;
  readonly guest_port: number;
  readonly aliases: readonly string[];
  readonly host_pid: number;
  readonly host_port: number;
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
      value.dependencies.length <= 32
    )
  ) {
    throw refused();
  }
  const keys = new Set<string>();
  const aliases = new Set<string>();
  return value.dependencies.map((entry, slot) => {
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
    return {
      service: entry.service,
      binding: entry.binding,
      slot,
      guest_port: entry.guest_port,
      host_port: entry.host_port,
      host_pid: entry.host_pid,
      aliases: entry.aliases,
    };
  });
}

/** Read after lifecycle hooks so a hook can supply current listener PIDs; never persist authority. */
export async function readNativeHostDependencies(opts: {
  readonly path?: string;
  readonly services: readonly string[];
}): Promise<NativeHostDependency[]> {
  if (opts.path === undefined) {
    return [];
  }
  try {
    return parseNativeHostDependencies({
      value: await readNativeSelection(opts.path),
      services: opts.services,
    });
  } catch {
    throw refused();
  }
}
