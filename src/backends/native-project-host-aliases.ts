import { isRecord } from "../lib/guards.ts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function refused(): Error {
  return new Error(
    "Native host alias selection conflicts with declared configuration; values omitted."
  );
}
function existingAliases(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (isRecord(value)) {
    entries = Object.entries(value).map(
      ([name, target]) => `${name}:${target}`
    );
  } else {
    throw refused();
  }
  const result: string[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw refused();
    }
    const colon = entry.lastIndexOf(":");
    const name = entry.slice(0, colon);
    if (
      colon < 1 ||
      entry.slice(colon + 1) !== "host-gateway" ||
      names.has(name)
    ) {
      throw refused();
    }
    names.add(name);
    result.push(entry);
  }
  return result;
}
/** Declare selected aliases only; actual access still requires separately authenticated listener grants. */
export function addNativeHostAliases(opts: {
  readonly services: Record<string, unknown>;
  readonly selection: unknown;
}): void {
  if (opts.selection === undefined) {
    return;
  }
  if (!isRecord(opts.selection) || Object.keys(opts.selection).length > 32) {
    throw refused();
  }
  for (const [name, aliases] of Object.entries(opts.selection)) {
    const service = Object.hasOwn(opts.services, name)
      ? opts.services[name]
      : undefined;
    if (
      !(isRecord(service) && Array.isArray(aliases)) ||
      aliases.length === 0 ||
      aliases.length > 32 ||
      new Set(aliases).size !== aliases.length ||
      !aliases.every(
        (alias) =>
          typeof alias === "string" &&
          alias.length <= 253 &&
          alias.includes(".") &&
          alias.split(".").every((label: string) => LABEL.test(label))
      )
    ) {
      throw refused();
    }
    const entries = existingAliases(service.extra_hosts);
    const existing = new Set(
      entries.map((entry) => entry.slice(0, entry.lastIndexOf(":")))
    );
    for (const alias of aliases) {
      if (!existing.has(alias)) {
        entries.push(`${alias}:host-gateway`);
      }
    }
    if (entries.length > 32) {
      throw refused();
    }
    service.extra_hosts = entries;
  }
}
